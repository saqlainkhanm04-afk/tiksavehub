/**
 * TikTok platform sources — fed into runWithFallback.
 *
 * Sources (in order):
 *  1. TikWM — third-party API (POST form-encoded, most reliable)
 *  2. TikTokDownbloder — Vercel-hosted free API (no auth, ~15s timeout)
 *  3. TikTok Direct — fetch TikTok's own page, parse embedded JSON hydration data
 *
 * Every source rotates User-Agent + Sec-CH-UA headers per request so TikTok
 * cannot fingerprint and block our server IP based on a static UA string.
 */
import type { ApiSource } from '../api-fallback';
import type { MediaMeta } from './types';
import { thirdPartyApiHeaders, tiktokApiHeaders } from './headers';
import { tiktokDirectSource } from './tiktok-direct';

// Re-export individual sources for direct import
export { tiktokDirectSource } from './tiktok-direct';

const TIKWM_HOSTS = ['https://tikwm.com/api/', 'https://www.tikwm.com/api/'];

/* ------------------------------------------------------------------ */
/*  CDN Health Monitor                                                 */
/* ------------------------------------------------------------------ */
const CDN_HISTORY_SIZE = 10;
const CDN_FAIL_THRESHOLD = 3;
const CDN_COOLDOWN_REQUESTS = 10;

interface CdnHealthEntry { ok: boolean; ts: number; }
const cdnHealthHistory: CdnHealthEntry[] = [];
let cdnCooldownUntil = 0;

function recordCdnResult(ok: boolean): void {
  cdnHealthHistory.push({ ok, ts: Date.now() });
  if (cdnHealthHistory.length > CDN_HISTORY_SIZE) cdnHealthHistory.shift();
  const recentFails = cdnHealthHistory.filter((e) => !e.ok).length;
  if (recentFails >= CDN_FAIL_THRESHOLD && cdnCooldownUntil === 0) {
    cdnCooldownUntil = Date.now() + CDN_COOLDOWN_REQUESTS * 2_000;
    console.log(`[CDN-Health] ✗ ${recentFails}/${CDN_HISTORY_SIZE} recent failures — prioritizing fallbacks for ${CDN_COOLDOWN_REQUESTS} requests`);
  }
}

function cdnIsHealthy(): boolean {
  if (cdnCooldownUntil === 0) return true;
  if (Date.now() > cdnCooldownUntil) {
    cdnCooldownUntil = 0;
    cdnHealthHistory.length = 0;
    console.log(`[CDN-Health] ✓ Cooldown expired — CDN re-enabled`);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Short link + video ID helpers                                      */
/* ------------------------------------------------------------------ */

function extractVideoIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const patterns = [/\/video\/(\d{6,})/, /\/photo\/(\d{6,})/, /\/v\/(\d{6,})/, /\/embed\/v2\/(\d{6,})/];
    for (const p of patterns) {
      const m = pathname.match(p);
      if (m) return m[1];
    }
    const trailing = pathname.match(/(\d{15,})\/?$/);
    return trailing ? trailing[1] : null;
  } catch {
    return null;
  }
}

async function resolveShortLinkForExtract(url: string): Promise<string> {
  try {
    const parsed = new URL(url);
    const isShort =
      parsed.hostname === 'vm.tiktok.com' || parsed.hostname === 'vt.tiktok.com' ||
      parsed.hostname.endsWith('.vm.tiktok.com') || parsed.hostname.endsWith('.vt.tiktok.com');
    if (!isShort) return url;

    const resp = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(4_000),
    });
    const finalUrl = resp.url.split('#')[0].split('?')[0];
    const id = extractVideoIdFromUrl(finalUrl);
    if (id) return finalUrl;
  } catch {}
  return url;
}

