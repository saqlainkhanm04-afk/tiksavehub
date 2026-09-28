import type { ApiSource } from '../api-fallback';
import type { MediaMeta } from './types';

const SC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

type RecordValue = Record<string, any>;

function valueOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof (value as RecordValue).value === 'string') {
    return (value as RecordValue).value;
  }
  return null;
}

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === 'object' ? (value as RecordValue) : null;
}

function storyTypeFromSnap(snap: RecordValue, url: string): 'image' | 'video' {
  if (snap.snapMediaType === 0 || snap.snapMediaType === '0') return 'image';
  if (snap.snapMediaType === 1 || snap.snapMediaType === '1') return 'video';
  return /\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(url) ? 'image' : 'video';
}

function isStoryInput(inputUrl: string): boolean {
  try {
    const { hostname, pathname } = new URL(inputUrl);
    if (hostname.toLowerCase() === 'story.snapchat.com') return true;
    return /^\/@[^/]+\/?$/.test(pathname);
  } catch {
    return false;
  }
}

function titleFrom(story: RecordValue, entry: RecordValue | null, inputUrl: string): string {
  return valueOf(entry?.metadata?.videoMetadata?.name)
    || valueOf(story.storyTitle)
    || (inputUrl.includes('story.snapchat.com') ? 'Snapchat Story' : 'Snapchat Video');
}

function candidates(pageProps: RecordValue): Array<{ story: RecordValue; entry: RecordValue | null }> {
  const result: Array<{ story: RecordValue; entry: RecordValue | null }> = [];
  const spotlightStories = pageProps.spotlightFeed?.spotlightStories;
  if (Array.isArray(spotlightStories)) {
    for (const rawEntry of spotlightStories) {
      const entry = asRecord(rawEntry);
      const story = asRecord(entry?.story);
      if (story) result.push({ story, entry });
    }
  }
  const profileStory = asRecord(pageProps.story);
  if (profileStory) result.push({ story: profileStory, entry: null });
  const preselected = asRecord(pageProps.preselectedStory);
  const premiumStory = asRecord(preselected?.premiumStory?.playerStory);
  if (premiumStory) result.push({ story: premiumStory, entry: null });
  const playerStory = asRecord(preselected?.playerStory);
  if (playerStory) result.push({ story: playerStory, entry: null });
  const preselectedStory = asRecord(preselected?.story);
  if (preselectedStory) result.push({ story: preselectedStory, entry: null });
  return result;
}

