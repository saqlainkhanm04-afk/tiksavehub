/**
 * Fast Facebook Story Downloader API
 *
 * Three-tier extraction pipeline:
 * 1. Hitube.io API (RSA-signed, ~2s) - third-party API with their own FB sessions
 * 2. Our own fast extraction (single web.facebook.com fetch, ~4s)
 * 3. Our full fallback pipeline (8-parallel-fetch, ~8s)
 *
 * POST /api/facebook-story
 * Body: { url: string }
 * Response: { success, data: { video_hd, video_sd, thumbnail, title, segments[] } }
 * Error: { success: false, error: string, errorType: "private"|"expired"|"invalid"|"timeout" }
 */
import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { parseFacebookUrl } from '../../lib/facebook-url';
import {
  fetchFacebookStorySet,
  parseStoryPage,
  detectUnavailable,
  detectLoginWall,
  FB_ERR,
  setFacebookEnv,
} from '../../lib/facebook';
import { isRateLimitedDetailed, clientIpFrom } from '../../lib/rate-limit';
import { getEnv, initRequestEnv, type CfEnv } from '../../lib/init-env';

export const prerender = false;

// --- Constants ---
const FAST_TIMEOUT_MS = 4_000;
const HITUBE_TIMEOUT_MS = 6_000;
const FALLBACK_TIMEOUT_MS = 8_000;
const MAX_POST_BODY_BYTES = 4096;
const CACHE_TTL_SECONDS = 300; // 5 minutes
const CACHE_BUCKET_MS = 300_000; // 5-minute bucket for cache key auto-expiry
const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

// --- Hitube.io API (FvidGo backend) ---
const HITUBE_API = 'https://api.hitube.io';
const HITUBE_FB_STORY = '/st-tik-video/fb/dl2';

function getHitubeRsaKey(env: CfEnv): string {
  const key = env.FB_RSA_PUBLIC_KEY;
  if (typeof key === 'string' && key.length > 0) return key;
  throw new Error('FB_RSA_PUBLIC_KEY is not set in the server environment. Add it to .env or wrangler.toml secrets.');
}

function generateHitubeSignature(env: CfEnv): string {
  const rsaKey = getHitubeRsaKey(env);
  const encrypted = crypto.publicEncrypt(
    { key: rsaKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(Date.now().toString())
  );
  return Buffer.from(encrypted).toString('base64');
}

/** Hitube.io API response shape (from reverse engineering). */
interface HitubeFbStoryItem {
  id: string;
  url: string;          // JWT token for the download URL
  size: string;
  type: string;         // "mp4", "jpg", "mp3"
  author: string | null;
  cover: string;        // JWT token for cover image
  thumb: string;
  originalUrl: string;  // Direct CDN URL
  originalCover: string; // Direct CDN cover URL
  tag: string | null;   // "HD", "SD", or null
  desc: string | null;
  duration: string | null;
  hasMultiResolution: boolean;
  multiResolutions?: Array<{
    url: string;
    originalUrl: string;
    type: string;
    size: string;
    tag: string | null;
    default: boolean;
  }>;
}

interface HitubeFbStoryResponse {
  code: number;
  msg: string;
  result: {
    count: number;
    fbBos: HitubeFbStoryItem[];
  };
}

// --- Cheerio (optional, graceful fallback) ---
let cheerioLoad: ((html: string) => any) | null = null;
try {
  const cheerio = await import('cheerio');
  cheerioLoad = cheerio.load;
  console.error('[fb-story] Cheerio loaded successfully');
} catch (err) {
  console.error('[fb-story] Cheerio unavailable, using regex-only extraction:', err);
}

// --- Cache helpers ---
function getStoryCacheKey(url: string): string | null {
  const id = extractStoryId(url);
  if (!id) return null;
  const bucket = Math.floor(Date.now() / CACHE_BUCKET_MS);
  return `story_${id}_v${bucket}`;
}

function getCache(): Cache | null {
  try {
    if (typeof caches !== 'undefined') {
      // Cloudflare Workers expose caches.default; standard TS types don't include it.
      return (caches as any).default as Cache | undefined || null;
    }
  } catch {
    // caches API not available (local dev)
  }
  return null;
}

async function cacheGet(cache: Cache | null, key: string): Promise<Response | null> {
  if (!cache || !key) return null;
  try {
    const hit = await cache.match(key);
    return hit || null;
  } catch {
    return null;
  }
}

async function cachePut(cache: Cache | null, key: string, data: unknown): Promise<void> {
  if (!cache || !key) return;
  try {
    const body = JSON.stringify({ success: true, data });
    const resp = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      },
    });
    await cache.put(key, resp);
  } catch {
    // Cache write failed, not critical
  }
}

