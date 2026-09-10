import { memoSWR } from './cache';
import { runWithFallback } from './api-fallback';
import { twitterSources } from './platforms/twitter';
import type { MediaMeta } from './platforms/types';

const META_TTL_MS = 6 * 60 * 60 * 1000;
const META_STALE_MS = 6 * 60 * 60 * 1000;

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

export async function fetchTweetMeta(_tweetUrl: string, tweetId: string): Promise<XTweetMeta> {
  const cacheKey = `x:tweet:${tweetId}`;
  return memoSWR<XTweetMeta>(cacheKey, META_TTL_MS, META_STALE_MS, async () => {
    const result = await runWithFallback(_tweetUrl, twitterSources());
    const m = result.data;

    // Map MediaMeta back to XTweetMeta for API route compatibility
    const variants: XVideoVariant[] = [];
    if (m.hdUrl) {
      const hdMatch = m.hdUrl.match(/\/(\d{3,4})x(\d{3,4})\//);
      variants.push({
        url: m.hdUrl, contentType: 'video/mp4', bitrate: null,
        width: hdMatch ? parseInt(hdMatch[1]) : null, height: hdMatch ? parseInt(hdMatch[2]) : null,
      });
    }
    if (m.sdUrl && m.sdUrl !== m.hdUrl) {
      const sdMatch = m.sdUrl.match(/\/(\d{3,4})x(\d{3,4})\//);
      variants.push({
        url: m.sdUrl, contentType: 'video/mp4', bitrate: null,
        width: sdMatch ? parseInt(sdMatch[1]) : null, height: sdMatch ? parseInt(sdMatch[2]) : null,
      });
    }

    return {
      tweetId,
      username: m.authorUsername || 'unknown',
      authorName: m.authorName || 'unknown',
      authorAvatar: m.authorAvatar || null,
      text: m.title || '',
      thumbnail: m.cover || null,
      duration: m.duration || null,
      variants,
      isGif: false,
      viewCount: m.stats.views ?? null,
      likeCount: m.stats.likes ?? null,
      retweetCount: m.stats.shares ?? null,
      createdAt: null,
    };
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
