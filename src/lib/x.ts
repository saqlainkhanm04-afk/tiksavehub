import { memoSWR } from './cache';

const FETCH_TIMEOUT_MS = 15_000;
const META_TTL_MS = 6 * 60 * 60 * 1000;
const META_STALE_MS = 6 * 60 * 60 * 1000;

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

async function abortFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  return null;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await abortFetch(url, init, timeoutMs);
      if (resp.status !== 429) return resp;
      const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'));
      const backoffMs = retryAfterMs ?? Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
      const jitterMs = Math.floor(backoffMs * 0.1 * Math.random());
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs + jitterMs);
        continue;
      }
      return resp;
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      if (attempt < MAX_RETRIES) {
        const backoffMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
        await sleep(backoffMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label}: retries exhausted`);
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

export async function fetchTweetMeta(_tweetUrl: string, tweetId: string): Promise<XTweetMeta> {
  const cacheKey = `x:tweet:${tweetId}`;
  return memoSWR<XTweetMeta>(cacheKey, META_TTL_MS, META_STALE_MS, async () => {
    const pageResult = await fetchFromTweetPage(tweetId);
    if (pageResult && pageResult.variants.length > 0) return pageResult;

    const embedResult = await fetchFromEmbed(tweetId);
    if (embedResult && embedResult.variants.length > 0) return embedResult;

    throw new Error(
      'Could not extract video from this tweet. The tweet may be private, deleted, or contain no video.'
    );
  });
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
