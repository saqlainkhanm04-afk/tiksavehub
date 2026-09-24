/**
 * TikTok Direct HTML Extractor
 *
 * Fetches the actual TikTok web page and extracts video data from the
 * embedded JSON payload (`__UNIVERSAL_DATA_FOR_REHYDRATION__` or SIGI_STATE).
 *
 * This is the most resilient extraction method because it uses TikTok's own
 * page — no third-party wrapper to break. TikTok cannot remove this JSON
 * without breaking their own SPA hydration.
 *
 * Flow:
 *  1. GET https://www.tiktok.com/@user/video/{id} with realistic browser headers
 *  2. Scan HTML for `__UNIVERSAL_DATA_FOR_REHYDRATION__` script tag
 *  3. Fallback: scan for `SIGI_STATE` or `__NEXT_DATA__` script tags
 *  4. Extract video playAddr/downloadAddr from the JSON tree
 *  5. Map to MediaMeta
 */

import type { ApiSource } from '../api-fallback';
import type { MediaMeta } from './types';
import { tiktokWebHeaders } from './headers';
import { probeVideoUrl } from './video-probe';

/* ------------------------------------------------------------------ */
/*  Video ID extraction                                                */
/* ------------------------------------------------------------------ */

function extractVideoId(url: string): string | null {
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

/* ------------------------------------------------------------------ */
/*  JSON payload extraction from HTML                                  */
/* ------------------------------------------------------------------ */

/** Maximum bytes to read from the HTML response (enough to capture <head> + first scripts) */
const MAX_HTML_BYTES = 512_000;

interface HydrationData {
  itemInfo?: {
    itemStruct?: {
      video?: any;
      author?: any;
      desc?: string;
      stats?: any;
      createTime?: string;
      music?: any;
      images?: any[];
    };
  };
  itemModule?: Record<string, {
    id?: string;
    video?: any;
    author?: any;
    desc?: string;
    stats?: any;
    createTime?: string;
    music?: any;
    images?: any[];
  }>;
  itemType?: string;
}

/**
 * Fetch the TikTok page and extract the embedded JSON hydration data.
 * Uses bounded read to avoid downloading multi-MB of JS bundles.
 */
async function fetchHydrationData(resolvedUrl: string): Promise<{ json: HydrationData; method: string } | null> {
  const headers = tiktokWebHeaders({ referer: 'https://www.tiktok.com/' });
  console.log(`[TikTokDirect] ▶ Fetching page: ${resolvedUrl}`);
  console.log(`[TikTokDirect]   UA: ${headers['User-Agent']?.substring(0, 50)}...`);
  const resp = await fetch(resolvedUrl, {
    headers,
    signal: AbortSignal.timeout(7_000),
    redirect: 'follow',
  });

  console.log(`[TikTokDirect] ← status=${resp.status} type=${resp.headers.get('content-type')} url=${resp.url}`);
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '<unreadable>');
    console.log(`[TikTokDirect] ✗ Error body(1000)=${errBody.substring(0, 1000)}`);
    throw new Error(`TikTok page returned ${resp.status}`);
  }

  // Read bounded stream — hydration JSON lives in <head>, no need for full page
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffered = '';
  let bytesRead = 0;

  try {
    while (bytesRead < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.length;
      buffered += decoder.decode(value, { stream: true });

      // Check if we've captured enough to find the script tags
      // The hydration script is always in <head> or early <body>
      if (buffered.includes('</head>') || buffered.includes('SIGI_STATE') || buffered.includes('__NEXT_DATA__')) {
        break;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  console.log(`[TikTokDirect]   Buffered ${bytesRead} bytes, has </head>=${buffered.includes('</head>')} has UNIVERSAL_DATA=${buffered.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__')} has SIGI_STATE=${buffered.includes('SIGI_STATE')} has NEXT_DATA=${buffered.includes('__NEXT_DATA__')}`);

  // Try __UNIVERSAL_DATA_FOR_REHYDRATION__ (current TikTok, 2024+)
  let match = buffered.match(
    /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>\s*({[\s\S]*?})\s*<\/script>/
  );
  if (match?.[1]) {
    try {
      const data = JSON.parse(match[1]);
      // Navigate the hydration tree to find the video item
      const defaultScope = data?.__DEFAULT_SCOPE__;
      if (defaultScope) {
        // New format: __DEFAULT_SCOPE__["webapp.video-detail"]["itemInfo"]["itemStruct"]
        const videoDetail = defaultScope['webapp.video-detail'] || defaultScope['webapp.video-page'];
        if (videoDetail?.itemInfo?.itemStruct) {
          return { json: videoDetail as HydrationData, method: 'UNIVERSAL_DATA' };
        }
        // Alternate path: itemModule
        if (videoDetail?.itemModule) {
          return { json: videoDetail as HydrationData, method: 'UNIVERSAL_DATA' };
        }
      }
      // Fallback: search entire parsed object for itemInfo
      if (data?.itemInfo?.itemStruct) {
        return { json: data as HydrationData, method: 'UNIVERSAL_DATA' };
      }
    } catch { /* parse error — try next method */ }
  }

  // Try SIGI_STATE (older TikTok, some regions)
  match = buffered.match(
    /<script\s+id="SIGI_STATE"[^>]*>\s*({[\s\S]*?})\s*<\/script>/
  );
  if (match?.[1]) {
    try {
      const data = JSON.parse(match[1]);
      // SIGI_STATE stores items in itemModule
      if (data?.ItemModule) {
        return { json: { itemModule: data.ItemModule } as HydrationData, method: 'SIGI_STATE' };
      }
    } catch { /* parse error — try next method */ }
  }

  // Try __NEXT_DATA__ (server-rendered pages, some regions)
  match = buffered.match(
    /<script\s+id="__NEXT_DATA__"[^>]*>\s*({[\s\S]*?})\s*<\/script>/
  );
  if (match?.[1]) {
    try {
      const data = JSON.parse(match[1]);
      const props = data?.props?.pageProps;
      if (props?.itemInfo?.itemStruct) {
        return { json: props as HydrationData, method: 'NEXT_DATA' };
      }
    } catch { /* parse error */ }
  }

  // Last resort: scan for any JSON blob containing video info patterns
  // Look for playAddr or downloadAddr URLs in script content
  const playAddrMatch = buffered.match(/"playAddr"\s*:\s*"(https?:[^"]+)"/);
  const downloadAddrMatch = buffered.match(/"downloadAddr"\s*:\s*"(https?:[^"]+)"/);
  console.log(`[TikTokDirect]   Regex fallback: playAddr=${!!playAddrMatch} downloadAddr=${!!downloadAddrMatch}`);
  if (playAddrMatch?.[1] || downloadAddrMatch?.[1]) {
    // Construct a minimal HydrationData from regex matches
    const video: any = {};
    if (playAddrMatch?.[1]) video.playAddr = [{ src: playAddrMatch[1].replace(/\\u002F/g, '/') }];
    if (downloadAddrMatch?.[1]) video.downloadAddr = [{ src: downloadAddrMatch[1].replace(/\\u002F/g, '/') }];

    // Try to extract cover
    const coverMatch = buffered.match(/"cover"\s*:\s*"(https?:[^"]+)"/);
    if (coverMatch?.[1]) video.cover = coverMatch[1].replace(/\\u002F/g, '/');

    // Try to extract author
    const authorMatch = buffered.match(/"uniqueId"\s*:\s*"([^"]+)"/);
    const nicknameMatch = buffered.match(/"nickname"\s*:\s*"([^"]+)"/);

    // Try to extract desc
    const descMatch = buffered.match(/"desc"\s*:\s*"([^"]{1,500})"/);

    return {
      json: {
        itemInfo: {
          itemStruct: {
            video,
            author: {
              uniqueId: authorMatch?.[1] ?? '',
              nickname: nicknameMatch?.[1] ?? '',
            },
            desc: descMatch?.[1] ?? '',
          },
        },
      },
      method: 'REGEX_FALLBACK',
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Source — TikTok Direct HTML Extractor                              */
/* ------------------------------------------------------------------ */

function extractItemFromJson(json: HydrationData, videoId: string): any | null {
  // Path 1: itemInfo.itemStruct (direct)
  if (json.itemInfo?.itemStruct) return json.itemInfo.itemStruct;

  // Path 2: itemModule keyed by video ID
  if (json.itemModule) {
    // Try exact video ID key first
    if (json.itemModule[videoId]) return json.itemModule[videoId];
    // Try first item in the module (sometimes keyed differently)
    const keys = Object.keys(json.itemModule);
    if (keys.length === 1) return json.itemModule[keys[0]];
    // Search for matching item by video id
    for (const key of keys) {
      const item = json.itemModule[key];
      if (item?.id === videoId) return item;
    }
  }

  return null;
}

export const tiktokDirectSource: ApiSource<string, MediaMeta> = {
  name: 'TikTokDirect',
  timeoutMs: 8_000,
  retries: 0,
  noRetryStatuses: [403, 404, 451],
  noRetryErrors: ['Cannot extract video ID', 'No hydration data found'],

  async fetch(resolvedUrl: string) {
    const videoId = extractVideoId(resolvedUrl);
    if (!videoId) throw new Error('Cannot extract video ID');
    console.log(`[TikTokDirect] ▶ Starting fetch for videoId=${videoId}`);

    const hydration = await fetchHydrationData(resolvedUrl);
    if (!hydration) throw new Error('No hydration data found in TikTok page');

    console.log(`[TikTokDirect]   Hydration method=${hydration.method}, extracting item...`);
    const item = extractItemFromJson(hydration.json, videoId);
    if (!item) {
      const scope = (hydration.json as any)?.__DEFAULT_SCOPE__ ?? {};
      console.log(`[TikTokDirect] ✗ No item for videoId=${videoId} — scope keys=${Object.keys(scope).join(',')} itemModule keys=${Object.keys((hydration.json as any)?.itemModule || {}).join(',')}`);
      throw new Error(`No item found for videoId=${videoId} (method=${hydration.method})`);
    }
    console.log(`[TikTokDirect] ✓ Found item: title="${item.desc?.substring(0, 60)}" hasPlayAddr=${!!item.video?.playAddr} hasDownloadAddr=${!!item.video?.downloadAddr}`);

    // Validate the primary video URL is actually video content
    const video = item.video ?? {};
    const playRaw = video.playAddr;
    const downloadRaw = video.downloadAddr;
    const primaryUrl = extractUrl(downloadRaw) || extractUrl(playRaw);
    if (primaryUrl) {
      const probe = await probeVideoUrl(primaryUrl, 5_000);
      if (!probe.ok) {
        console.log(`[TikTokDirect] ✗ Video URL probe FAILED: ${probe.error} (ct=${probe.contentType} cl=${probe.contentLength})`);
        throw new Error(`Video URL is not valid video content: ${probe.error}`);
      }
      console.log(`[TikTokDirect] ✓ Video URL probe OK — ct=${probe.contentType} cl=${probe.contentLength}`);
    }

    return { item, method: hydration.method, videoId };
  },

  normalize(raw: any, inputUrl: string): MediaMeta | null {
    const item = raw?.item;
    if (!item) return null;

    const video = item.video ?? {};
    const author = item.author ?? {};

    // Extract video URLs — TikTok encodes them as arrays of {src, type} objects
    const playAddrRaw = video.playAddr;
    const downloadAddrRaw = video.downloadAddr;

    // playAddr can be string | Array<{src, type, ...}> | {src, type} | null
    const playAddr = extractUrl(playAddrRaw);
    const downloadAddr = extractUrl(downloadAddrRaw);

    // Also check bitrateInfo for higher quality URLs
    let hdUrl = downloadAddr || playAddr;
    let sdUrl = playAddr;

    if (Array.isArray(video.bitrateInfo)) {
      for (const br of video.bitrateInfo) {
        const brUrl = extractUrl(br.PlayAddr);
        if (!brUrl) continue;
        // Prefer 1080p or highest quality
        if (br.GearName?.includes('1080p') || (br.Bitrate ?? 0) > 1_000_000) {
          hdUrl = brUrl;
        } else if (br.GearName?.includes('720p')) {
          if (!hdUrl || hdUrl === playAddr) hdUrl = brUrl;
        }
      }
    }

    if (!playAddr && !downloadAddr && !hdUrl) return null;

    // Extract stats
    const stats = item.stats ?? {};

    // Extract music
    const music = item.music ?? {};

    return {
      platform: 'tiktok',
      type: 'video',
      hdUrl: hdUrl ?? null,
      sdUrl: sdUrl ?? null,
      wmUrl: null,
      audioUrl: extractUrl(music.play) ?? extractUrl(music.playUrl) ?? null,
      cover: video.cover ?? video.originCover ?? video.dynamicCover ?? null,
      title: item.desc ?? '',
      duration: video.duration ?? 0,
      authorName: author.nickname ?? '',
      authorAvatar: author.avatarThumb ?? author.avatarMedium ?? null,
      authorUsername: author.uniqueId ?? author.id ?? null,
      stats: {
        likes: stats.diggCount ?? stats.likes ?? null,
        comments: stats.commentCount ?? stats.comments ?? null,
        shares: stats.shareCount ?? stats.shares ?? null,
        views: stats.playCount ?? stats.plays ?? null,
      },
      sourceUrl: inputUrl,
      resolvedBy: `TikTokDirect(${raw.method})`,
      resolvedMs: 0,
    };
  },
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Extract a URL string from various TikTok URL representations:
 *  - Plain string: "https://..."
 *  - Array of objects: [{src: "https://...", type: "video/mp4"}]
 *  - Object with src: {src: "https://..."}
 */
function extractUrl(val: any): string | null {
  if (!val) return null;
  if (typeof val === 'string' && val.startsWith('http')) return val;
  if (Array.isArray(val) && val.length > 0) {
    // Prefer mp4, fallback to first
    const mp4 = val.find((v: any) => v?.type?.includes('mp4') || v?.mime?.includes('mp4'));
    const best = mp4 || val[0];
    if (best?.src) return best.src;
    if (typeof best === 'string') return best;
  }
  if (val.src && typeof val.src === 'string') return val.src;
  return null;
}
