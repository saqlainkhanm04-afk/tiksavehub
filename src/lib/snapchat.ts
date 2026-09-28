import { memoSWR } from './cache';

const FETCH_TIMEOUT_MS = 15_000;
const META_TTL_MS = 6 * 60 * 60 * 1000;
const META_STALE_MS = 6 * 60 * 60 * 1000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export type SnapchatMediaType = 'image' | 'video';

export interface SnapchatMediaMeta {
  mediaId: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  mediaType: SnapchatMediaType;
  mediaUrl: string;
  contentType: string;
  videoUrl: string | null;
  videoHd: string | null;
  videoSd: string | null;
  isStory: boolean;
}

type UnknownRecord = Record<string, any>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function unwrap(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  const record = asRecord(value);
  if (record && typeof record.value === 'string' && record.value.trim()) return record.value;
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const result = unwrap(value);
    if (result) return result;
  }
  return null;
}

function numeric(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function cleanUrl(value: string): string {
  return value
    .replace(/\\u003F/gi, '?')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/');
}

function isStoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase() === 'story.snapchat.com' || /^\/@[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function inputMediaId(value: string): string {
  const match = value.match(/\/(?:p|s)\/([A-Za-z0-9_-]{4,80})(?:\/|$)/);
  if (match) return match[1];
  const profileMatch = value.match(/\/(?:@|u\/)([A-Za-z0-9_.-]{1,30})(?:\/|$)/);
  return profileMatch?.[1] || '';
}

function mediaTypeFromSnap(snap: UnknownRecord, url: string, fallback: SnapchatMediaType): SnapchatMediaType {
  const rawType = snap?.snapMediaType;
  if (rawType === 0 || rawType === '0') return 'image';
  if (rawType === 1 || rawType === '1') return 'video';
  if (/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(url) || /image/i.test(url)) return 'image';
  return fallback;
}

interface StoryCandidate {
  story: UnknownRecord;
  entry: UnknownRecord | null;
  kind: 'spotlight' | 'profile' | 'public';
}

function storyCandidates(pageProps: UnknownRecord): StoryCandidate[] {
  const candidates: StoryCandidate[] = [];
  const spotlightStories = pageProps.spotlightFeed?.spotlightStories;
  if (Array.isArray(spotlightStories)) {
    for (const entry of spotlightStories) {
      const story = asRecord(entry?.story);
      if (story) candidates.push({ story, entry: asRecord(entry), kind: 'spotlight' });
    }
  }

  const profileStory = asRecord(pageProps.story);
  if (profileStory) candidates.push({ story: profileStory, entry: null, kind: 'profile' });

  const preselected = asRecord(pageProps.preselectedStory);
  const premiumPlayerStory = asRecord(preselected?.premiumStory?.playerStory);
  if (premiumPlayerStory) candidates.push({ story: premiumPlayerStory, entry: null, kind: 'public' });
  const preselectedPlayerStory = asRecord(preselected?.playerStory);
  if (preselectedPlayerStory) candidates.push({ story: preselectedPlayerStory, entry: null, kind: 'public' });
  const preselectedStory = asRecord(preselected?.story);
  if (preselectedStory) candidates.push({ story: preselectedStory, entry: null, kind: 'public' });

  return candidates;
}

function extractStoryCandidate(
  snapUrl: string,
  fallbackId: string,
  candidate: StoryCandidate,
  pageProps: UnknownRecord
): SnapchatMediaMeta | null {
  const snapList = Array.isArray(candidate.story.snapList) ? candidate.story.snapList : [];
  for (const rawSnap of snapList) {
    const snap = asRecord(rawSnap);
    if (!snap) continue;
    const rawUrl = snap.snapUrls?.mediaUrl || candidate.entry?.metadata?.videoMetadata?.contentUrl;
    const url = firstString(rawUrl);
    if (!url) continue;

    const mediaUrl = cleanUrl(url);
    const mediaType = mediaTypeFromSnap(snap, mediaUrl, 'video');
    const isStory = candidate.kind !== 'spotlight' || isStoryUrl(snapUrl) || candidate.story.storyType === 16;
    const title =
      firstString(
        candidate.entry?.metadata?.videoMetadata?.name,
        candidate.story.storyTitle,
        pageProps.pageMetadata?.pageTitle,
        pageProps.linkPreview?.title
      ) || (mediaType === 'image' ? 'Snapchat Story Photo' : 'Snapchat Video');
    const thumbnail =
      firstString(
        candidate.story.thumbnailUrl,
        snap.snapUrls?.mediaPreviewUrl,
        candidate.entry?.metadata?.videoMetadata?.thumbnailUrl,
        pageProps.linkPreview?.twitterImage?.url
      ) || (mediaType === 'image' ? mediaUrl : null);
    const rawDuration = numeric(snap.durationInSec ?? snap.durationMs ?? candidate.entry?.metadata?.videoMetadata?.durationMs);
    const mediaId = fallbackId || firstString(snap.snapId, candidate.story.storyId) || '';
    const contentType = mediaType === 'image' ? 'image/jpeg' : 'video/mp4';
    const duration =
      rawDuration == null
        ? null
        : rawDuration > 100
          ? rawDuration / 1000
          : rawDuration;

    return {
      mediaId,
      title,
      thumbnail,
      duration,
      mediaType,
      mediaUrl,
      contentType,
      videoUrl: mediaType === 'video' ? mediaUrl : null,
      videoHd: mediaType === 'video' ? mediaUrl : null,
      videoSd: mediaType === 'video' ? mediaUrl : null,
      isStory,
    };
  }
  return null;
}

async function abortFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchFromPageData(snapUrl: string, fallbackId: string): Promise<SnapchatMediaMeta | null> {
  try {
    const resp = await abortFetch(
      snapUrl,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      FETCH_TIMEOUT_MS
    );
    if (!resp.ok) return null;
    const html = await resp.text();
    const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nextDataMatch) return null;

    const data = JSON.parse(nextDataMatch[1]);
    const pageProps = asRecord(data?.props?.pageProps);
    if (!pageProps) return null;

    for (const candidate of storyCandidates(pageProps)) {
      const result = extractStoryCandidate(snapUrl, fallbackId, candidate, pageProps);
      if (result) return result;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchFromPage(snapUrl: string, fallbackId: string): Promise<SnapchatMediaMeta | null> {
  try {
    const resp = await abortFetch(
      snapUrl,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      FETCH_TIMEOUT_MS
    );
    if (!resp.ok) return null;
    const html = await resp.text();

    const mediaPatterns = [
      /"mediaUrl"\s*:\s*"([^"]+)"/,
      /"videoUrl"\s*:\s*"([^"]+)"/,
      /"video_url"\s*:\s*"([^"]+)"/,
      /property="og:video"\s+content="([^"]+)"/,
      /src="(https?:\/\/[^"]*\.mp4[^"]*)"/,
    ];
    let mediaUrl: string | null = null;
    for (const re of mediaPatterns) {
      const match = html.match(re);
      if (match) {
        mediaUrl = cleanUrl(match[1]);
        break;
      }
    }

    if (!mediaUrl) return null;
    const mediaType: SnapchatMediaType = /"snapMediaType"\s*:\s*0/.test(html) || /\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(mediaUrl)
      ? 'image'
      : 'video';
    const thumbPatterns = [
      /"thumbnailUrl"\s*:\s*"([^"]+)"/,
      /property="og:image"\s+content="([^"]+)"/,
      /"image"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/,
    ];
    let thumbnail: string | null = null;
    for (const re of thumbPatterns) {
      const match = html.match(re);
      if (match) {
        thumbnail = cleanUrl(match[1]);
        break;
      }
    }
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || (mediaType === 'image' ? 'Snapchat Story Photo' : 'Snapchat Video');
    return {
      mediaId: fallbackId || inputMediaId(snapUrl),
      title,
      thumbnail: thumbnail || (mediaType === 'image' ? mediaUrl : null),
      duration: null,
      mediaType,
      mediaUrl,
      contentType: mediaType === 'image' ? 'image/jpeg' : 'video/mp4',
      videoUrl: mediaType === 'video' ? mediaUrl : null,
      videoHd: mediaType === 'video' ? mediaUrl : null,
      videoSd: mediaType === 'video' ? mediaUrl : null,
      isStory: isStoryUrl(snapUrl),
    };
  } catch {
    return null;
  }
}

