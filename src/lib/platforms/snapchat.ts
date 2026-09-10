/**
 * Snapchat platform sources — fed into runWithFallback.
 *
 * Sources (in order):
 *  1. Page Data — __NEXT_DATA__ JSON extraction from the snap page
 *  2. Cobalt — cobalt.tools extraction pipeline
 *  3. Page HTML — regex scan for video URLs in the page source
 */
import type { ApiSource } from '../api-fallback';
import type { MediaMeta } from './types';

const SC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/*  Source 1 — Page Data (__NEXT_DATA__)                                */
/* ------------------------------------------------------------------ */
export const scPageDataSource: ApiSource<string, MediaMeta> = {
  name: 'SC-PageData',
  timeoutMs: 12_000,
  async fetch(snapUrl: string) {
    const resp = await fetch(snapUrl, {
      headers: { 'User-Agent': SC_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(10_000),
    });
    const html = await resp.text();
    const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nextDataMatch) throw new Error('No __NEXT_DATA__ found');
    const data = JSON.parse(nextDataMatch[1]);
    const spotlightStories = data?.props?.pageProps?.spotlightFeed?.spotlightStories;
    if (!Array.isArray(spotlightStories) || spotlightStories.length === 0) throw new Error('No spotlight stories found');
    for (const entry of spotlightStories) {
      const story = entry?.story;
      const snapList = story?.snapList;
      if (!Array.isArray(snapList) || snapList.length === 0) continue;
      const snap = snapList[0];
      const url = snap?.snapUrls?.mediaUrl || entry?.metadata?.videoMetadata?.contentUrl;
      if (!url) continue;
      return {
        videoUrl: url,
        thumbnail: story?.thumbnailUrl?.value || snap?.snapUrls?.mediaPreviewUrl?.value || null,
        title: entry?.metadata?.videoMetadata?.name || story?.storyTitle || 'Snapchat Video',
        durationMs: entry?.metadata?.videoMetadata?.durationMs || null,
        isStory: snapUrl.includes('story.snapchat.com'),
      };
    }
    throw new Error('No video URL found in spotlight stories');
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.videoUrl) return null;
    const idMatch = inputUrl.match(/\/([A-Za-z0-9_-]{4,80})(?:\/|$)/);
    return {
      platform: 'snapchat', type: raw.isStory ? 'story' : 'video',
      hdUrl: raw.videoUrl, sdUrl: raw.videoUrl, wmUrl: null, audioUrl: null,
      cover: raw.thumbnail || null, title: raw.title || 'Snapchat Video',
      duration: raw.durationMs ? raw.durationMs / 1000 : 0,
      authorName: '', authorAvatar: null, authorUsername: idMatch?.[1] || null,
      stats: { likes: null, comments: null, shares: null, views: null },
      sourceUrl: inputUrl, resolvedBy: 'SC-PageData', resolvedMs: 0,
    };
  },
};

/* ------------------------------------------------------------------ */
/*  Source 2 — Cobalt                                                  */
/* ------------------------------------------------------------------ */
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
      const idMatch = inputUrl.match(/\/([A-Za-z0-9_-]{4,80})(?:\/|$)/);
      return {
        platform: 'snapchat', type: inputUrl.includes('story.snapchat.com') ? 'story' : 'video',
        hdUrl: raw.url, sdUrl: raw.url, wmUrl: null, audioUrl: null,
        cover: null, title: 'Snapchat Video', duration: 0,
        authorName: '', authorAvatar: null, authorUsername: idMatch?.[1] || null,
        stats: { likes: null, comments: null, shares: null, views: null },
        sourceUrl: inputUrl, resolvedBy: 'SC-Cobalt', resolvedMs: 0,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Source 3 — Page HTML regex                                         */
/* ------------------------------------------------------------------ */
export const scPageHtmlSource: ApiSource<string, MediaMeta> = {
  name: 'SC-PageHTML',
  timeoutMs: 12_000,
  async fetch(snapUrl: string) {
    const resp = await fetch(snapUrl, {
      headers: { 'User-Agent': SC_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`Snapchat page returned ${resp.status}`);
    const html = await resp.text();
    const videoPatterns = [/"videoUrl"\s*:\s*"([^"]+)"/, /"video_url"\s*:\s*"([^"]+)"/, /property="og:video"\s+content="([^"]+)"/, /src="(https?:\/\/[^"]*\.mp4[^"]*)"/];
    let videoUrl: string | null = null;
    for (const re of videoPatterns) {
      const m = html.match(re);
      if (m) { videoUrl = m[1].replace(/\\u003F/g, '?'); break; }
    }
    if (!videoUrl) throw new Error('No video URL found in page HTML');
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const thumbMatch = html.match(/"thumbnailUrl"\s*:\s*"([^"]+)"|property="og:image"\s+content="([^"]+)"/);
    return {
      videoUrl,
      thumbnail: thumbMatch?.[1] || thumbMatch?.[2] || null,
      title: titleMatch?.[1]?.trim() || 'Snapchat Video',
    };
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.videoUrl) return null;
    const idMatch = inputUrl.match(/\/([A-Za-z0-9_-]{4,40})(?:\/|$)/);
    return {
      platform: 'snapchat', type: 'video',
      hdUrl: raw.videoUrl, sdUrl: raw.videoUrl, wmUrl: null, audioUrl: null,
      cover: raw.thumbnail || null, title: raw.title || 'Snapchat Video', duration: 0,
      authorName: '', authorAvatar: null, authorUsername: idMatch?.[1] || null,
      stats: { likes: null, comments: null, shares: null, views: null },
      sourceUrl: inputUrl, resolvedBy: 'SC-PageHTML', resolvedMs: 0,
    };
  },
};

/** Ordered source list for Snapchat resolution. */
export function snapchatSources(turnstileToken?: string): ApiSource<string, MediaMeta>[] {
  return [scPageDataSource, scCobaltSource(turnstileToken), scPageHtmlSource];
}
