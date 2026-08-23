import { memoSWR } from './cache';

const FETCH_TIMEOUT_MS = 15_000;
const META_TTL_MS = 6 * 60 * 60 * 1000;
const META_STALE_MS = 6 * 60 * 60 * 1000;

// Retry / backoff constants for X API rate-limit handling
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;

const X_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const EMBED_HOST = 'https://platform.twitter.com';

export interface XVideoVariant {
  url: string;
  contentType: string;
  bitrate: number | null;
  width: number | null;
  height: number | null;
}

export interface XTweetMeta {
  tweetId: string;
  username: string;
  authorName: string;
  authorAvatar: string | null;
  text: string;
  thumbnail: string | null;
  duration: number | null;
  variants: XVideoVariant[];
  isGif: boolean;
  viewCount: number | null;
  likeCount: number | null;
  retweetCount: number | null;
  createdAt: string | null;
}

function abortFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the Retry-After header from a 429 response.
 * Returns milliseconds to wait, or null if not parseable.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  return null;
}

/**
 * Fetch with exponential backoff on 429 (rate-limit) responses.
 * - Up to MAX_RETRIES retries on 429
 * - Respects Retry-After header from X
 * - Adds jitter to prevent thundering herd
 * - Non-429 errors throw immediately (let caller handle fallback)
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await abortFetch(url, init, timeoutMs);

      if (resp.status !== 429) return resp;

      // 429 — rate limited
      const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'));
      const backoffMs = retryAfterMs ?? Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
      const jitterMs = Math.floor(backoffMs * 0.1 * Math.random());
      const waitMs = backoffMs + jitterMs;

      console.warn(
        `[X] ${label} 429 rate-limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${Math.round(waitMs / 1000)}s…`
      );

      if (attempt < MAX_RETRIES) {
        await sleep(waitMs);
        continue;
      }

      // Exhausted retries — still 429, return the response so caller can decide
      return resp;
    } catch (err: any) {
      // AbortError = timeout — don't retry timeouts, let fallback chain handle it
      if (err?.name === 'AbortError') {
        console.warn(`[X] ${label} timed out after ${timeoutMs}ms, skipping retries`);
        throw err;
      }
      // Network errors — retry once on transient failures
      if (attempt < MAX_RETRIES && isTransientError(err)) {
        const backoffMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
        const jitterMs = Math.floor(backoffMs * 0.1 * Math.random());
        console.warn(
          `[X] ${label} transient error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err?.message}, retrying in ${Math.round((backoffMs + jitterMs) / 1000)}s…`
        );
        await sleep(backoffMs + jitterMs);
        continue;
      }
      throw err;
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError ?? new Error(`${label}: retries exhausted`);
}

function isTransientError(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('enotfound')
  );
}

function unescapeJsonString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\u003F/g, '?')
    .replace(/\\u0026/g, '&');
}

function extractVariants(html: string): XVideoVariant[] {
  const seen = new Set<string>();
  const variants: XVideoVariant[] = [];
  const urlRegex =
    /https?:\/\/video\.twimg\.com\/(?:ext_tw_video|amplify_video|tweet_video)\/[^"'\s\\]+\.mp4(?:\\u003F[^"'\s\\]*)?/g;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(html)) !== null) {
    const raw = match[0].replace(/\\u003F/g, '?');
    const clean = raw.split('?')[0];
    if (seen.has(clean)) continue;
    seen.add(clean);
    const dimMatch = clean.match(/\/(\d{3,4})x(\d{3,4})\//);
    variants.push({
      url: raw,
      contentType: 'video/mp4',
      bitrate: null,
      width: dimMatch ? parseInt(dimMatch[1]) : null,
      height: dimMatch ? parseInt(dimMatch[2]) : null,
    });
  }
  return variants;
}

function extractThumbnail(html: string): string | null {
  const patterns = [
    /https?:\/\/pbs\.twimg\.com\/media\/[^"'\s\\]+/,
    /https?:\/\/pbs\.twimg\.com\/card_img\/[^"'\s\\]+/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[0].replace(/\\u003F/g, '?');
  }
  return null;
}

function extractUserProfile(html: string) {
  const userMatch = html.match(/"screen_name"\s*:\s*"([^"]+)"/);
  const nameMatch = html.match(/"name"\s*:\s*"([^"]+)"/);
  const avatarMatch = html.match(/"profile_image_url(?:_https)?"\s*:\s*"([^"]+)"/);
  return {
    username: userMatch ? userMatch[1] : 'unknown',
    authorName: nameMatch ? unescapeJsonString(nameMatch[1]) : userMatch?.[1] ?? 'unknown',
    authorAvatar: avatarMatch ? avatarMatch[1].replace(/\\u003F/g, '?') : null,
  };
}

function extractTweetText(html: string): string {
  const m = html.match(/"full_text"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
  return m ? unescapeJsonString(m[1]) : '';
}

function extractCounts(html: string) {
  const viewMatch = html.match(/"play_count"\s*:\s*(\d+)/);
  const likeMatch = html.match(/"favorite_count"\s*:\s*(\d+)/);
  const rtMatch = html.match(/"retweet_count"\s*:\s*(\d+)/);
  return {
    viewCount: viewMatch ? parseInt(viewMatch[1]) : null,
    likeCount: likeMatch ? parseInt(likeMatch[1]) : null,
    retweetCount: rtMatch ? parseInt(rtMatch[1]) : null,
  };
}

async function fetchFromTweetPage(tweetId: string): Promise<XTweetMeta | null> {
  try {
    const url = `https://x.com/i/status/${tweetId}`;
    const resp = await fetchWithRetry(
      url,
      {
        headers: {
          'User-Agent': X_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://x.com/',
        },
      },
      FETCH_TIMEOUT_MS,
      'tweet-page'
    );
    if (!resp.ok) return null;
    const html = await resp.text();
    const variants = extractVariants(html);
    if (variants.length === 0) return null;
    const profile = extractUserProfile(html);
    const counts = extractCounts(html);
    return {
      tweetId,
      ...profile,
      text: extractTweetText(html),
      thumbnail: extractThumbnail(html),
      duration: null,
      variants,
      isGif: false,
      ...counts,
      createdAt: null,
    };
  } catch {
    return null;
  }
}

async function fetchFromEmbed(tweetId: string): Promise<XTweetMeta | null> {
  try {
    const url = `${EMBED_HOST}/embed/Tweet.html?id=${tweetId}&omit_script=true&dnt=true&embedVersion=edcb`;
    const resp = await fetchWithRetry(
      url,
      {
        headers: {
          'User-Agent': X_UA,
          'Accept': 'text/html,application/xhtml+xml',
          'Referer': 'https://x.com/',
        },
      },
      FETCH_TIMEOUT_MS,
      'embed'
    );
    if (!resp.ok) return null;
    const html = await resp.text();
    const variants = extractVariants(html);
    if (variants.length === 0) return null;
    const profile = extractUserProfile(html);
    return {
      tweetId,
      ...profile,
      text: extractTweetText(html),
      thumbnail: extractThumbnail(html),
      duration: null,
      variants,
      isGif: false,
      viewCount: null,
      likeCount: null,
      retweetCount: null,
      createdAt: null,
    };
  } catch {
    return null;
  }
}

async function fetchFromYtDlp(tweetUrl: string): Promise<XTweetMeta | null> {
  try {
    const { isYtDlpAvailable } = await import('./ytdlp');
    if (!(await isYtDlpAvailable())) return null;

    const { execFile } = await import('node:child_process');
    const bin = process.env.YTDLP_PATH || 'yt-dlp';
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--no-color',
      '--no-check-certificates',
      '--format',
      'best[protocol!=m3u8][acodec!=none]/best[protocol!=m3u8]/best',
      tweetUrl,
    ];

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        args,
        {
          timeout: 40_000,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        },
        (error, stdout, stderr) => {
          if (error) {
            const raw = (stderr || '').toString().trim();
            const detail = raw.split(/\r?\n/).filter(Boolean).pop() || raw || error.message;
            reject(new Error(detail));
            return;
          }
          resolve(stdout.toString());
        }
      );
    });

    const json = JSON.parse(stdout);
    if (!json) return null;

    const formats: any[] = Array.isArray(json.formats) ? json.formats : [];
    const progressive = formats.filter(
      (f: any) =>
        f.ext === 'mp4' &&
        f.url &&
        f.protocol !== 'm3u8_native' &&
        (f.vcodec || '') !== 'none' &&
        f.video_ext === 'mp4'
    );
    const variants: XVideoVariant[] = progressive.map((f: any) => ({
      url: f.url,
      contentType: 'video/mp4',
      bitrate: f.tbr ?? null,
      width: f.width ?? null,
      height: f.height ?? null,
    }));

    const bestUrl = json.url || (variants.length > 0 ? variants[0].url : null);
    if (!bestUrl && variants.length === 0) return null;

    if (variants.length === 0 && bestUrl) {
      variants.push({
        url: bestUrl,
        contentType: 'video/mp4',
        bitrate: null,
        width: json.width ?? null,
        height: json.height ?? null,
      });
    }

    return {
      tweetId: json.id || '',
      username: json.uploader_id || json.channel || 'unknown',
      authorName: json.uploader || json.channel || 'unknown',
      authorAvatar: json.thumbnail || null,
      text: json.title || json.description || '',
      thumbnail: json.thumbnail || null,
      duration: json.duration ?? null,
      variants,
      isGif: false,
      viewCount: json.view_count ?? null,
      likeCount: null,
      retweetCount: null,
      createdAt: json.upload_date ?? null,
    };
  } catch {
    return null;
  }
}

export async function fetchTweetMeta(tweetUrl: string, tweetId: string): Promise<XTweetMeta> {
  const cacheKey = `x:tweet:${tweetId}`;
  const cached = await memoSWR<XTweetMeta>(cacheKey, META_TTL_MS, META_STALE_MS, async () => {
    const pageResult = await fetchFromTweetPage(tweetId);
    if (pageResult && pageResult.variants.length > 0) return pageResult;

    const embedResult = await fetchFromEmbed(tweetId);
    if (embedResult && embedResult.variants.length > 0) return embedResult;

    const ytdlpResult = await fetchFromYtDlp(tweetUrl);
    if (ytdlpResult && ytdlpResult.variants.length > 0) return ytdlpResult;

    console.warn(`[X] All sources exhausted for tweet ${tweetId}`);

    throw new Error(
      'Could not extract video from this tweet. The tweet may be private, deleted, or contain no video.'
    );
  });
  return cached;
}

export function pickBestVariant(variants: XVideoVariant[], preferHd: boolean): XVideoVariant | null {
  if (variants.length === 0) return null;
  const sorted = [...variants].sort((a, b) => {
    const aScore = (a.height || 0) * 1000 + (a.bitrate || 0);
    const bScore = (b.height || 0) * 1000 + (b.bitrate || 0);
    return bScore - aScore;
  });
  if (preferHd) return sorted[0];
  if (sorted.length <= 2) return sorted[sorted.length - 1];
  const mid = sorted[Math.floor(sorted.length / 2)];
  if (mid && mid.height && mid.height >= 360) return mid;
  return sorted[sorted.length - 1];
}
