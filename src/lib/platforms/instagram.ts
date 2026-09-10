/**
 * Instagram platform sources — fed into runWithFallback.
 *
 * Sources (in order):
 *  1. Multi-API — third-party downloader APIs (bypasses IG IP blocks)
 *  2. GraphQL shortcode — public GraphQL with fresh CSRF
 *  3. Embed page — lightweight OG meta extraction
 *  4. __a=1 — legacy endpoint with session cookies
 *  5. GraphQL anonymous — session-free CSRF fallback
 */
import type { ApiSource } from '../api-fallback';
import type { MediaMeta } from './types';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const INSTAGRAM_GRAPHQL = 'https://www.instagram.com/graphql/query';
const SHORTCODE_DOC_ID = '27128499623469141';

function getMetaContent(html: string, property: string): string {
  const pattern = new RegExp(
    `<meta\\s+property="${property}"\\s+content="([^"]*)"|<meta\\s+content="([^"]*)"\\s+property="${property}"`,
    'i',
  );
  const m = html.match(pattern);
  return m ? (m[1] || m[2] || '') : '';
}

function extractMediaFromEmbedHtml(html: string): { videoUrl: string | null; cover: string | null; title: string } | null {
  if (html.length < 100) return null;
  const video =
    getMetaContent(html, 'og:video') ||
    getMetaContent(html, 'og:video:secure_url') ||
    getMetaContent(html, 'twitter:player:stream');
  const image = getMetaContent(html, 'og:image') || getMetaContent(html, 'twitter:image');
  const title = getMetaContent(html, 'og:title');
  if (!video && !image) return null;
  return { videoUrl: video, cover: image || null, title };
}