// --- Response helpers ---
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body: unknown, status: number, cacheStatus?: 'HIT' | 'MISS', origin?: string | null): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...corsHeaders(origin ?? null),
  };
  if (cacheStatus) {
    headers['X-Cache'] = cacheStatus;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(error: string, errorType: string, status = 500, origin?: string | null): Response {
  return json({ success: false, error, errorType }, status, undefined, origin);
}

// --- Story URL helpers ---

/**
 * Extract the numeric story user ID directly from a /stories/ URL.
 * Works even if the token part contains unexpected characters.
 * Returns null if no numeric ID is found after /stories/.
 */
function extractStoryId(url: string): string | null {
  const m = url.match(/\/stories\/(\d{5,20})/);
  return m ? m[1] : null;
}

/**
 * Build a clean /stories/ URL using only the numeric user ID.
 * Strips the Uzpf ticket entirely so Facebook serves the public story page.
 */
function buildCleanStoryUrl(url: string): string | null {
  const id = extractStoryId(url);
  if (!id) return null;
  return `https://www.facebook.com/stories/${id}/`;
}

/**
 * Detect if the URL pattern suggests multiple story segments.
 * Some users paste a link that aggregates several story IDs.
 */
function hasMultipleStorySegments(url: string): boolean {
  const storyIdMatches = url.match(/\/stories\/\d+\//g);
  return !!(storyIdMatches && storyIdMatches.length > 1);
}

// --- Meta tag extraction ---
interface OgTags {
  video: string;
  image: string;
  title: string;
}

function extractOgTagsRegex(html: string): OgTags {
  const metaRe = /<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*?)"/gi;
  const tags: OgTags = { video: '', image: '', title: '' };
  for (const m of html.matchAll(metaRe)) {
    const prop = m[1].toLowerCase();
    const content = m[2];
    if (prop === 'og:video' && content) tags.video = content;
    else if (prop === 'og:image' && content) tags.image = content;
    else if (prop === 'og:title' && content) tags.title = content;
  }
  return tags;
}

function extractOgTagsCheerio(html: string): OgTags {
  if (!cheerioLoad) return extractOgTagsRegex(html);
  try {
    const $ = cheerioLoad(html);
    return {
      video: $('meta[property="og:video"]').attr('content') || '',
      image: $('meta[property="og:image"]').attr('content') || '',
      title: $('meta[property="og:title"]').attr('content') || '',
    };
  } catch (err) {
    console.error('[fb-story] Cheerio parse failed, falling back to regex:', err);
    return extractOgTagsRegex(html);
  }
}

function extractOgTags(html: string): OgTags {
  return cheerioLoad ? extractOgTagsCheerio(html) : extractOgTagsRegex(html);
}

// --- Hitube.io fast path: RSA-signed API call ---
async function hitubeExtract(
  storyUrl: string,
  env: CfEnv
): Promise<{ data?: any; error?: boolean; errorType?: string }> {
  const start = Date.now();
  const sessionId = `hitube.io_${Math.random().toString(36).slice(2, 10)}`;
  const params = new URLSearchParams({ url: storyUrl, sessionid: sessionId });
  const fetchUrl = `${HITUBE_API}${HITUBE_FB_STORY}?${params}`;
  const xSecure = generateHitubeSignature(env);

  let resp: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HITUBE_TIMEOUT_MS);
    resp = await fetch(fetchUrl, {
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://www.fvidgo.com',
        referer: 'https://www.fvidgo.com/',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        'x-secure-message': xSecure,
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err: any) {
    console.error(`[fb-story] Hitube.io error: ${err?.message} (${Date.now() - start}ms)`);
    if (err?.name === 'AbortError') {
      return { error: true, errorType: 'timeout' };
    }
    return { error: true, errorType: 'fallback' };
  }

  if (resp.status !== 200) {
    console.error(`[fb-story] Hitube.io status ${resp.status} (${Date.now() - start}ms)`);
    return { error: true, errorType: 'fallback' };
  }

  const jsonBody = (await resp.json()) as HitubeFbStoryResponse;
  if (jsonBody.code !== 200 || !jsonBody.result?.fbBos?.length) {
    console.error(`[fb-story] Hitube.io no data: code=${jsonBody.code} (${Date.now() - start}ms)`);
    return { error: true, errorType: 'fallback' };
  }

  const story = jsonBody.result.fbBos[0];
  if (!story.originalUrl) {
    console.error(`[fb-story] Hitube.io no originalUrl (${Date.now() - start}ms)`);
    return { error: true, errorType: 'fallback' };
  }

  // Build segments from multiResolutions if available, otherwise single item
  const resolutions = story.multiResolutions || [];
  const videoRes = resolutions.find((r) => r.type === 'mp4' && r.tag === 'HD') || resolutions.find((r) => r.type === 'mp4' && r.default);
  const sdRes = resolutions.find((r) => r.type === 'mp4' && r.tag === 'SD');
  const coverRes = resolutions.find((r) => r.type === 'jpg');

  // If multiple stories (count > 1), we need to fetch each one.
  // For now, handle the single-story case (most common for /stories/ URLs).
  const segments: any[] = [];

  if (jsonBody.result.count > 1 && jsonBody.result.fbBos.length > 1) {
    // Multi-story: each fbBo is a separate story segment
    for (let i = 0; i < jsonBody.result.fbBos.length; i++) {
      const item = jsonBody.result.fbBos[i];
      const itemRes = item.multiResolutions || [];
      const itemHd = itemRes.find((r) => r.type === 'mp4' && (r.tag === 'HD' || r.default));
      const itemSd = itemRes.find((r) => r.type === 'mp4' && r.tag === 'SD');
      segments.push({
        index: i,
        kind: 'video',
        title: item.desc || `Story Video ${i + 1}`,
        cover: item.originalCover || '',
        duration: item.duration ? parseFloat(item.duration) : 0,
        hdplay: itemHd?.originalUrl || item.originalUrl,
        sdplay: itemSd?.originalUrl || item.originalUrl,
        photoUrl: undefined,
        altUrl: undefined,
      });
    }
  } else {
    // Single story
    segments.push({
      index: 0,
      kind: story.type === 'jpg' ? 'photo' : 'video',
      title: story.desc || 'Facebook Story',
      cover: coverRes?.originalUrl || story.originalCover || '',
      duration: story.duration ? parseFloat(story.duration) : 0,
      hdplay: videoRes?.originalUrl || story.originalUrl,
      sdplay: sdRes?.originalUrl || story.originalUrl,
      photoUrl: story.type === 'jpg' ? story.originalUrl : undefined,
      altUrl: undefined,
    });
  }

  console.error(`[fb-story] Hitube.io success: ${segments.length} segment(s) (${Date.now() - start}ms)`);

  return {
    data: {
      title: story.desc || 'Facebook Story',
      thumbnail: coverRes?.originalUrl || story.originalCover || '',
      segments,
      segmentCount: segments.length,
    },
  };
}

// --- Fast path: single fetch to web.facebook.com ---
async function fastExtract(
  inputUrl: string
): Promise<{ data?: any; error?: boolean; errorType?: string }> {
  // Always build a clean /stories/{id}/ URL for the fast path.
  // This strips the Uzpf ticket and uses only the numeric story ID.
  const cleanUrl = buildCleanStoryUrl(inputUrl) || inputUrl;
  const webUrl = cleanUrl.replace(/^https:\/\/[^/]+/, 'https://web.facebook.com');

  let resp: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FAST_TIMEOUT_MS);
    resp = await fetch(webUrl, {
      headers: {
        'User-Agent': UA_MOBILE,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { error: true, errorType: 'timeout' };
    }
    return { error: true, errorType: 'invalid' };
  }

  const html = await resp.text();

  // Check for login wall or unavailable content
  const unavail = detectUnavailable(html, webUrl);
  if (unavail === FB_ERR.LOGIN_REQUIRED) {
    return { error: true, errorType: 'private' };
  }
  if (unavail === FB_ERR.NOT_AVAILABLE) {
    return { error: true, errorType: 'expired' };
  }
  if (detectLoginWall(html)) {
    return { error: true, errorType: 'private' };
  }

  // Parse story segments from data-sjs JSON blobs
  const segments = parseStoryPage(html);
  if (segments.length === 0) {
    return { error: true, errorType: 'invalid' };
  }

  // Multi-segment detection: if fast path found only 1 segment but the URL
  // suggests multiple story IDs, force fallback to the full pipeline.
  if (segments.length === 1 && hasMultipleStorySegments(inputUrl)) {
    console.error('[fb-story] Fast path found 1 segment but URL has multiple IDs, forcing fallback');
    return { error: true, errorType: 'fallback' };
  }

  const og = extractOgTags(html);

  return {
    data: {
      title: og.title || segments[0]?.title || 'Facebook Story',
      thumbnail: og.image || segments[0]?.cover || '',
      segments: segments.map((s, i) => ({
        index: i,
        kind: s.kind,
        title: s.title || (s.kind === 'video' ? `Story Video ${i + 1}` : `Story Photo ${i + 1}`),
        cover: s.cover || og.image || '',
        duration: s.duration || 0,
        hdplay: s.hdUrl,
        sdplay: s.sdUrl,
        photoUrl: s.photoUrl,
        altUrl: s.altUrl,
      })),
      segmentCount: segments.length,
    },
  };
}

// --- Main POST handler ---
export const POST: APIRoute = async (ctx) => {
  const { request } = ctx;
  const env = getEnv(ctx);
  setFacebookEnv(env);
  initRequestEnv(env);
  const origin = request.headers.get('origin');

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  // Parse body
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_POST_BODY_BYTES) {
    return errorResponse('Request body is too large.', 'invalid', 413, origin);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse(
      'Invalid request body. Please send a JSON object with a "url" field.',
      'invalid',
      400,
      origin
    );
  }

  const rawUrl = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!rawUrl) {
    return errorResponse(
      'Please paste a Facebook story link.',
      'invalid',
      400,
      origin
    );
  }

  // Validate URL format
  const parsed = parseFacebookUrl(rawUrl);
  if (!parsed.isValid || parsed.linkType !== 'story') {
    return errorResponse(
      'That does not look like a Facebook story link. Please use a direct story link like facebook.com/stories/...',
      'invalid',
      422,
      origin
    );
  }

  // Build the cleanest possible /stories/ URL for fetching.
  const storyUrl =
    parsed.storiesUrl ||
    buildCleanStoryUrl(rawUrl) ||
    buildCleanStoryUrl(parsed.sanitizedUrl) ||
    parsed.sanitizedUrl;
  console.error(`[fb-story] Processing: ${storyUrl} (original: ${rawUrl})`);

  // --- Cache check (numeric story ID, 5-minute bucket) ---
  const cacheKey = getStoryCacheKey(storyUrl);
  const cache = getCache();

  if (!cache) {
    console.error('[fb-story] Cache unavailable in local dev, skipping');
  }

  const cached = await cacheGet(cache, cacheKey!);
  if (cached) {
    // Cache HIT: return immediately, do NOT count toward rate limit
    console.error(`[fb-story] Cache HIT: ${cacheKey}`);
    return json(await cached.json(), 200, 'HIT', origin);
  }

  // --- Rate limit (only on cache MISS, since cached responses skip upstream APIs) ---
  const ip = clientIpFrom(request);
  const rateResult = isRateLimitedDetailed(ip);
  if (rateResult.limited) {
    const retryAfter = rateResult.retryAfter || 60;
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Too many requests. Please wait a minute and try again.',
        errorType: 'rate_limit',
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'Access-Control-Allow-Origin': origin || '*',
        },
      }
    );
  }

  let cacheStatus: 'HIT' | 'MISS' = 'MISS';

  // === FAST PATH 1: Hitube.io API (RSA-signed, ~2s) ===
  try {
    const hitube = await hitubeExtract(storyUrl, env);

    if (hitube.data) {
      await cachePut(cache, cacheKey!, hitube.data);
      console.error(`[fb-story] Hitube.io path succeeded: ${hitube.data.segmentCount} segment(s)`);
      return json({ success: true, data: hitube.data }, 200, cacheStatus, origin);
    }
  } catch (err: any) {
    console.error('[fb-story] Hitube.io path exception:', err?.message);
  }

  // === FAST PATH 2: Our own single-fetch extraction (~4s) ===
  try {
    const fast = await fastExtract(storyUrl);

    if (fast.data) {
      await cachePut(cache, cacheKey!, fast.data);
      console.error(`[fb-story] Fast path succeeded: ${fast.data.segmentCount} segment(s)`);
      return json({ success: true, data: fast.data }, 200, cacheStatus, origin);
    }

    // Fast path returned a specific error (not fallback)
    if (fast.error && fast.errorType && fast.errorType !== 'fallback') {
      const messages: Record<string, string> = {
        private:
          'This story is private. Only public stories can be downloaded. Try a different public story link.',
        expired:
          'This story has expired. Facebook stories disappear after 24 hours. Check if the user saved it to their Highlights.',
        invalid:
          'Could not read story data from that link. Please use a direct story link like facebook.com/stories/USER_ID/STORY_ID.',
        timeout:
          'The request took too long to complete. Facebook may be slow right now. Please try again in a few seconds.',
      };
      // Never cache errors
      return errorResponse(
        messages[fast.errorType] || 'Something went wrong. Please try again.',
        fast.errorType,
        fast.errorType === 'private' ? 403 : fast.errorType === 'expired' ? 404 : 422,
        origin
      );
    }
  } catch (err: any) {
    console.error('[fb-story] Fast path exception:', err?.message);
  }

  // === FALLBACK: Full 8-parallel-fetch pipeline ===
  console.error('[fb-story] Falling back to full extraction pipeline');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT_MS);
    const set = await fetchFacebookStorySet(storyUrl);
    clearTimeout(timer);

    if (!set.segments.length) {
      // Never cache errors
      return errorResponse(
        'Could not find any downloadable media in this story. It may be private, expired, or the link may be incorrect.',
        'invalid',
        422,
        origin
      );
    }

    const data = {
      title: set.title || 'Facebook Story',
      thumbnail: set.cover || '',
      segments: set.segments.map((s, i) => ({
        index: i,
        kind: s.kind,
        title: s.title || (s.kind === 'video' ? `Story Video ${i + 1}` : `Story Photo ${i + 1}`),
        cover: s.cover || set.cover || '',
        duration: s.duration || 0,
        hdplay: s.hdUrl,
        sdplay: s.sdUrl,
        photoUrl: s.photoUrl,
        altUrl: s.altUrl,
      })),
      segmentCount: set.segments.length,
    };

    // Cache successful response
    await cachePut(cache, cacheKey!, data);

    console.error(`[fb-story] Fallback succeeded: ${set.segments.length} segment(s)`);
    return json({ success: true, data }, 200, cacheStatus, origin);
  } catch (err: any) {
    console.error('[fb-story] Fallback error:', err?.message ?? err);

    const code = err?.code ?? '';
    if (code === FB_ERR.LOGIN_REQUIRED) {
      return errorResponse(
        'This story requires a Facebook login to view. It may be from a private or restricted account. Try another public story link.',
        'private',
        403,
        origin
      );
    }
    if (code === FB_ERR.NOT_AVAILABLE) {
      return errorResponse(
        'This story is no longer available. It may have been deleted or expired. Facebook stories disappear after 24 hours.',
        'expired',
        404,
        origin
      );
    }
    if (code === FB_ERR.TIMEOUT || err?.name === 'AbortError') {
      return errorResponse(
        'The request timed out. Facebook may be slow right now. Please try again.',
        'timeout',
        504,
        origin
      );
    }

    console.error(`[fb-story] ${new Date().toISOString()} Error: ${err?.message ?? err}`);
    return errorResponse(
      'Could not load this Facebook story. Please check the link and try again.',
      'invalid',
      500,
      origin
    );
  }
};
