import { memoSWR } from './cache';
import { fetchFacebookWithYtDlp, fetchFacebookAudioWithYtDlp } from './ytdlp';

const MEDIA_TTL_MS = 12 * 60 * 60 * 1000;
const MEDIA_STALE_MS = 12 * 60 * 60 * 1000;

const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface FacebookMedia {
  title: string;
  cover: string;
  duration: number;
  hdUrl: string | null;
  sdUrl: string | null;
  author: { name: string; avatar: string };
  like_count: number;
  comment_count: number;
  share_count: number;
  view_count: number;
}

export interface FacebookAudioResult {
  url: string;
  ext: string;
}

/** Error codes thrown by the extraction layer (mapped to user messages by the API). */
export const FB_ERR = {
  LOGIN_REQUIRED: 'facebook_login_required',
  NOT_AVAILABLE: 'facebook_not_available',
  NO_MEDIA: 'facebook_no_media',
  INVALID_RESPONSE: 'facebook_invalid_response',
  TIMEOUT: 'facebook_timeout',
} as const;

function coded(message: string, code: string): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

function unescapeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
  }
}

function getMetaContent(html: string, property: string): string {
  const pattern = new RegExp(
    `<meta\\s+property="${property}"\\s+content="([^"]*)"|<meta\\s+content="([^"]*)"\\s+property="${property}"`,
    'i'
  );
  const m = html.match(pattern);
  return m ? (m[1] || m[2] || '') : '';
}

function htmlTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].replace(/\s*\|\s*Facebook.*$/i, '').trim() : '';
}