/* ------------------------------------------------------------------ */
/*  Source 1 — Multi-API (third-party downloader services)             */
/* ------------------------------------------------------------------ */
export function igMultiApiSource(shortcode: string, type: string): ApiSource<string, MediaMeta> {
  return {
    name: 'IG-MultiAPI',
    timeoutMs: 10_000,
    retries: 1,
    noRetryStatuses: [404, 422],
    async fetch(igUrl: string) {
      const { fetchInstagramViaMultiApi } = await import('../ig-multi-api');
      const result = await fetchInstagramViaMultiApi(igUrl);
      if (!result?.videoUrl) throw new Error('Multi-API returned no video URL');
      return result;
    },
    normalize(raw: any, inputUrl: string): MediaMeta | null {
      if (!raw?.videoUrl) return null;
      return {
        platform: 'instagram',
        type: type === 'reels' ? 'reels' : type === 'story' ? 'story' : 'video',
        hdUrl: raw.videoUrl,
        sdUrl: null,
        wmUrl: null,
        audioUrl: null,
        cover: raw.cover || null,
        title: raw.title || '',
        duration: raw.duration || 0,
        authorName: raw.author?.name ?? '',
        authorAvatar: raw.author?.avatar ?? null,
        authorUsername: null,
        stats: { likes: null, comments: null, shares: null, views: null },
        sourceUrl: inputUrl,
        resolvedBy: 'IG-MultiAPI',
        resolvedMs: 0,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Source 2 — GraphQL shortcode                                       */
/* ------------------------------------------------------------------ */
export function igGraphqlSource(shortcode: string, csrfToken?: string, cookies?: string): ApiSource<string, MediaMeta> {
  return {
    name: 'IG-GraphQL',
    timeoutMs: 8_000,
    retries: 1,
    noRetryStatuses: [404],
    async fetch(_inputUrl: string) {
      const headers: Record<string, string> = {
        'User-Agent': DESKTOP_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-IG-App-ID': '936619743392459',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://www.instagram.com',
        Referer: 'https://www.instagram.com/',
      };
      if (csrfToken) headers['X-CSRFToken'] = csrfToken;
      if (cookies) headers['Cookie'] = cookies;

      const variables = JSON.stringify({ shortcode });
      const body = `variables=${encodeURIComponent(variables)}&doc_id=${SHORTCODE_DOC_ID}&server_timestamps=true`;
      const resp = await fetch(INSTAGRAM_GRAPHQL, { method: 'POST', headers, body, signal: AbortSignal.timeout(7_000) });
      if (!resp.ok) throw new Error(`GraphQL returned ${resp.status}`);
      const json: any = await resp.json();
      const items = json?.data?.xdt_api__v1__media__shortcode__web_info?.items;
      if (!items || items.length === 0) throw new Error('GraphQL returned no items');
      return items[0];
    },
    normalize(raw: any, inputUrl: string): MediaMeta | null {
      if (!raw) return null;
      const videoVersions = raw.video_versions || raw.video_versions_web;
      const videoUrl = videoVersions?.sort?.((a: any, b: any) => (b.width || 0) - (a.width || 0))?.[0]?.url;
      const cover = raw.image_versions2?.candidates?.[0]?.url || raw.display_url || null;
      if (!videoUrl && !cover) return null;
      return {
        platform: 'instagram',
        type: 'video',
        hdUrl: videoUrl || null,
        sdUrl: null,
        wmUrl: null,
        audioUrl: null,
        cover,
        title: raw.display_title || '',
        duration: raw.video_duration || 0,
        authorName: raw.user?.full_name ?? '',
        authorAvatar: raw.user?.profile_pic_url ?? null,
        authorUsername: raw.user?.username ?? null,
        stats: {
          likes: raw.like_count ?? null,
          comments: raw.comment_count ?? null,
          shares: null,
          views: raw.play_count ?? null,
        },
        sourceUrl: inputUrl,
        resolvedBy: 'IG-GraphQL',
        resolvedMs: 0,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Source 3 — Embed page (OG meta)                                    */
/* ------------------------------------------------------------------ */
export const igEmbedSource: ApiSource<string, MediaMeta> = {
  name: 'IG-Embed',
  timeoutMs: 8_000,
  retries: 1,
  noRetryStatuses: [404],
  async fetch(inputUrl: string) {
    const shortcode = inputUrl.match(/\/(?:p|reel|reels|tv)\/([^/]+)/)?.[1];
    if (!shortcode) throw new Error('Cannot extract shortcode for embed');
    const paths = [
      `https://www.instagram.com/reel/${shortcode}/embed/captioned/`,
      `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
    ];
    let lastError: any = null;
    for (const path of paths) {
      try {
        const resp = await fetch(path, {
          headers: { 'User-Agent': DESKTOP_UA, Accept: 'text/html,application/xhtml+xml,*/*' },
          redirect: 'follow',
          signal: AbortSignal.timeout(7_000),
        });
        if (!resp.ok) { lastError = new Error(`Embed ${resp.status}`); continue; }
        const html = await resp.text();
        const media = extractMediaFromEmbedHtml(html);
        if (media) return media;
        lastError = new Error('Embed returned no media');
      } catch (err) { lastError = err; }
    }
    throw lastError || new Error('Embed fallback failed');
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.videoUrl && !raw?.cover) return null;
    return {
      platform: 'instagram',
      type: 'video',
      hdUrl: raw.videoUrl || null,
      sdUrl: null,
      wmUrl: null,
      audioUrl: null,
      cover: raw.cover,
      title: raw.title || '',
      duration: 0,
      authorName: '',
      authorAvatar: null,
      authorUsername: null,
      stats: { likes: null, comments: null, shares: null, views: null },
      sourceUrl: inputUrl,
      resolvedBy: 'IG-Embed',
      resolvedMs: 0,
    };
  },
};

/* ------------------------------------------------------------------ */
/*  Source 4 — __a=1 legacy endpoint                                   */
/* ------------------------------------------------------------------ */
export function igLegacySource(sessionCookie?: string): ApiSource<string, MediaMeta> {
  return {
    name: 'IG-Legacy-a1',
    timeoutMs: 8_000,
    retries: 1,
    noRetryStatuses: [404, 403],
    async fetch(inputUrl: string) {
      const shortcode = inputUrl.match(/\/(?:p|reel|reels|tv)\/([^/]+)/)?.[1];
      if (!shortcode) throw new Error('Cannot extract shortcode for __a=1');
      const headers: Record<string, string> = {
        'User-Agent': DESKTOP_UA,
        Accept: 'application/json, text/html, text/plain, */*',
        'X-IG-App-ID': '936619743392459',
        'X-Requested-With': 'XMLHttpRequest',
      };
      if (sessionCookie) headers.Cookie = sessionCookie;

      const urls = [
        `https://www.instagram.com/reel/${shortcode}/?__a=1`,
        `https://www.instagram.com/p/${shortcode}/?__a=1`,
      ];
      let lastError: any = null;
      for (const a1Url of urls) {
        try {
          const resp = await fetch(a1Url, { headers, redirect: 'follow', signal: AbortSignal.timeout(7_000) });
          if (!resp.ok) { lastError = new Error(`__a=1 returned ${resp.status}`); continue; }
          const text = await resp.text();
          // Try JSON parse
          try {
            const json = JSON.parse(text);
            const media = json?.graphql?.shortcode_media ?? json?.items?.[0];
            if (media) return media;
          } catch { /* not JSON — try HTML extraction */ }
          // HTML fallback: extract video_versions JSON blob
          const vvMatch = text.match(/"video_versions"\s*:\s*(\[[^\]]*\])/);
          if (vvMatch) {
            const versions = JSON.parse(vvMatch[1].replace(/\\\//g, '/'));
            if (Array.isArray(versions) && versions.length > 0) {
              const sorted = [...versions].sort((a: any, b: any) => (b.width || 0) - (a.width || 0));
              const videoUrl = sorted[0]?.url?.replace(/\\\//g, '/');
              if (videoUrl) return { video_versions: sorted, display_url: '' };
            }
          }
          lastError = new Error('__a=1 returned no media');
        } catch (err) { lastError = err; }
      }
      throw lastError || new Error('__a=1 failed');
    },
    normalize(raw: any, inputUrl: string): MediaMeta | null {
      if (!raw) return null;
      const videoVersions = raw.video_versions;
      const videoUrl = videoVersions?.sort?.((a: any, b: any) => (b.width || 0) - (a.width || 0))?.[0]?.url;
      const cover = raw.image_versions2?.candidates?.[0]?.url || raw.display_url || null;
      if (!videoUrl) return null;
      return {
        platform: 'instagram',
        type: 'video',
        hdUrl: videoUrl,
        sdUrl: null,
        wmUrl: null,
        audioUrl: null,
        cover: cover || null,
        title: raw.display_title || '',
        duration: raw.video_duration || 0,
        authorName: raw.user?.full_name ?? '',
        authorAvatar: raw.user?.profile_pic_url ?? null,
        authorUsername: raw.user?.username ?? null,
        stats: { likes: null, comments: null, shares: null, views: null },
        sourceUrl: inputUrl,
        resolvedBy: 'IG-Legacy-a1',
        resolvedMs: 0,
      };
    },
  };
}

/** Ordered source list for Instagram resolution. */
export function instagramSources(shortcode: string, type: string, csrfToken?: string, cookies?: string, sessionCookie?: string): ApiSource<string, MediaMeta>[] {
  return [
    igMultiApiSource(shortcode, type),
    igGraphqlSource(shortcode, csrfToken, cookies),
    igEmbedSource,
    igLegacySource(sessionCookie),
  ];
}
