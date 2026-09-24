/**
 * TikTok platform sources — fed into runWithFallback.
 *
 * Sources (in order):
 *  1. TikWM — third-party API (POST form-encoded, may be broken on some IPs)
 *  2. TikCDN Direct — construct tikcdn.io/{pattern}/{id} directly (fastest)
 *  3. TikTok Direct — fetch TikTok's own page, parse __UNIVERSAL_DATA_FOR_REHYDRATION__
 *  4. Cobalt — cobalt.tools extraction pipeline (needs turnstile token)
 *  5. TikTok Item Detail — official web API endpoint, no auth required
 *
 * Every source rotates User-Agent + Sec-CH-UA headers per request so TikTok
 * cannot fingerprint and block our server IP based on a static UA string.
 */
import type { ApiSource } from '../api-fallback';
import type { MediaMeta } from './types';
import { thirdPartyApiHeaders, tiktokApiHeaders } from './headers';
import { tiktokDirectSource } from './tiktok-direct';
import { probeVideoUrl, isValidVideoBytes } from './video-probe';

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
  timeoutMs: 4_000,
  retries: 0,
  noRetryStatuses: [404, 422],
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
          signal: AbortSignal.timeout(3_500),
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

        // Validate the primary video URL is actually video content (not an error page image)
        const primaryUrl = data.data.hdplay || data.data.play;
        if (primaryUrl) {
          const probe = await probeVideoUrl(primaryUrl, 4_000);
          if (!probe.ok) {
            console.log(`[TikWM] ✗ Video URL probe FAILED: ${probe.error} (ct=${probe.contentType} cl=${probe.contentLength})`);
            errors.push(`${host}→video probe failed: ${probe.error}`);
            continue;
          }
          console.log(`[TikWM] ✓ Video URL probe OK — ct=${probe.contentType} cl=${probe.contentLength}`);
        }

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
/*  Source 2 — TikCDN Direct (fallback CDN patterns + health monitor)  */
/* ------------------------------------------------------------------ */

/** CDN URL patterns to try in order. Each returns an MP4 from tikcdn.io. */
const CDN_PATTERNS = [
  (id: string) => `https://tikcdn.io/download/${id}`,
  (id: string) => `https://tikcdn.io/mp4/${id}`,
];

const CDN_PROBE_TIMEOUT_MS = 2_000;