/* ------------------------------------------------------------------ */
/*  Source 1 — TikWM (POST form-encoded)                              */
/* ------------------------------------------------------------------ */
export const tikwmSource: ApiSource<string, MediaMeta> = {
  name: 'TikWM',
  timeoutMs: 8_000,
  retries: 0,
  noRetryStatuses: [404, 422],
  noRetryErrors: ['free api limit', 'rate limit', 'quota exceeded', 'limit exceeded'],
  async fetch(resolvedUrl: string) {
    console.log(`[TikWM] ▶ Starting fetch for: ${resolvedUrl}`);
    const errors: string[] = [];
    for (const host of TIKWM_HOSTS) {
      try {
        const headers = thirdPartyApiHeaders('https://tikwm.com/');
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        const body = `url=${encodeURIComponent(resolvedUrl)}&hd=1`;
        console.log(`[TikWM] → POST ${host}`);
        const resp = await fetch(host, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(7_000),
        });
        const bodyText = await resp.text().catch(() => '<unreadable>');
        console.log(`[TikWM] ← ${host} status=${resp.status} body(2000)=${bodyText.substring(0, 2000)}`);
        if (!resp.ok) { errors.push(`${host}→${resp.status}`); continue; }
        const data: any = JSON.parse(bodyText);
        if (data.code !== 0 || !data.data) {
          console.log(`[TikWM] ✗ Bad payload: code=${data.code} msg=${data.msg} hasData=${!!data.data}`);
          errors.push(`${host}→${data.msg || 'bad payload'}`); continue;
        }
        console.log(`[TikWM] ✓ Success from ${host} — title="${data.data.title?.substring(0, 60)}" play=${!!data.data.play} hdplay=${!!data.data.hdplay}`);

        return data;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.log(`[TikWM] ✗ Exception from ${host}: ${msg}`);
        errors.push(`${host}→${msg}`);
      }
    }
    throw new Error(`TikWM failed: ${errors.join('; ')}`);
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    const d = raw?.data;
    if (!d) return null;
    const author = d.author ?? {};
    const musicSource = d.music_info ?? d.music;
    return {
      platform: 'tiktok',
      type: 'video',
      hdUrl: d.hdplay ?? d.play ?? null,
      sdUrl: d.play ?? d.hdplay ?? null,
      wmUrl: d.wmplay ?? null,
      audioUrl: musicSource?.play ?? musicSource?.play_url ?? null,
      cover: d.cover ?? null,
      title: d.title ?? '',
      duration: d.duration ?? 0,
      authorName: author.nickname ?? '',
      authorAvatar: author.avatar ?? null,
      authorUsername: author.unique_id ?? null,
      stats: {
        likes: d.digg_count ?? null,
        comments: d.comment_count ?? null,
        shares: d.share_count ?? null,
        views: d.play_count ?? null,
      },
      sourceUrl: inputUrl,
      resolvedBy: 'TikWM',
      resolvedMs: 0,
    };
  },
};

/* ------------------------------------------------------------------ */
/*  Source 2 — tiktok-downbloder (Vercel-hosted, free, no auth)        */
/* ------------------------------------------------------------------ */
export const tiktokDownbloderSource: ApiSource<string, MediaMeta> = {
  name: 'TikTokDownbloder',
  timeoutMs: 12_000,
  retries: 0,
  noRetryStatuses: [404, 422],
  async fetch(resolvedUrl: string) {
    const fetchUrl = `https://tiktok-downbloder.vercel.app/?url=${encodeURIComponent(resolvedUrl)}`;
    console.log(`[TikTokDownbloder] ▶ Trying: ${fetchUrl}`);
    const resp = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    const bodyText = await resp.text().catch(() => '<unreadable>');
    console.log(`[TikTokDownbloder] ← status=${resp.status} body(2000)=${bodyText.substring(0, 2000)}`);
    if (!resp.ok) throw new Error(`TikTokDownbloder returned ${resp.status}`);
    const data: any = JSON.parse(bodyText);
    if (!data?.success || !data?.result?.raw?.result?.video) {
      throw new Error('TikTokDownbloder: no video URL');
    }
    return data;
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    const result = raw?.result?.raw?.result;
    if (!result?.video) return null;
    const author = result.author ?? {};
    const stats = result.statistics ?? {};
    return {
      platform: 'tiktok',
      type: 'video',
      hdUrl: result.video,
      sdUrl: result.video,
      wmUrl: null,
      audioUrl: result.music ?? null,
      cover: author.avatar ?? null,
      title: result.desc ?? '',
      duration: 0,
      authorName: author.nickname ?? '',
      authorAvatar: author.avatar ?? null,
      authorUsername: null,
      stats: {
        likes: parseCount(stats.likeCount),
        comments: parseCount(stats.commentCount),
        shares: parseCount(stats.shareCount),
        views: null,
      },
      sourceUrl: inputUrl,
      resolvedBy: 'TikTokDownbloder',
      resolvedMs: 0,
    };
  },
};

function parseCount(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/,/g, '').trim();
  const m = cleaned.match(/^([\d.]+)\s*([KkMmBb])?$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2]) {
    const unit = m[2].toUpperCase();
    if (unit === 'K') n *= 1_000;
    else if (unit === 'M') n *= 1_000_000;
    else if (unit === 'B') n *= 1_000_000_000;
  }
  return Math.round(n);
}

/** Ordered source list for TikTok resolution. */
export function tiktokSources(turnstileToken?: string): ApiSource<string, MediaMeta>[] {
  return [
    tikwmSource,                    // Fast 3rd-party API (8s timeout, POST)
    tiktokDownbloderSource,         // Vercel-hosted free API (12s timeout)
    tiktokDirectSource,             // Direct TikTok HTML parse (12s timeout)
  ];
}
