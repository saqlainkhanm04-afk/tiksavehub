import { memoSWR } from './cache';

const FETCH_TIMEOUT_MS = 15_000;
const META_TTL_MS = 6 * 60 * 60 * 1000;
const META_STALE_MS = 6 * 60 * 60 * 1000;

export interface SnapchatMediaMeta {
  mediaId: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  videoUrl: string | null;
  videoHd: string | null;
  videoSd: string | null;
  isStory: boolean;
}

async function abortFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchFromPageData(snapUrl: string): Promise<SnapchatMediaMeta | null> {
  try {
    const resp = await abortFetch(
      snapUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      FETCH_TIMEOUT_MS
    );
    const html = await resp.text();

    const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nextDataMatch) return null;

    const data = JSON.parse(nextDataMatch[1]);
    const spotlightStories = data?.props?.pageProps?.spotlightFeed?.spotlightStories;
    if (!Array.isArray(spotlightStories) || spotlightStories.length === 0) return null;

    let videoUrl: string | null = null;
    let thumbnail: string | null = null;
    let title = 'Snapchat Video';
    let durationMs: number | null = null;

    for (const entry of spotlightStories) {
      const story = entry?.story;
      const snapList = story?.snapList;
      if (!Array.isArray(snapList) || snapList.length === 0) continue;

      const snap = snapList[0];
      const url = snap?.snapUrls?.mediaUrl || entry?.metadata?.videoMetadata?.contentUrl || null;
      if (!url) continue;

      videoUrl = url;
      thumbnail =
        story?.thumbnailUrl?.value ||
        snap?.snapUrls?.mediaPreviewUrl?.value ||
        entry?.metadata?.videoMetadata?.thumbnailUrl ||
        null;
      title =
        entry?.metadata?.videoMetadata?.name ||
        story?.storyTitle ||
        'Snapchat Video';
      const rawDur = entry?.metadata?.videoMetadata?.durationMs;
      durationMs = rawDur ? Number(rawDur) || null : null;
      break;
    }

    if (!videoUrl) return null;

    const idMatch = snapUrl.match(/\/([A-Za-z0-9_-]{4,80})(?:\/|$)/);
    const mediaId = idMatch ? idMatch[1] : '';

    return {
      mediaId,
      title,
      thumbnail,
      duration: durationMs ? durationMs / 1000 : null,
      videoUrl,
      videoHd: videoUrl,
      videoSd: videoUrl,
      isStory: snapUrl.includes('story.snapchat.com'),
    };
  } catch {
    return null;
  }
}

async function fetchFromPage(snapUrl: string): Promise<SnapchatMediaMeta | null> {
  try {
    const resp = await abortFetch(
      snapUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      FETCH_TIMEOUT_MS
    );
    if (!resp.ok) return null;
    const html = await resp.text();

    const videoPatterns = [
      /"videoUrl"\s*:\s*"([^"]+)"/,
      /"video_url"\s*:\s*"([^"]+)"/,
      /property="og:video"\s+content="([^"]+)"/,
      /src="(https?:\/\/[^"]*\.mp4[^"]*)"/,
    ];

    let videoUrl: string | null = null;
    for (const re of videoPatterns) {
      const m = html.match(re);
      if (m) {
        videoUrl = m[1].replace(/\\u003F/g, '?').replace(/\//g, '/');
        break;
      }
    }

    const thumbPatterns = [
      /"thumbnailUrl"\s*:\s*"([^"]+)"/,
      /property="og:image"\s+content="([^"]+)"/,
      /"image"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/,
    ];

    let thumbnail: string | null = null;
    for (const re of thumbPatterns) {
      const m = html.match(re);
      if (m) {
        thumbnail = m[1].replace(/\\u003F/g, '?').replace(/\//g, '/');
        break;
      }
    }

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'Snapchat Video';

    if (!videoUrl) return null;

    const idMatch = snapUrl.match(/\/([A-Za-z0-9_-]{4,40})(?:\/|$)/);
    const mediaId = idMatch ? idMatch[1] : '';

    return {
      mediaId,
      title,
      thumbnail,
      duration: null,
      videoUrl,
      videoHd: videoUrl,
      videoSd: videoUrl,
      isStory: snapUrl.includes('story.snapchat.com'),
    };
  } catch {
    return null;
  }
}

/** Try cobalt API as a fallback for Snapchat */
async function fetchFromCobalt(snapUrl: string, turnstileToken?: string): Promise<SnapchatMediaMeta | null> {
  try {
    const { cobaltExtractVideo } = await import('./cobalt');
    const result = await cobaltExtractVideo(snapUrl, turnstileToken);
    if (!result) return null;

    const idMatch = snapUrl.match(/\/([A-Za-z0-9_-]{4,80})(?:\/|$)/);
    const mediaId = idMatch ? idMatch[1] : '';

    return {
      mediaId,
      title: 'Snapchat Video',
      thumbnail: null,
      duration: null,
      videoUrl: result.url,
      videoHd: result.url,
      videoSd: result.url,
      isStory: snapUrl.includes('story.snapchat.com'),
    };
  } catch {
    return null;
  }
}

export async function fetchSnapchatMedia(snapUrl: string, mediaId: string, turnstileToken?: string): Promise<SnapchatMediaMeta> {
  const cacheKey = `sc:media:${mediaId}`;
  return memoSWR<SnapchatMediaMeta>(cacheKey, META_TTL_MS, META_STALE_MS, async () => {
    const pageDataResult = await fetchFromPageData(snapUrl);
    if (pageDataResult && pageDataResult.videoUrl) return pageDataResult;

    const cobaltResult = await fetchFromCobalt(snapUrl, turnstileToken);
    if (cobaltResult && cobaltResult.videoUrl) return cobaltResult;

    const pageResult = await fetchFromPage(snapUrl);
    if (pageResult && pageResult.videoUrl) return pageResult;

    throw new Error(
      'Could not extract video from this Snapchat link. The content may be private, deleted, or geo-restricted.'
    );
  });
}

/** Watermark removal not available on CF Workers (requires ffmpeg) */
export async function removeSnapchatWatermark(
  _sourceUrl: string,
  _filename: string
): Promise<Response | null> {
  return null;
}