function thumbnailUriFromHtml(html: string): string {
  const match = html.match(/"preferred_thumbnail"\s*:\s*\{[\s\S]*?"uri"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return match ? unescapeJsonString(match[1]) : '';
}

/**
 * Parse the JSON blobs Facebook embeds in every video page. These carry the
 * real SD ("playable_url") and HD ("playable_url_quality_hd") download links.
 */
function extractMediaFromPageHtml(html: string): Partial<FacebookMedia> | null {
  if (html.length < 500) return null;

  const jsonStr = (key: string): string | null => {
    const m = html.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? unescapeJsonString(m[1]) : null;
  };

  const hdUrl = jsonStr('playable_url_quality_hd');
  const sdUrl = jsonStr('playable_url');
  if (!hdUrl && !sdUrl) return null;

  const cover = thumbnailUriFromHtml(html) || getMetaContent(html, 'og:image') || '';

  const durationMatch = html.match(/"video_duration"\s*:\s*(\d+(?:\.\d+)?)/);
  const duration = durationMatch ? Number(durationMatch[1]) || 0 : 0;

  let title =
    getMetaContent(html, 'og:title') ||
    getMetaContent(html, 'og:video:title') ||
    htmlTitle(html) ||
    'Facebook Video';

  const authorMatch = html.match(/"pageName"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const authorName = authorMatch ? unescapeJsonString(authorMatch[1]) : '';

  const likeMatch = html.match(/"video_like_count"\s*:\s*(\d+)/);
  const commentMatch = html.match(/"video_comment_count"\s*:\s*(\d+)/);
  const shareMatch = html.match(/"video_share_count"\s*:\s*(\d+)/);
  const viewMatch = html.match(/"video_view_count"\s*:\s*(\d+)/);

  return {
    title,
    cover,
    duration,
    hdUrl,
    sdUrl,
    author: { name: authorName, avatar: cover },
    like_count: likeMatch ? Number(likeMatch[1]) : 0,
    comment_count: commentMatch ? Number(commentMatch[1]) : 0,
    share_count: shareMatch ? Number(shareMatch[1]) : 0,
    view_count: viewMatch ? Number(viewMatch[1]) : 0,
  };
}

/**
 * Decode the base64url "efg" payload FB appends to its CDN streams. It carries
 * the real duration ("duration_s") that the plugin config otherwise omits.
 */
function durationFromEmbedConfig(html: string): number {
  const candidates = html.matchAll(/&efg=([A-Za-z0-9_-]+)/g);
  for (const match of candidates) {
    let b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    try {
      const parsed = JSON.parse(atob(b64));
      if (typeof parsed?.duration_s === 'number') return parsed.duration_s;
    } catch {
      // try the next efg payload
    }
  }
  return 0;
}

/**
 * Fallback: the embed plugin page embeds the player config ("videoData") with
 * direct progressive MP4 links ("hd_src"/"sd_src"). Older variants only expose
 * og:video/og:image meta. Works even when the main page is login-walled.
 */
function extractMediaFromEmbedHtml(html: string): Partial<FacebookMedia> | null {
  if (html.length < 100) return null;

  const jsonStr = (key: string): string | null => {
    const m = html.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? unescapeJsonString(m[1]) : null;
  };

  const hdSrc = jsonStr('hd_src');
  const sdSrc = jsonStr('sd_src');
  const ogVideo =
    getMetaContent(html, 'og:video:secure_url') ||
    getMetaContent(html, 'og:video:url') ||
    getMetaContent(html, 'og:video');

  const http = (u: string | null): string | null => (u && u.startsWith('http') ? u : null);
  const hdUrl = http(hdSrc) || http(sdSrc) || http(ogVideo);
  const sdUrl = http(sdSrc) || http(hdSrc) || http(ogVideo);
  if (!hdUrl && !sdUrl) return null;

  // The plugin page carries no og meta, but its markup links out to the
  // watch page with the real post title and the page slug/name.
  const titleMatch = html.match(/watch\/\?ref=embed_video[^>]*>([^<\\]{2,300})/);
  const titleFromMarkup = titleMatch ? titleMatch[1].trim() : '';
  const title = titleFromMarkup || getMetaContent(html, 'og:title') || htmlTitle(html) || 'Facebook Video';

  const authorMatch = html.match(/href="\\?\/watch\\?\/([^"\/?\\]+)\/?\?ref=embed_video"[^>]*>([^<\\]{1,200})/);
  const authorName = authorMatch ? authorMatch[2].trim() : '';

  const ogImage = getMetaContent(html, 'og:image');
  const image = http(ogImage) || '';

  // The plugin avatar ships at 40px; request a larger size from the CDN.
  const avatarMatch = html.match(/<img[^>]*src="(https:\\?\/\\?\/scontent[^"]*)"/);
  const avatarRaw = avatarMatch ? avatarMatch[1].replace(/\\\//g, '/').replace(/&amp;/g, '&') : '';
  const avatar = /s\d+x\d+/.test(avatarRaw) ? avatarRaw.replace(/s\d+x\d+/, 's320x320') : avatarRaw;

  return {
    title,
    cover: image,
    duration: durationFromEmbedConfig(html),
    hdUrl,
    sdUrl,
    author: { name: authorName, avatar },
    like_count: 0,
    comment_count: 0,
    share_count: 0,
    view_count: 0,
  };
}

/**
 * Best-effort metadata probe of the desktop page. The mobile page is sometimes
 * flag-walled (HTTP 400 shell) where the desktop page still renders fully; this
 * recovers the real cover ("preferred_thumbnail") and page name for the embed
 * fallback. Never throws — the embed result stands on its own.
 */
async function fetchDesktopPageMeta(url: string): Promise<Partial<FacebookMedia> | null> {
  let html: string;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA_DESKTOP,
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    html = await resp.text();
  } catch {
    return null;
  }
  if (html.length < 500) return null;

  const cover = thumbnailUriFromHtml(html) || getMetaContent(html, 'og:image') || '';
  if (!cover) return null;

  const pageNameMatch = html.match(/"pageName"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const authorName = pageNameMatch ? unescapeJsonString(pageNameMatch[1]) : '';

  const ogTitle = getMetaContent(html, 'og:title') || '';
  const title =
    ogTitle
      .replace(/^\s*[\d.,]+\s*[KMB]?\s*(views|plays|reactions|likes)(\s*·\s*[\d.,]+\s*[KMB]?\s*(reactions|likes))?\s*\|\s*/i, '')
      .replace(/\s*\|\s*Facebook\s*$/i, '')
      .trim() || '';

  return {
    title,
    cover,
    author: { name: authorName, avatar: cover },
  };
}

function detectUnavailable(html: string, finalUrl: string): string | null {
  if (/\/login(\/|$)/.test(finalUrl)) return FB_ERR.LOGIN_REQUIRED;
  const markers = [
    "content isn't available",
    "content is not available",
    "This video is no longer available",
    "This video isn't available",
    "isn't available right now",
    "may have been removed",
    "The link you followed may be broken",
  ];
  const lower = html.toLowerCase();
  for (const marker of markers) {
    if (lower.includes(marker)) return FB_ERR.NOT_AVAILABLE;
  }
  return null;
}

async function fetchPage(url: string): Promise<{ html: string; finalUrl: string }> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        'User-Agent': UA_MOBILE,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw coded('The server took too long to reach Facebook.', FB_ERR.TIMEOUT);
    }
    throw err;
  }

  const finalUrl = resp.url || url;
  if (resp.status === 404) {
    throw coded('This video was not found.', FB_ERR.NOT_AVAILABLE);
  }
  if (!resp.ok && resp.status >= 500) {
    throw coded('Facebook could not be reached right now.', FB_ERR.INVALID_RESPONSE);
  }

  const html = await resp.text();
  const unavailable = detectUnavailable(html, finalUrl);
  if (unavailable) throw coded('This video is private or was deleted.', unavailable);

  if (html.length < 500) {
    throw coded('Facebook returned an empty page.', FB_ERR.INVALID_RESPONSE);
  }

  return { html, finalUrl };
}

