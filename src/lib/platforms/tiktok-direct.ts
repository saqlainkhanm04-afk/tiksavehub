/**
 * TikTok Direct HTML Extractor
 *
 * Fetches the actual TikTok web page and extracts video data from the
 * embedded JSON payload. Handles multiple page structures as TikTok evolves.
 *
 * Flow:
 *  1. Try embed page first (simpler structure, less JS)
 *  2. Fall back to video page with mobile headers
 *  3. Scan HTML for known script tags: api-data, __UNIVERSAL_DATA_FOR_REHYDRATION__, SIGI_STATE, __NEXT_DATA__
 *  4. Regex fallback for playAddr/downloadAddr in any script content
 */

import type { ApiSource } from '../api-fallback';
import type { MediaMeta } from './types';
import { tiktokWebHeaders } from './headers';

/* ------------------------------------------------------------------ */
/*  Video ID extraction                                               */
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

/** Maximum bytes to read from the HTML response */
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
 * Fetch a TikTok page (embed or video) and extract embedded JSON hydration data.
 * Tries embed page first (simpler), then video page.
 */
async function fetchHydrationData(resolvedUrl: string): Promise<{ json: HydrationData; method: string; url: string } | null> {
  const videoId = extractVideoId(resolvedUrl);
  if (!videoId) return null;

  // Try embed page first — simpler HTML, less JS, more reliable
  const embedUrl = `https://www.tiktok.com/embed/v2/${videoId}`;
  const urlsToTry = [embedUrl, resolvedUrl];

  for (const url of urlsToTry) {
    const isEmbed = url.includes('/embed/');
    const headers = tiktokWebHeaders({
      referer: 'https://www.tiktok.com/',
      mobile: !isEmbed, // embed works better with desktop UA
    });
    console.log(`[TikTokDirect] ▶ Fetching ${isEmbed ? 'embed' : 'video'} page: ${url}`);
    console.log(`[TikTokDirect]   UA: ${headers['User-Agent']?.substring(0, 50)}...`);

    let resp: Response;
    try {
      resp = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(isEmbed ? 8_000 : 10_000),
        redirect: 'follow',
      });
    } catch (err) {
      console.log(`[TikTokDirect] ✗ Fetch failed for ${url}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    console.log(`[TikTokDirect] ← status=${resp.status} type=${resp.headers.get('content-type')} finalUrl=${resp.url}`);
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '<unreadable>');
      console.log(`[TikTokDirect] ✗ Error body(1000)=${errBody.substring(0, 1000)}`);
      continue;
    }

    // Read bounded stream
    const reader = resp.body?.getReader();
    if (!reader) continue;

    const decoder = new TextDecoder();
    let buffered = '';
    let bytesRead = 0;

    try {
      while (bytesRead < MAX_HTML_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.length;
        buffered += decoder.decode(value, { stream: true });

        // Stop early if we have enough data
        if (buffered.includes('id="api-data"') ||
            buffered.includes('id="__UNIVERSAL_DATA_FOR_REHYDRATION__"') ||
            buffered.includes('id="SIGI_STATE"') ||
            buffered.includes('id="__NEXT_DATA__"') ||
            buffered.includes('"playAddr"') ||
            buffered.includes('"downloadAddr"') ||
            buffered.includes('</html>')) {
          break;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    console.log(`[TikTokDirect]   Buffered ${bytesRead} bytes from ${isEmbed ? 'embed' : 'video'} page`);

    const hydration = extractHydrationFromHtml(buffered, videoId);
    if (hydration) {
      console.log(`[TikTokDirect] ✓ Found hydration data via ${hydration.method} on ${isEmbed ? 'embed' : 'video'} page`);
      return { json: hydration.json, method: hydration.method, url };
    }

    console.log(`[TikTokDirect] ✗ No hydration data found on ${isEmbed ? 'embed' : 'video'} page`);
  }

  return null;
}

/**
 * Extract hydration data from HTML buffer using multiple strategies.
 */
function extractHydrationFromHtml(html: string, videoId: string): { json: HydrationData; method: string } | null {
  // Strategy 1: api-data script tag (mobile video page, 2024+)
  let match = html.match(/<script\s+id="api-data"[^>]*>\s*({[\s\S]*?})\s*<\/script>/);
  if (match?.[1]) {
    try {
      const data = JSON.parse(match[1]);
      if (data?.videoDetail?.itemInfo?.itemStruct) {
        console.log(`[TikTokDirect] ✓ Found api-data with videoDetail.itemInfo.itemStruct`);
        return { json: data.videoDetail as HydrationData, method: 'API_DATA' };
      }
      if (data?.itemInfo?.itemStruct) {
        console.log(`[TikTokDirect] ✓ Found api-data with itemInfo.itemStruct`);
        return { json: data as HydrationData, method: 'API_DATA' };
      }
      // Check for embed page structure
      if (data?.itemModule) {
        console.log(`[TikTokDirect] ✓ Found api-data with itemModule`);
        return { json: data as HydrationData, method: 'API_DATA' };
      }
    } catch { /* parse error — try next method */ }
  }

  // Strategy 2: __UNIVERSAL_DATA_FOR_REHYDRATION__ (desktop video page, legacy)
  match = html.match(/<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>\s*({[\s\S]*?})\s*<\/script>/);
  if (match?.[1]) {
    try {
      const data = JSON.parse(match[1]);
      const defaultScope = data?.__DEFAULT_SCOPE__;
      if (defaultScope) {
        // Check multiple possible keys for video data
        const videoKeys = [
          'webapp.video-detail',
          'webapp.video-page',
          'webapp.video-detail-page',
          'video-detail',
          'video-page',
        ];
        for (const key of videoKeys) {
          const videoDetail = defaultScope[key];
          if (videoDetail?.itemInfo?.itemStruct) {
            console.log(`[TikTokDirect] ✓ Found UNIVERSAL_DATA with ${key}.itemInfo.itemStruct`);
            return { json: videoDetail as HydrationData, method: 'UNIVERSAL_DATA' };
          }
          if (videoDetail?.itemModule) {
            console.log(`[TikTokDirect] ✓ Found UNIVERSAL_DATA with ${key}.itemModule`);
            return { json: videoDetail as HydrationData, method: 'UNIVERSAL_DATA' };
          }
        }
      }
      // Direct itemInfo at root
      if (data?.itemInfo?.itemStruct) {
        console.log(`[TikTokDirect] ✓ Found UNIVERSAL_DATA with root itemInfo.itemStruct`);
        return { json: data as HydrationData, method: 'UNIVERSAL_DATA' };
      }
      if (data?.itemModule) {
        console.log(`[TikTokDirect] ✓ Found UNIVERSAL_DATA with root itemModule`);
        return { json: data as HydrationData, method: 'UNIVERSAL_DATA' };
      }
    } catch { /* parse error — try next method */ }
  }

  // Strategy 3: SIGI_STATE (older TikTok, some regions)
  match = html.match(/<script\s+id="SIGI_STATE"[^>]*>\s*({[\s\S]*?})\s*<\/script>/);
  if (match?.[1]) {
    try {
      const data = JSON.parse(match[1]);
      if (data?.ItemModule) {
        console.log(`[TikTokDirect] ✓ Found SIGI_STATE with ItemModule`);
        return { json: { itemModule: data.ItemModule } as HydrationData, method: 'SIGI_STATE' };
      }
    } catch { /* parse error — try next method */ }
  }

  // Strategy 4: __NEXT_DATA__ (server-rendered pages, some regions)
  match = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>\s*({[\s\S]*?})\s*<\/script>/);
  if (match?.[1]) {
    try {
      const data = JSON.parse(match[1]);
      const props = data?.props?.pageProps;
      if (props?.itemInfo?.itemStruct) {
        console.log(`[TikTokDirect] ✓ Found NEXT_DATA with pageProps.itemInfo.itemStruct`);
        return { json: props as HydrationData, method: 'NEXT_DATA' };
      }
      if (props?.itemModule) {
        console.log(`[TikTokDirect] ✓ Found NEXT_DATA with pageProps.itemModule`);
        return { json: props as HydrationData, method: 'NEXT_DATA' };
      }
    } catch { /* parse error */ }
  }

  // Strategy 5: Embed page often has simpler structure - check for itemModule directly in api-data
  // This is a more aggressive search for embed pages
  match = html.match(/<script\s+id="api-data"[^>]*>\s*({[\s\S]*?})\s*<\/script>/);
  if (match?.[1]) {
    try {
      const data = JSON.parse(match[1]);
      // Embed page might have itemModule directly
      if (data?.itemModule) {
        console.log(`[TikTokDirect] ✓ Found embed api-data with itemModule`);
        return { json: data as HydrationData, method: 'API_DATA_EMBED' };
      }
    } catch { /* parse error */ }
  }

  // Strategy 6: Regex fallback — scan for playAddr/downloadAddr anywhere in scripts
  const playAddrMatch = html.match(/"playAddr"\s*:\s*"(https?:[^"]+)"/);
  const downloadAddrMatch = html.match(/"downloadAddr"\s*:\s*"(https?:[^"]+)"/);
  console.log(`[TikTokDirect]   Regex fallback: playAddr=${!!playAddrMatch} downloadAddr=${!!downloadAddrMatch}`);
  if (playAddrMatch?.[1] || downloadAddrMatch?.[1]) {
    const video: any = {};
    if (playAddrMatch?.[1]) video.playAddr = [{ src: playAddrMatch[1].replace(/\\u002F/g, '/') }];
    if (downloadAddrMatch?.[1]) video.downloadAddr = [{ src: downloadAddrMatch[1].replace(/\\u002F/g, '/') }];

    const coverMatch = html.match(/"cover"\s*:\s*"(https?:[^"]+)"/);
    if (coverMatch?.[1]) video.cover = coverMatch[1].replace(/\\u002F/g, '/');

    const authorMatch = html.match(/"uniqueId"\s*:\s*"([^"]+)"/);
    const nicknameMatch = html.match(/"nickname"\s*:\s*"([^"]+)"/);
    const descMatch = html.match(/"desc"\s*:\s*"([^"]{1,500})"/);

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
  timeoutMs: 18_000, // Increased to allow embed + video page attempts
  retries: 0,
  noRetryStatuses: [403, 404, 451],
  noRetryErrors: ['Cannot extract video ID', 'No hydration data found'],

  async fetch(resolvedUrl: string) {
    const videoId = extractVideoId(resolvedUrl);
    if (!videoId) throw new Error('Cannot extract video ID');
    console.log(`[TikTokDirect] ▶ Starting fetch for videoId=${videoId}`);

    const hydration = await fetchHydrationData(resolvedUrl);
    if (!hydration) throw new Error('No hydration data found in TikTok page (tried embed and video pages)');

    console.log(`[TikTokDirect]   Hydration method=${hydration.method} from ${hydration.url}, extracting item...`);
    const item = extractItemFromJson(hydration.json, videoId);
    if (!item) {
      const scope = (hydration.json as any)?.__DEFAULT_SCOPE__ ?? {};
      console.log(`[TikTokDirect] ✗ No item for videoId=${videoId} — scope keys=${Object.keys(scope).join(',')} itemModule keys=${Object.keys((hydration.json as any)?.itemModule || {}).join(',')}`);
      throw new Error(`No item found for videoId=${videoId} (method=${hydration.method})`);
    }
    console.log(`[TikTokDirect] ✓ Found item: title="${item.desc?.substring(0, 60)}" hasPlayAddr=${!!item.video?.playAddr} hasDownloadAddr=${!!item.video?.downloadAddr}`);

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
      originCover: video.originCover ?? null,
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