async function probeCdnUrl(cdnUrl: string, timeoutMs: number): Promise<{ ok: boolean; status: number; ct: string; cl: string }> {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  // Try HEAD first
  let resp: Response;
  try {
    resp = await fetch(cdnUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': ua },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, status: 0, ct: '', cl: '' };
  }

  // If HEAD works (2xx with video content), return it
  if (resp.ok) {
    const ct = resp.headers.get('content-type') || '';
    const cl = resp.headers.get('content-length') || '';
    if (ct.includes('video') || ct.includes('octet-stream') || (cl && Number(cl) > 1024)) {
      return { ok: true, status: resp.status, ct, cl };
    }
  }

  // HEAD returned 403 or 405 — retry with GET + Range header + magic bytes check
  if (resp.status === 403 || resp.status === 405) {
    console.log(`[TikCDNDirect] HEAD ${resp.status} on ${cdnUrl} — retrying with GET Range`);
    try {
      const getResp = await fetch(cdnUrl, {
        method: 'GET',
        headers: { 'User-Agent': ua, 'Range': 'bytes=0-11' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (getResp.ok || getResp.status === 206) {
        const ct = getResp.headers.get('content-type') || '';
        const cl = getResp.headers.get('content-range') || getResp.headers.get('content-length') || '';
        const hasVideo = ct.includes('video') || ct.includes('octet-stream');

        // Read actual bytes for magic-byte validation
        const bodyBuf = await getResp.arrayBuffer().catch(() => null);
        const bytes = bodyBuf ? new Uint8Array(bodyBuf) : null;

        if (!hasVideo && ct && !ct.includes('application/octet-stream')) {
          console.log(`[TikCDNDirect] GET ${getResp.status} non-video content-type: ${ct} — rejecting`);
        } else if (hasVideo || getResp.status === 206) {
          // Magic bytes check — reject HTML error pages masquerading as video
          if (!bytes || !isValidVideoBytes(bytes)) {
            const hex = bytes ? Array.from(bytes.slice(0, 12)).map((b) => b.toString(16).padStart(2, '0')).join(' ') : 'N/A';
            console.log(`[TikCDNDirect] GET ${getResp.status} magic bytes INVALID (hex: ${hex}) — rejecting`);
          } else {
            return { ok: true, status: getResp.status, ct, cl };
          }
        }
      }
    } catch {}
  }

  return { ok: false, status: resp.status, ct: resp.headers.get('content-type') || '', cl: '' };
}

export const tiktokCdnDirectSource: ApiSource<string, MediaMeta> = {
  name: 'TikCDNDirect',
  timeoutMs: 8_000,
  retries: 0,
  noRetryStatuses: [404],
  async fetch(resolvedUrl: string) {
    // Extract video ID — resolve short links first if needed
    let videoId = extractVideoIdFromUrl(resolvedUrl);
    if (!videoId) {
      // Try resolving short links (vm.tiktok.com, vt.tiktok.com)
      const resolved = await resolveShortLinkForExtract(resolvedUrl);
      videoId = extractVideoIdFromUrl(resolved);
      if (!videoId) throw new Error('Cannot extract video ID');
      console.log(`[TikCDNDirect] Resolved short link → videoId=${videoId}`);
    }

    // Check CDN health — if degraded, skip immediately
    if (!cdnIsHealthy()) {
      throw new Error('CDN health degraded — skipping');
    }

    // Try each CDN pattern in order with 2s timeout each
    const errors: string[] = [];
    for (let i = 0; i < CDN_PATTERNS.length; i++) {
      const cdnUrl = CDN_PATTERNS[i](videoId);
      console.log(`[TikCDNDirect] ▶ Pattern ${i + 1}/${CDN_PATTERNS.length}: ${cdnUrl}`);
      const result = await probeCdnUrl(cdnUrl, CDN_PROBE_TIMEOUT_MS);
      if (result.ok) {
        console.log(`[TikCDNDirect] ✓ Pattern ${i + 1} SUCCESS — status=${result.status} type=${result.ct} len=${result.cl}`);
        recordCdnResult(true);
        return { videoId, cdnUrl, contentType: result.ct };
      }
      console.log(`[TikCDNDirect] ✗ Pattern ${i + 1} FAILED — status=${result.status} type=${result.ct}`);
      errors.push(`pattern${i + 1}→${result.status}`);
      recordCdnResult(false);
    }

    throw new Error(`TikCDN failed all ${CDN_PATTERNS.length} patterns: ${errors.join('; ')}`);
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.cdnUrl) return null;
    return {
      platform: 'tiktok',
      type: 'video',
      hdUrl: raw.cdnUrl,
      sdUrl: raw.cdnUrl,
      wmUrl: null,
      audioUrl: null,
      cover: null,
      title: '',
      duration: 0,
      authorName: '',
      authorAvatar: null,
      authorUsername: null,
      stats: { likes: null, comments: null, shares: null, views: null },
      sourceUrl: inputUrl,
      resolvedBy: 'TikCDNDirect',
      resolvedMs: 0,
    };
  },
};

/* ------------------------------------------------------------------ */
/*  Source 3 — Cobalt                                                  */
/* ------------------------------------------------------------------ */
export function cobaltSource(turnstileToken?: string): ApiSource<string, MediaMeta> {
  return {
    name: 'Cobalt',
    timeoutMs: 10_000,
    retries: 0,
    noRetryStatuses: [404, 422],
    noRetryErrors: ['Cobalt returned no URL'],
    async fetch(resolvedUrl: string) {
      console.log(`[CobaltSource] ▶ Starting fetch for: ${resolvedUrl} (hasTurnstile=${!!turnstileToken})`);
      const { cobaltExtractVideo } = await import('../cobalt');
      const cobalt = await cobaltExtractVideo(resolvedUrl, turnstileToken);
      if (!cobalt?.url) {
        console.log(`[CobaltSource] ✗ cobaltExtractVideo returned null`);
        throw new Error('Cobalt returned no URL');
      }

      // Validate the cobalt URL is actually video content
      const probe = await probeVideoUrl(cobalt.url, 5_000);
      if (!probe.ok) {
        console.log(`[CobaltSource] ✗ Video URL probe FAILED: ${probe.error} (ct=${probe.contentType} cl=${probe.contentLength})`);
        throw new Error(`Cobalt URL is not valid video content: ${probe.error}`);
      }
      console.log(`[CobaltSource] ✓ Video URL probe OK — ct=${probe.contentType} cl=${probe.contentLength}`);

      console.log(`[CobaltSource]   Got cobalt URL, fetching oEmbed...`);
      const oembedResp = await fetch(
        `https://www.tiktok.com/oembed?url=${encodeURIComponent(resolvedUrl)}`,
        { headers: tiktokApiHeaders(), signal: AbortSignal.timeout(4_000) },
      ).catch(() => null);
      const oembed = oembedResp?.ok ? await oembedResp.json().catch(() => null) : null;
      console.log(`[CobaltSource] ✓ oEmbed: status=${oembedResp?.status} hasTitle=${!!(oembed as any)?.title} hasThumbnail=${!!(oembed as any)?.thumbnail_url}`);
      return { cobaltUrl: cobalt.url, oembed };
    },
    normalize(raw: any, inputUrl: string): MediaMeta | null {
      if (!raw?.cobaltUrl) return null;
      const o = raw.oembed;
      return {
        platform: 'tiktok',
        type: 'video',
        hdUrl: raw.cobaltUrl,
        sdUrl: null,
        wmUrl: null,
        audioUrl: null,
        cover: o?.thumbnail_url || null,
        title: o?.title || 'TikTok video',
        duration: 0,
        authorName: o?.author_name || '',
        authorAvatar: null,
        authorUsername: o?.author_name || null,
        stats: { likes: null, comments: null, shares: null, views: null },
        sourceUrl: inputUrl,
        resolvedBy: 'Cobalt',
        resolvedMs: 0,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Source 4 — TikTok Item Detail (official web API)                   */
/* ------------------------------------------------------------------ */
export const tiktokItemDetailSource: ApiSource<string, MediaMeta> = {
  name: 'TikTokItemDetail',
  timeoutMs: 5_000,
  retries: 0,
  noRetryStatuses: [403, 404],
  async fetch(resolvedUrl: string) {
    const videoId = extractVideoIdFromUrl(resolvedUrl);
    if (!videoId) throw new Error('Cannot extract video ID');
    const headers = tiktokApiHeaders();
    const fetchUrl = `https://www.tiktok.com/api/item/detail/?itemId=${videoId}&aid=1988`;
    console.log(`[TikTokItemDetail] ▶ Trying: ${fetchUrl}`);
    const resp = await fetch(fetchUrl, { headers, signal: AbortSignal.timeout(4_500) });
    const bodyText = await resp.text().catch(() => '<unreadable>');
    console.log(`[TikTokItemDetail] ← status=${resp.status} body(2000)=${bodyText.substring(0, 2000)}`);
    if (!resp.ok) throw new Error(`TikTok item-detail returned ${resp.status}`);
    const data: any = JSON.parse(bodyText);
    if (!data?.itemInfo?.itemStruct) {
      console.log(`[TikTokItemDetail] ✗ Empty response — keys=${Object.keys(data || {}).join(',')}`);
      throw new Error('item-detail: empty or blocked');
    }
    const item = data.itemInfo.itemStruct;
    console.log(`[TikTokItemDetail] ✓ Success — title="${item.desc?.substring(0, 60)}" hasPlayAddr=${!!item.video?.playAddr} hasDownloadAddr=${!!item.video?.downloadAddr}`);

    // Validate the primary video URL is actually video content
    const videoUrl = item.video?.downloadAddr?.[0]?.src || item.video?.playAddr?.[0]?.src;
    if (videoUrl) {
      const probe = await probeVideoUrl(videoUrl, 4_000);
      if (!probe.ok) {
        console.log(`[TikTokItemDetail] ✗ Video URL probe FAILED: ${probe.error} (ct=${probe.contentType} cl=${probe.contentLength})`);
        throw new Error(`Item detail video URL is not valid: ${probe.error}`);
      }
      console.log(`[TikTokItemDetail] ✓ Video URL probe OK — ct=${probe.contentType} cl=${probe.contentLength}`);
    }

    return data;
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    const item = raw?.itemInfo?.itemStruct;
    if (!item) return null;
    const video = item.video ?? {};
    const author = item.author ?? {};
    const playAddr = video.playAddr?.[0]?.src ?? null;
    const downloadAddr = video.downloadAddr?.[0]?.src ?? null;
    if (!playAddr && !downloadAddr) return null;
    return {
      platform: 'tiktok',
      type: 'video',
      hdUrl: downloadAddr || playAddr,
      sdUrl: playAddr,
      wmUrl: downloadAddr || null,
      audioUrl: null,
      cover: video.cover ?? video.originCover ?? null,
      title: item.desc ?? '',
      duration: video.duration ?? 0,
      authorName: author.nickname ?? '',
      authorAvatar: author.avatarThumb ?? null,
      authorUsername: author.uniqueId ?? null,
      stats: {
        likes: item.stats?.diggCount ?? null,
        comments: item.stats?.commentCount ?? null,
        shares: item.stats?.shareCount ?? null,
        views: item.stats?.playCount ?? null,
      },
      sourceUrl: inputUrl,
      resolvedBy: 'TikTokItemDetail',
      resolvedMs: 0,
    };
  },
};

/* ------------------------------------------------------------------ */
/*  Source 5 — tiktok-downbloder (Vercel-hosted, free, no auth)        */
/* ------------------------------------------------------------------ */
export const tiktokDownbloderSource: ApiSource<string, MediaMeta> = {
  name: 'TikTokDownbloder',
  timeoutMs: 8_000,
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
      signal: AbortSignal.timeout(8_000),
    });
    const bodyText = await resp.text().catch(() => '<unreadable>');
    console.log(`[TikTokDownbloder] ← status=${resp.status} body(2000)=${bodyText.substring(0, 2000)}`);
    if (!resp.ok) throw new Error(`TikTokDownbloder returned ${resp.status}`);
    const data: any = JSON.parse(bodyText);
    if (!data?.success || !data?.result?.raw?.result?.video) {
      throw new Error('TikTokDownbloder: no video URL');
    }

    // Validate the video URL is actually video content
    const videoUrl = data.result.raw.result.video;
    const probe = await probeVideoUrl(videoUrl, 4_000);
    if (!probe.ok) {
      console.log(`[TikTokDownbloder] ✗ Video URL probe FAILED: ${probe.error} (ct=${probe.contentType} cl=${probe.contentLength})`);
      throw new Error(`TikTokDownbloder video URL is not valid: ${probe.error}`);
    }
    console.log(`[TikTokDownbloder] ✓ Video URL probe OK — ct=${probe.contentType} cl=${probe.contentLength}`);

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
    tikwmSource,                    // Fast 3rd-party API (4s timeout, POST)
    tiktokCdnDirectSource,          // Direct tikcdn CDN probe (8s timeout, multi-pattern)
    tiktokDirectSource,             // Direct TikTok HTML parse (8s timeout)
    cobaltSource(turnstileToken),   // Cobalt pipeline (10s timeout)
    tiktokDownbloderSource,         // Vercel-hosted free API (8s timeout)
    tiktokItemDetailSource,         // TikTok internal API (5s timeout)
  ];
}