async function fetchEmbed(url: string): Promise<Partial<FacebookMedia>> {
  const embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(
    url
  )}&show_text=false`;

  const resp = await fetch(embedUrl, {
    headers: {
      'User-Agent': UA_DESKTOP,
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });

  const html = await resp.text();
  const media = extractMediaFromEmbedHtml(html);
  if (!media) {
    throw coded('This video may be private or was deleted.', FB_ERR.NOT_AVAILABLE);
  }
  return media;
}

/** Resolve fb.watch short links to their final Facebook page URL. */
async function resolveShortUrl(url: string): Promise<string> {
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': UA_DESKTOP },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok || !resp.url) {
    throw coded('That Facebook short link could not be resolved.', FB_ERR.INVALID_RESPONSE);
  }
  return resp.url;
}

/**
 * Fetch metadata + download links for a public Facebook video.
 * Tries the video page markup first, then the embed plugin page, then yt-dlp.
 */
export async function fetchFacebookMedia(inputUrl: string): Promise<FacebookMedia> {
  return memoSWR(`fb:media:${inputUrl}`, MEDIA_TTL_MS, MEDIA_STALE_MS, async () => {
    let pageUrl = inputUrl;
    if (/^\s*https?:\/\/fb\.watch\//i.test(inputUrl)) {
      pageUrl = await resolveShortUrl(inputUrl);
    }

    const errors: string[] = [];

    try {
      const { html } = await fetchPage(pageUrl);
      const media = extractMediaFromPageHtml(html);
      if (media?.hdUrl || media?.sdUrl) {
        return {
          title: media.title ?? 'Facebook Video',
          cover: media.cover ?? '',
          duration: media.duration ?? 0,
          hdUrl: media.hdUrl ?? null,
          sdUrl: media.sdUrl ?? null,
          author: { name: media.author?.name ?? '', avatar: media.author?.avatar ?? '' },
          like_count: media.like_count ?? 0,
          comment_count: media.comment_count ?? 0,
          share_count: media.share_count ?? 0,
          view_count: media.view_count ?? 0,
        };
      }
      errors.push('Page markup contained no playable URLs.');
    } catch (err: any) {
      if (err?.code === FB_ERR.NOT_AVAILABLE || err?.code === FB_ERR.LOGIN_REQUIRED) throw err;
      errors.push(err?.message || 'Page fetch failed.');
    }

    try {
      const [embed, extra] = await Promise.all([
        fetchEmbed(pageUrl),
        fetchDesktopPageMeta(pageUrl).catch(() => null),
      ]);
      const title = (embed.title && embed.title !== 'Facebook Video' ? embed.title : extra?.title) || 'Facebook Video';
      const cover = embed.cover || extra?.cover || '';
      return {
        title,
        cover,
        duration: embed.duration ?? 0,
        hdUrl: embed.hdUrl ?? null,
        sdUrl: embed.sdUrl ?? null,
        author: {
          name: embed.author?.name || extra?.author?.name || '',
          avatar: embed.author?.avatar || cover || '',
        },
        like_count: 0,
        comment_count: 0,
        share_count: 0,
        view_count: 0,
      };
    } catch (err: any) {
      errors.push(err?.message || 'Embed fetch failed.');
    }

    try {
      return await fetchFacebookWithYtDlp(inputUrl);
    } catch (err: any) {
      errors.push(err?.message || 'yt-dlp failed.');
    }

    const last = errors[errors.length - 1] || 'Could not load this video.';
    if (last.toLowerCase().includes('private') || last.toLowerCase().includes('deleted')) {
      throw coded('This video is private or was deleted.', FB_ERR.NOT_AVAILABLE);
    }
    throw coded('Could not load this Facebook video.', FB_ERR.NO_MEDIA);
  });
}

/** Best-effort audio track extraction (yt-dlp bestaudio). */
export async function fetchFacebookAudio(inputUrl: string): Promise<FacebookAudioResult | null> {
  try {
    const audio = await fetchFacebookAudioWithYtDlp(inputUrl);
    if (!audio?.url) return null;
    return { url: audio.url, ext: audio.ext && audio.ext !== 'unknown' ? audio.ext : 'm4a' };
  } catch {
    return null;
  }
}