export const scPageDataSource: ApiSource<string, MediaMeta> = {
  name: 'SC-PageData',
  timeoutMs: 12_000,
  async fetch(snapUrl: string) {
    const resp = await fetch(snapUrl, {
      headers: { 'User-Agent': SC_UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`Snapchat page returned ${resp.status}`);
    const html = await resp.text();
    const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nextDataMatch) throw new Error('No __NEXT_DATA__ found');
    const data = JSON.parse(nextDataMatch[1]);
    const pageProps = asRecord(data?.props?.pageProps);
    if (!pageProps) throw new Error('No Snapchat page data found');
    for (const candidate of candidates(pageProps)) {
      const snapList = Array.isArray(candidate.story.snapList) ? candidate.story.snapList : [];
      for (const rawSnap of snapList) {
        const snap = asRecord(rawSnap);
        const rawUrl = snap?.snapUrls?.mediaUrl || candidate.entry?.metadata?.videoMetadata?.contentUrl;
        const url = valueOf(rawUrl);
        if (!snap || !url) continue;
        const mediaType = storyTypeFromSnap(snap, url);
        const rawDuration = snap.durationInSec ?? snap.durationMs ?? candidate.entry?.metadata?.videoMetadata?.durationMs;
        return {
          mediaUrl: url,
          mediaType,
          videoUrl: mediaType === 'video' ? url : null,
          thumbnail: valueOf(candidate.story.thumbnailUrl)
            || valueOf(snap.snapUrls?.mediaPreviewUrl)
            || valueOf(candidate.entry?.metadata?.videoMetadata?.thumbnailUrl)
            || (mediaType === 'image' ? url : null),
          title: titleFrom(candidate.story, candidate.entry, snapUrl),
          durationMs: rawDuration != null ? (Number(rawDuration) > 100 ? Number(rawDuration) : Number(rawDuration) * 1000) : null,
          isStory: isStoryInput(snapUrl) || (candidate.story.storyType === 16 && /\/p\//.test(snapUrl)),
        };
      }
    }
    throw new Error('No media URL found in Snapchat page data');
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.mediaUrl) return null;
    const idMatch = inputUrl.match(/\/(?:p|s|spotlight)\/([A-Za-z0-9_-]{4,80})(?:\/|$)/);
    const isImage = raw.mediaType === 'image';
    const isStory = Boolean(raw.isStory);
    return {
      platform: 'snapchat',
      type: isStory ? 'story' : isImage ? 'photo' : 'video',
      hdUrl: raw.mediaUrl,
      sdUrl: raw.mediaUrl,
      wmUrl: null,
      audioUrl: null,
      cover: raw.thumbnail || null,
      title: raw.title || 'Snapchat Video',
      duration: raw.durationMs ? Number(raw.durationMs) / 1000 : 0,
      authorName: '',
      authorAvatar: null,
      authorUsername: idMatch?.[1] || null,
      stats: { likes: null, comments: null, shares: null, views: null },
      sourceUrl: inputUrl,
      resolvedBy: 'SC-PageData',
      resolvedMs: 0,
    };
  },
};

export function scCobaltSource(turnstileToken?: string): ApiSource<string, MediaMeta> {
  return {
    name: 'SC-Cobalt',
    timeoutMs: 12_000,
    async fetch(snapUrl: string) {
      if (!turnstileToken) throw new Error('No turnstile token');
      const { cobaltExtractVideo } = await import('../cobalt');
      const result = await cobaltExtractVideo(snapUrl, turnstileToken);
      if (!result?.url) throw new Error('Cobalt returned no URL');
      return result;
    },
    normalize(raw: any, inputUrl: string): MediaMeta | null {
      if (!raw?.url) return null;
      const idMatch = inputUrl.match(/\/(?:p|s|spotlight)\/([A-Za-z0-9_-]{4,80})(?:\/|$)/);
      return {
        platform: 'snapchat',
        type: isStoryInput(inputUrl) || /\/(?:s|p)\//.test(inputUrl) ? 'story' : 'video',
        hdUrl: raw.url,
        sdUrl: raw.url,
        wmUrl: null,
        audioUrl: null,
        cover: null,
        title: 'Snapchat Video',
        duration: 0,
        authorName: '',
        authorAvatar: null,
        authorUsername: idMatch?.[1] || null,
        stats: { likes: null, comments: null, shares: null, views: null },
        sourceUrl: inputUrl,
        resolvedBy: 'SC-Cobalt',
        resolvedMs: 0,
      };
    },
  };
}

export const scPageHtmlSource: ApiSource<string, MediaMeta> = {
  name: 'SC-PageHTML',
  timeoutMs: 12_000,
  async fetch(snapUrl: string) {
    const resp = await fetch(snapUrl, {
      headers: { 'User-Agent': SC_UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`Snapchat page returned ${resp.status}`);
    const html = await resp.text();
    const mediaMatch = html.match(/"mediaUrl"\s*:\s*"([^"]+)"|"videoUrl"\s*:\s*"([^"]+)"|"video_url"\s*:\s*"([^"]+)"|property="og:video"\s+content="([^"]+)"|src="(https?:\/\/[^"]*\.mp4[^"]*)"/);
    const mediaUrl = mediaMatch?.[1] || mediaMatch?.[2] || mediaMatch?.[3] || mediaMatch?.[4] || mediaMatch?.[5];
    if (!mediaUrl) throw new Error('No media URL found in page HTML');
    const mediaType = /"snapMediaType"\s*:\s*0/.test(html) || /\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(mediaUrl) ? 'image' : 'video';
    const thumbMatch = html.match(/"thumbnailUrl"\s*:\s*"([^"]+)"|property="og:image"\s+content="([^"]+)"/);
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return {
      mediaUrl,
      mediaType,
      videoUrl: mediaType === 'video' ? mediaUrl : null,
      thumbnail: thumbMatch?.[1] || thumbMatch?.[2] || null,
      title: titleMatch?.[1]?.trim() || 'Snapchat Video',
      isStory: isStoryInput(snapUrl) || /\/(?:s|p)\//.test(snapUrl),
    };
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.mediaUrl) return null;
    const idMatch = inputUrl.match(/\/(?:p|s|spotlight)\/([A-Za-z0-9_-]{4,80})(?:\/|$)/);
    return {
      platform: 'snapchat',
      type: raw.isStory ? 'story' : raw.mediaType === 'image' ? 'photo' : 'video',
      hdUrl: raw.mediaUrl,
      sdUrl: raw.mediaUrl,
      wmUrl: null,
      audioUrl: null,
      cover: raw.thumbnail || null,
      title: raw.title || 'Snapchat Video',
      duration: 0,
      authorName: '',
      authorAvatar: null,
      authorUsername: idMatch?.[1] || null,
      stats: { likes: null, comments: null, shares: null, views: null },
      sourceUrl: inputUrl,
      resolvedBy: 'SC-PageHTML',
      resolvedMs: 0,
    };
  },
};

export function snapchatSources(turnstileToken?: string): ApiSource<string, MediaMeta>[] {
  return [scPageDataSource, scCobaltSource(turnstileToken), scPageHtmlSource];
}
