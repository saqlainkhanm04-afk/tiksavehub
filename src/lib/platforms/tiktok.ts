/**
 * TikTok platform sources — fed into runWithFallback.
 *
 * Sources (in order):
 *  1. TikWM — fast third-party API, returns direct CDN URLs
 *  2. TikTok Direct — fetch TikTok's own page, parse __UNIVERSAL_DATA_FOR_REHYDRATION__
 *  3. Cobalt — cobalt.tools extraction pipeline (needs turnstile token)
 *  4. TikTok Item Detail — official web API endpoint, no auth required
 *
 * Every source rotates User-Agent + Sec-CH-UA headers per request so TikTok
 * cannot fingerprint and block our server IP based on a static UA string.
 */
import type { ApiSource } from '../api-fallback';
import type { MediaMeta } from './types';
import { thirdPartyApiHeaders, tiktokApiHeaders } from './headers';
import { tiktokDirectSource } from './tiktok-direct';

const TIKWM_HOSTS = ['https://tikwm.com/api/', 'https://www.tikwm.com/api/'];

/* ------------------------------------------------------------------ */
/*  Source 1 — TikWM                                                  */
/* ------------------------------------------------------------------ */
export const tikwmSource: ApiSource<string, MediaMeta> = {
  name: 'TikWM',
  timeoutMs: 4_000,
  retries: 1,
  noRetryStatuses: [404, 422],
  async fetch(resolvedUrl: string) {
    console.log(`[TikWM] ▶ Starting fetch for: ${resolvedUrl}`);
    const errors: string[] = [];
    for (const host of TIKWM_HOSTS) {
      try {
        const headers = thirdPartyApiHeaders('https://tikwm.com/');
        const fetchUrl = `${host}?url=${encodeURIComponent(resolvedUrl)}&hd=1`;
        console.log(`[TikWM] → Trying: ${fetchUrl}`);
        const resp = await fetch(fetchUrl, {
          headers,
          signal: AbortSignal.timeout(3_000),
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
/*  Source 2 — Cobalt                                                  */
/* ------------------------------------------------------------------ */
export function cobaltSource(turnstileToken?: string): ApiSource<string, MediaMeta> {
  return {
    name: 'Cobalt',
    timeoutMs: 15_000,
    retries: 1,
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
    console.log(`[CobaltSource]   Got cobalt URL, fetching oEmbed...`);
    // Fetch oEmbed for metadata
    const oembedResp = await fetch(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(resolvedUrl)}`,
      { headers: tiktokApiHeaders(), signal: AbortSignal.timeout(5_000) },
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
/*  Source 3 — TikTok Item Detail (official web API)                   */
/* ------------------------------------------------------------------ */
function extractVideoIdFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
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

export const tiktokItemDetailSource: ApiSource<string, MediaMeta> = {
  name: 'TikTokItemDetail',
  timeoutMs: 6_000,
  retries: 1,
  noRetryStatuses: [403, 404],
  async fetch(resolvedUrl: string) {
    const videoId = extractVideoIdFromUrl(resolvedUrl);
    if (!videoId) throw new Error('Cannot extract video ID');
    const headers = tiktokApiHeaders();
    const fetchUrl = `https://www.tiktok.com/api/item/detail/?itemId=${videoId}&aid=1988`;
    console.log(`[TikTokItemDetail] ▶ Trying: ${fetchUrl}`);
    console.log(`[TikTokItemDetail]   Headers: UA=${headers['User-Agent']?.substring(0, 40)}... SecCHUA=${headers['Sec-CH-UA'] ?? 'none'}`);
    const resp = await fetch(fetchUrl, { headers, signal: AbortSignal.timeout(5_000) });
    const bodyText = await resp.text().catch(() => '<unreadable>');
    console.log(`[TikTokItemDetail] ← status=${resp.status} body(2000)=${bodyText.substring(0, 2000)}`);
    if (!resp.ok) throw new Error(`TikTok item-detail returned ${resp.status}`);
    const data: any = JSON.parse(bodyText);
    if (!data?.itemInfo?.itemStruct) {
      console.log(`[TikTokItemDetail] ✗ Empty response — has itemInfo=${!!data?.itemInfo} has itemStruct=${!!data?.itemInfo?.itemStruct} keys=${Object.keys(data || {}).join(',')}`);
      throw new Error('item-detail: empty or blocked');
    }
    const item = data.itemInfo.itemStruct;
    console.log(`[TikTokItemDetail] ✓ Success — title="${item.desc?.substring(0, 60)}" hasPlayAddr=${!!item.video?.playAddr} hasDownloadAddr=${!!item.video?.downloadAddr}`);
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
/*  Source 4 — tiktok-downbloder (Vercel-hosted, free, no auth)        */
/* ------------------------------------------------------------------ */
export const tiktokDownbloderSource: ApiSource<string, MediaMeta> = {
  name: 'TikTokDownbloder',
  timeoutMs: 10_000,
  retries: 1,
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
    tikwmSource,        // Fast 3rd-party (3s timeout)
    tiktokDirectSource, // Direct TikTok HTML parse (12s timeout)
    cobaltSource(turnstileToken), // Cobalt pipeline (15s timeout)
    tiktokDownbloderSource,      // Vercel-hosted free API (10s timeout)
    tiktokItemDetailSource,      // TikTok internal API (6s timeout)
  ];
}
