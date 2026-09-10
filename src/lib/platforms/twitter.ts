/**
 * Twitter/X platform sources — fed into runWithFallback.
 *
 * Sources (in order):
 *  1. Tweet page — direct x.com/i/status/{id} HTML scrape
 *  2. Embed — platform.twitter.com embed page
 */
import type { ApiSource } from '../api-fallback';
import type { MediaMeta } from './types';

const X_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EMBED_HOST = 'https://platform.twitter.com';
const FETCH_TIMEOUT_MS = 15_000;

function unescapeJsonString(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\').replace(/\\u003F/g, '?').replace(/\\u0026/g, '&');
}

function extractVariants(html: string): Array<{ url: string; height: number | null; bitrate: number | null }> {
  const seen = new Set<string>();
  const variants: Array<{ url: string; height: number | null; bitrate: number | null }> = [];
  const urlRegex = /https?:\/\/video\.twimg\.com\/(?:ext_tw_video|amplify_video|tweet_video)\/[^"'\s\\]+\.mp4(?:\\u003F[^"'\s\\]*)?/g;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(html)) !== null) {
    const raw = match[0].replace(/\\u003F/g, '?');
    const clean = raw.split('?')[0];
    if (seen.has(clean)) continue;
    seen.add(clean);
    const dimMatch = clean.match(/\/(\d{3,4})x(\d{3,4})\//);
    variants.push({ url: raw, height: dimMatch ? parseInt(dimMatch[1]) : null, bitrate: null });
  }
  return variants;
}

function extractThumbnail(html: string): string | null {
  for (const re of [/https?:\/\/pbs\.twimg\.com\/media\/[^"'\s\\]+/, /https?:\/\/pbs\.twimg\.com\/card_img\/[^"'\s\\]+/]) {
    const m = html.match(re);
    if (m) return m[0].replace(/\\u003F/g, '?');
  }
  return null;
}

function extractUserProfile(html: string) {
  return {
    username: (html.match(/"screen_name"\s*:\s*"([^"]+)"/) || [])[1] || 'unknown',
    authorName: unescapeJsonString((html.match(/"name"\s*:\s*"([^"]+)"/) || [])[1] || ''),
    authorAvatar: (html.match(/"profile_image_url(?:_https)?"\s*:\s*"([^"]+)"/) || [])[1]?.replace(/\\u003F/g, '?') || null,
  };
}

function pickBest(variants: Array<{ url: string; height: number | null; bitrate: number | null }>, preferHd: boolean) {
  if (variants.length === 0) return null;
  const sorted = [...variants].sort((a, b) => ((b.height || 0) * 1000 + (b.bitrate || 0)) - ((a.height || 0) * 1000 + (a.bitrate || 0)));
  if (preferHd) return sorted[0];
  if (sorted.length <= 2) return sorted[sorted.length - 1];
  const mid = sorted[Math.floor(sorted.length / 2)];
  return (mid && mid.height && mid.height >= 360) ? mid : sorted[sorted.length - 1];
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------------ */
/*  Source 1 — Tweet page                                              */
/* ------------------------------------------------------------------ */
export const xTweetPageSource: ApiSource<string, MediaMeta> = {
  name: 'X-TweetPage',
  timeoutMs: FETCH_TIMEOUT_MS,
  retries: 1,
  noRetryStatuses: [404],
  async fetch(inputUrl: string) {
    const tweetId = inputUrl.match(/\/status\/(\d+)/)?.[1] || inputUrl.match(/\/(\d{10,})/)?.[1];
    if (!tweetId) throw new Error('Cannot extract tweet ID');
    const resp = await fetchWithTimeout(`https://x.com/i/status/${tweetId}`, {
      headers: { 'User-Agent': X_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://x.com/' },
    }, FETCH_TIMEOUT_MS);
    if (!resp.ok) throw new Error(`Tweet page returned ${resp.status}`);
    const html = await resp.text();
    const variants = extractVariants(html);
    if (variants.length === 0) throw new Error('Tweet page contained no video variants');
    return { html, variants, ...extractUserProfile(html), thumbnail: extractThumbnail(html), tweetId };
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.variants?.length) return null;
    const hd = pickBest(raw.variants, true);
    const sd = pickBest(raw.variants, false);
    return {
      platform: 'twitter', type: 'video',
      hdUrl: hd?.url || null, sdUrl: sd?.url || null, wmUrl: null, audioUrl: null,
      cover: raw.thumbnail || null,
      title: (raw.html?.match(/"full_text"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/) || [])[1]
        ? unescapeJsonString((raw.html.match(/"full_text"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/) || [])[1]) : '',
      duration: 0,
      authorName: raw.authorName || '', authorAvatar: raw.authorAvatar || null,
      authorUsername: raw.username || null,
      stats: {
        likes: parseInt((raw.html?.match(/"favorite_count"\s*:\s*(\d+)/) || [])[1] || '0') || null,
        comments: null,
        shares: parseInt((raw.html?.match(/"retweet_count"\s*:\s*(\d+)/) || [])[1] || '0') || null,
        views: parseInt((raw.html?.match(/"play_count"\s*:\s*(\d+)/) || [])[1] || '0') || null,
      },
      sourceUrl: inputUrl, resolvedBy: 'X-TweetPage', resolvedMs: 0,
    };
  },
};

/* ------------------------------------------------------------------ */
/*  Source 2 — Embed page                                              */
/* ------------------------------------------------------------------ */
export const xEmbedSource: ApiSource<string, MediaMeta> = {
  name: 'X-Embed',
  timeoutMs: FETCH_TIMEOUT_MS,
  retries: 1,
  noRetryStatuses: [404],
  async fetch(inputUrl: string) {
    const tweetId = inputUrl.match(/\/status\/(\d+)/)?.[1] || inputUrl.match(/\/(\d{10,})/)?.[1];
    if (!tweetId) throw new Error('Cannot extract tweet ID');
    const resp = await fetchWithTimeout(
      `${EMBED_HOST}/embed/Tweet.html?id=${tweetId}&omit_script=true&dnt=true&embedVersion=edcb`,
      { headers: { 'User-Agent': X_UA, 'Accept': 'text/html,application/xhtml+xml', 'Referer': 'https://x.com/' } },
      FETCH_TIMEOUT_MS,
    );
    if (!resp.ok) throw new Error(`Embed returned ${resp.status}`);
    const html = await resp.text();
    const variants = extractVariants(html);
    if (variants.length === 0) throw new Error('Embed contained no video variants');
    return { variants, ...extractUserProfile(html), thumbnail: extractThumbnail(html), tweetId };
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.variants?.length) return null;
    const hd = pickBest(raw.variants, true);
    const sd = pickBest(raw.variants, false);
    return {
      platform: 'twitter', type: 'video',
      hdUrl: hd?.url || null, sdUrl: sd?.url || null, wmUrl: null, audioUrl: null,
      cover: raw.thumbnail || null, title: '', duration: 0,
      authorName: raw.authorName || '', authorAvatar: raw.authorAvatar || null,
      authorUsername: raw.username || null,
      stats: { likes: null, comments: null, shares: null, views: null },
      sourceUrl: inputUrl, resolvedBy: 'X-Embed', resolvedMs: 0,
    };
  },
};

/** Ordered source list for Twitter/X resolution. */
export function twitterSources(): ApiSource<string, MediaMeta>[] {
  return [xTweetPageSource, xEmbedSource];
}
