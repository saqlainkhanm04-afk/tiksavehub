/**
 * Facebook platform sources — fed into runWithFallback.
 *
 * Sources (in order):
 *  1. Multi-API — third-party downloader APIs (bypasses FB IP blocks)
 *  2. Page HTML — mobile page JSON extraction (playable_url_quality_hd etc.)
 *  3. Embed plugin — videoData hd_src/sd_src extraction
 *  4. Cobalt — cobalt.tools extraction pipeline
 *  5. CDN regex — last-resort regex scan of page HTML for fbcdn URLs
 */
import type { ApiSource } from '../api-fallback';
import type { MediaMeta } from './types';

const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function getMetaContent(html: string, property: string): string {
  const pattern = new RegExp(
    `<meta\\s+property="${property}"\\s+content="([^"]*)"|<meta\\s+content="([^"]*)"\\s+property="${property}"`,
    'i',
  );
  const m = html.match(pattern);
  return m ? (m[1] || m[2] || '') : '';
}

function unescapeJsonString(raw: string): string {
  try { return JSON.parse(`"${raw}"`); }
  catch { return raw.replace(/\\\//g, '/').replace(/\\u0026/g, '&'); }
}

function thumbnailUriFromHtml(html: string): string {
  const match = html.match(/"preferred_thumbnail"\s*:\s*\{[\s\S]*?"uri"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return match ? unescapeJsonString(match[1]) : '';
}

function extractMediaFromPageHtml(html: string): Partial<MediaMeta> | null {
  if (html.length < 500) return null;
  const jsonStr = (key: string): string | null => {
    const m = html.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? unescapeJsonString(m[1]) : null;
  };
  const hdUrl =
    jsonStr('playable_url_quality_hd') || jsonStr('browser_native_hd_url') ||
    jsonStr('hd_src_no_ratelimit') || jsonStr('hd_src');
  const sdUrl =
    jsonStr('playable_url') || jsonStr('browser_native_sd_url') ||
    jsonStr('sd_src_no_ratelimit') || jsonStr('sd_src');
  if (!hdUrl && !sdUrl) return null;
  const cover = thumbnailUriFromHtml(html) || getMetaContent(html, 'og:image') || '';
  const durationMatch = html.match(/"video_duration"\s*:\s*(\d+(?:\.\d+)?)/);
  let title = getMetaContent(html, 'og:title') || getMetaContent(html, 'og:video:title') ||
    html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.replace(/\s*\|\s*Facebook.*$/i, '').trim() || 'Facebook Video';
  const authorMatch = html.match(/"pageName"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return {
    hdUrl, sdUrl, cover, title,
    duration: durationMatch ? Number(durationMatch[1]) || 0 : 0,
    authorName: authorMatch ? unescapeJsonString(authorMatch[1]) : '',
  };
}

function extractMediaFromEmbedHtml(html: string): Partial<MediaMeta> | null {
  if (html.length < 100) return null;
  const jsonStr = (key: string): string | null => {
    const m = html.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? unescapeJsonString(m[1]) : null;
  };
  const hdSrc = jsonStr('hd_src_no_ratelimit') || jsonStr('hd_src');
  const sdSrc = jsonStr('sd_src_no_ratelimit') || jsonStr('sd_src');
  const ogVideo = getMetaContent(html, 'og:video:secure_url') || getMetaContent(html, 'og:video:url') || getMetaContent(html, 'og:video');
  const http = (u: string | null): string | null => u?.startsWith('http') ? u : null;
  const hdUrl = http(hdSrc) || http(sdSrc) || http(ogVideo);
  const sdUrl = http(sdSrc) || http(hdSrc) || http(ogVideo);
  if (!hdUrl && !sdUrl) return null;
  const titleMatch = html.match(/watch\/\?ref=embed_video[^>]*>([^<\\]{2,300})/);
  const title = titleMatch ? titleMatch[1].trim() : getMetaContent(html, 'og:title') || 'Facebook Video';
  const authorMatch = html.match(/href="\\?\/watch\\?\/([^"\/?\\]+)\/?\?ref=embed_video"[^>]*>([^<\\]{1,200})/);
  const avatarMatch = html.match(/<img[^>]*src="(https:\\?\/\\?\/scontent[^"]*)"/);
  const avatarRaw = avatarMatch ? avatarMatch[1].replace(/\\\//g, '/').replace(/&amp;/g, '&') : '';
  const avatar = /s\d+x\d+/.test(avatarRaw) ? avatarRaw.replace(/s\d+x\d+/, 's320x320') : avatarRaw;
  return {
    hdUrl, sdUrl, title,
    cover: getMetaContent(html, 'og:image') || '',
    authorName: authorMatch?.[2]?.trim() || '',
    authorAvatar: avatar,
  };
}

function extractMediaFromCdnRegex(html: string): Partial<MediaMeta> | null {
  if (html.length < 500) return null;
  const patterns = [
    /https?:\/\/video\.[\w.-]*fbcdn\.net\/[^"'\s\\]+\.mp4(?:[^"'\s\\]*)/g,
    /"browser_native_(?:hd|sd)_url"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    /"playable_url(?:_quality_hd)?"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    /"(?:hd|sd)_src(?:_no_ratelimit)?"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
  ];
  const seen = new Set<string>();
  let bestHd: string | null = null;
  let bestSd: string | null = null;
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      let url = (match[1] || match[0]).replace(/\\u003F/g, '?').replace(/\\\//g, '/').replace(/&amp;/g, '&');
      if (!url.startsWith('http')) continue;
      url = url.split('"')[0].split("'")[0].split('\\')[0];
      if (seen.has(url)) continue;
      seen.add(url);
      const isHd = /quality_hd|1080|720|hd_src/i.test(url);
      if (isHd && !bestHd) bestHd = url;
      else if (!bestSd) bestSd = url;
    }
  }
  if (!bestHd && !bestSd) return null;
  return {
    hdUrl: bestHd || bestSd,
    sdUrl: bestSd !== bestHd ? bestSd : null,
    title: getMetaContent(html, 'og:title').replace(/\s*\|\s*Facebook\s*$/i, '').trim() || 'Facebook Video',
    cover: getMetaContent(html, 'og:image') || '',
  };
}

/* ------------------------------------------------------------------ */
/*  Source 1 — Multi-API                                               */
/* ------------------------------------------------------------------ */
export const fbMultiApiSource: ApiSource<string, MediaMeta> = {
  name: 'FB-MultiAPI',
  timeoutMs: 10_000,
  retries: 1,
  noRetryStatuses: [404, 422],
  async fetch(pageUrl: string) {
    const { fetchFacebookMediaViaMultiApi } = await import('../fb-multi-api');
    const result = await fetchFacebookMediaViaMultiApi(pageUrl);
    if (!result?.hdUrl && !result?.sdUrl) throw new Error('Multi-API returned no video URLs');
    return result;
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.hdUrl && !raw?.sdUrl) return null;
    return {
      platform: 'facebook', type: 'video',
      hdUrl: raw.hdUrl ?? null, sdUrl: raw.sdUrl ?? null, wmUrl: null, audioUrl: null,
      cover: raw.cover || '', title: raw.title || 'Facebook Video', duration: raw.duration || 0,
      authorName: raw.author?.name ?? '', authorAvatar: raw.author?.avatar ?? null, authorUsername: null,
      stats: { likes: raw.like_count ?? null, comments: raw.comment_count ?? null, shares: raw.share_count ?? null, views: raw.view_count ?? null },
      sourceUrl: inputUrl, resolvedBy: 'FB-MultiAPI', resolvedMs: 0,
    };
  },
};

/* ------------------------------------------------------------------ */
/*  Source 2 — Page HTML extraction                                     */
/* ------------------------------------------------------------------ */
export const fbPageSource: ApiSource<string, MediaMeta> = {
  name: 'FB-Page',
  timeoutMs: 10_000,
  retries: 1,
  noRetryStatuses: [404],
  async fetch(pageUrl: string) {
    const resp = await fetch(pageUrl, {
      headers: { 'User-Agent': UA_MOBILE, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache' },
      redirect: 'follow', signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) throw new Error(`FB page returned ${resp.status}`);
    const html = await resp.text();
    if (html.length < 500) throw new Error('FB returned empty page');
    const media = extractMediaFromPageHtml(html);
    if (!media?.hdUrl && !media?.sdUrl) throw new Error('Page contained no playable URLs');
    return media;
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.hdUrl && !raw?.sdUrl) return null;
    return {
      platform: 'facebook', type: 'video',
      hdUrl: raw.hdUrl ?? null, sdUrl: raw.sdUrl ?? null, wmUrl: null, audioUrl: null,
      cover: raw.cover || '', title: raw.title || 'Facebook Video', duration: raw.duration || 0,
      authorName: raw.authorName || '', authorAvatar: null, authorUsername: null,
      stats: { likes: null, comments: null, shares: null, views: null },
      sourceUrl: inputUrl, resolvedBy: 'FB-Page', resolvedMs: 0,
    };
  },
};

/* ------------------------------------------------------------------ */
/*  Source 3 — Embed plugin page                                       */
/* ------------------------------------------------------------------ */
export const fbEmbedSource: ApiSource<string, MediaMeta> = {
  name: 'FB-Embed',
  timeoutMs: 10_000,
  retries: 1,
  noRetryStatuses: [404],
  async fetch(pageUrl: string) {
    const embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(pageUrl)}&show_text=false`;
    const resp = await fetch(embedUrl, {
      headers: { 'User-Agent': UA_DESKTOP, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(8_000),
    });
    const html = await resp.text();
    const media = extractMediaFromEmbedHtml(html);
    if (!media?.hdUrl && !media?.sdUrl) throw new Error('Embed returned no media');
    return media;
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.hdUrl && !raw?.sdUrl) return null;
    return {
      platform: 'facebook', type: 'video',
      hdUrl: raw.hdUrl ?? null, sdUrl: raw.sdUrl ?? null, wmUrl: null, audioUrl: null,
      cover: raw.cover || '', title: raw.title || 'Facebook Video', duration: raw.duration || 0,
      authorName: raw.authorName || '', authorAvatar: raw.authorAvatar || null, authorUsername: null,
      stats: { likes: null, comments: null, shares: null, views: null },
      sourceUrl: inputUrl, resolvedBy: 'FB-Embed', resolvedMs: 0,
    };
  },
};

/* ------------------------------------------------------------------ */
/*  Source 4 — Cobalt                                                  */
/* ------------------------------------------------------------------ */
export const fbCobaltSource: ApiSource<string, MediaMeta> = {
  name: 'FB-Cobalt',
  timeoutMs: 10_000,
  retries: 1,
  noRetryStatuses: [404],
  async fetch(pageUrl: string) {
    const { cobaltExtractVideo } = await import('../cobalt');
    const result = await cobaltExtractVideo(pageUrl);
    if (!result?.url) throw new Error('Cobalt returned no URL');
    return result;
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.url) return null;
    return {
      platform: 'facebook', type: 'video',
      hdUrl: raw.url, sdUrl: null, wmUrl: null, audioUrl: null,
      cover: null, title: 'Facebook Video', duration: 0,
      authorName: '', authorAvatar: null, authorUsername: null,
      stats: { likes: null, comments: null, shares: null, views: null },
      sourceUrl: inputUrl, resolvedBy: 'FB-Cobalt', resolvedMs: 0,
    };
  },
};

/* ------------------------------------------------------------------ */
/*  Source 5 — CDN regex (last resort)                                 */
/* ------------------------------------------------------------------ */
export const fbCdnRegexSource: ApiSource<string, MediaMeta> = {
  name: 'FB-CDNRegex',
  timeoutMs: 10_000,
  retries: 1,
  noRetryStatuses: [404],
  async fetch(pageUrl: string) {
    const resp = await fetch(pageUrl, {
      headers: { 'User-Agent': UA_DESKTOP, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) throw new Error(`FB page returned ${resp.status}`);
    const html = await resp.text();
    if (html.length < 500) throw new Error('FB returned empty page');
    const media = extractMediaFromCdnRegex(html);
    if (!media?.hdUrl) throw new Error('CDN regex found no video URLs');
    return media;
  },
  normalize(raw: any, inputUrl: string): MediaMeta | null {
    if (!raw?.hdUrl) return null;
    return {
      platform: 'facebook', type: 'video',
      hdUrl: raw.hdUrl, sdUrl: raw.sdUrl ?? null, wmUrl: null, audioUrl: null,
      cover: raw.cover || '', title: raw.title || 'Facebook Video', duration: raw.duration || 0,
      authorName: raw.authorName || '', authorAvatar: null, authorUsername: null,
      stats: { likes: null, comments: null, shares: null, views: null },
      sourceUrl: inputUrl, resolvedBy: 'FB-CDNRegex', resolvedMs: 0,
    };
  },
};

/** Ordered source list for Facebook video resolution. */
export function facebookSources(): ApiSource<string, MediaMeta>[] {
  return [fbMultiApiSource, fbPageSource, fbEmbedSource, fbCobaltSource, fbCdnRegexSource];
}