async function fetchFromCobalt(snapUrl: string, fallbackId: string, turnstileToken?: string): Promise<SnapchatMediaMeta | null> {
  try {
    const { cobaltExtractVideo } = await import('./cobalt');
    const result = await cobaltExtractVideo(snapUrl, turnstileToken);
    if (!result?.url) return null;
    const mediaUrl = cleanUrl(result.url);
    return {
      mediaId: fallbackId || inputMediaId(snapUrl),
      title: 'Snapchat Video',
      thumbnail: null,
      duration: null,
      mediaType: 'video',
      mediaUrl,
      contentType: 'video/mp4',
      videoUrl: mediaUrl,
      videoHd: mediaUrl,
      videoSd: mediaUrl,
      isStory: isStoryUrl(snapUrl),
    };
  } catch {
    return null;
  }
}

export async function fetchSnapchatMedia(snapUrl: string, mediaId: string, turnstileToken?: string): Promise<SnapchatMediaMeta> {
  const cacheKey = `sc:media:${mediaId || inputMediaId(snapUrl)}`;
  return memoSWR<SnapchatMediaMeta>(cacheKey, META_TTL_MS, META_STALE_MS, async () => {
    const fallbackId = mediaId || inputMediaId(snapUrl);
    const pageDataResult = await fetchFromPageData(snapUrl, fallbackId);
    if (pageDataResult) return pageDataResult;

    const cobaltResult = await fetchFromCobalt(snapUrl, fallbackId, turnstileToken);
    if (cobaltResult) return cobaltResult;

    const pageResult = await fetchFromPage(snapUrl, fallbackId);
    if (pageResult) return pageResult;

    throw new Error(
      'Could not extract media from this Snapchat link. The content may be private, deleted, or geo-restricted.'
    );
  });
}

export async function removeSnapchatWatermark(
  _sourceUrl: string,
  _filename: string
): Promise<Response | null> {
  return null;
}
