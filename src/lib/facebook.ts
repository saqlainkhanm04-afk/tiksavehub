import { memoSWR } from './cache';
import { type CfEnv, envStr } from './env';
import {
  type PhotoCandidate,
  MIN_FULL_PHOTO_SCORE,
  stripCtpCap,
  isNonPhotoAssetUrl,
  promotePhotoUrl,
  photoQualityScore,
  cdnPathOf,
  isThumbOnly,
  enforcePhotoQuality,
} from './facebook-photo-quality';

const MEDIA_TTL_MS = 12 * 60 * 60 * 1000;
const MEDIA_STALE_MS = 12 * 60 * 60 * 1000;

const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

let _env: CfEnv = {};
export function setFacebookEnv(env: CfEnv) { _env = env; }

function getFbCookie(): string {
  return envStr(_env, 'FB_COOKIES');
}

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

export interface FacebookPhoto {
  title: string;
  cover: string;
  photoUrl: string;
  /** Un-promoted CDN URL — safe fallback when the promoted URL is refused (signed/locked tokens). */
  altUrl?: string;
  author: { name: string; avatar: string };
}

/** A photo candidate as found on the page: the promoted URL plus its raw original. */
export type { PhotoCandidate } from './facebook-photo-quality';

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

  const hdUrl =
    jsonStr('playable_url_quality_hd') ||
    jsonStr('browser_native_hd_url') ||
    jsonStr('hd_src_no_ratelimit') ||
    jsonStr('hd_src');
  const sdUrl =
    jsonStr('playable_url') ||
    jsonStr('browser_native_sd_url') ||
    jsonStr('sd_src_no_ratelimit') ||
    jsonStr('sd_src');
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

  // Prefer the no-ratelimit variants: same rendition, but not subject to the
  // bandwidth throttling FB applies to hd_src/sd_src — faster, more reliable
  // downloads. og:video is a last-resort progressive from the page meta.
  const hdSrc = jsonStr('hd_src_no_ratelimit') || jsonStr('hd_src');
  const sdSrc = jsonStr('sd_src_no_ratelimit') || jsonStr('sd_src');
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
  const lower = html.toLowerCase();
  if (
    lower.includes('url=/login/?next=') ||
    lower.includes('url=/login/?') ||
    lower.includes('log into facebook') ||
    lower.includes('you must log in to continue') ||
    lower.includes('log in to facebook to continue') ||
    lower.includes('password</') ||
    lower.includes('action="/login')
  ) {
    return FB_ERR.LOGIN_REQUIRED;
  }
  const markers = [
    "content isn't available",
    "content is not available",
    "This video is no longer available",
    "This video isn't available",
    "isn't available right now",
    "may have been removed",
    "The link you followed may be broken",
  ];
  for (const marker of markers) {
    if (lower.includes(marker)) return FB_ERR.NOT_AVAILABLE;
  }
  return null;
}

const VIDEO_PAGE_TIMEOUT_MS = 8_000;
const MAX_VIDEO_HTML_BYTES = 2_500_000;

async function fetchPage(url: string, ua: string = UA_MOBILE): Promise<{ html: string; finalUrl: string }> {
  let resp: Response;
  const cookie = getFbCookie();
  try {
    resp = await fetch(url, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        ...(cookie ? { 'Cookie': cookie } : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(VIDEO_PAGE_TIMEOUT_MS),
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

  const { text: html } = await readBoundedText(resp.body, MAX_VIDEO_HTML_BYTES);
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

  const cookie = getFbCookie();
  const resp = await fetch(embedUrl, {
    headers: {
      'User-Agent': UA_DESKTOP,
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(cookie ? { 'Cookie': cookie } : {}),
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
 * Pipeline is PARALLEL where it matters: the page markup wins fast on healthy
 * IPs; when it is shelled (flagged/throttled IPs), the embed plugin page and
 * the yt-dlp fallback run at the same time so the slowest single source
 * bounds the total (was: sequential page → embed → yt-dlp).
 *
 * Multi-layer fallback:
 *   Layer 1: page HTML + embed plugin (parallel with grace window)
 *   Layer 2: cobalt.tools video extraction (when page+embed both fail)
 *   Layer 3: direct CDN regex extraction from page HTML (last resort)
 */
export async function fetchFacebookMedia(inputUrl: string): Promise<FacebookMedia> {
  return memoSWR(`fb:media:${inputUrl}`, MEDIA_TTL_MS, MEDIA_STALE_MS, async () => {
    let pageUrl = inputUrl;
    if (/^\s*https?:\/\/fb\.watch\//i.test(inputUrl)) {
      pageUrl = await resolveShortUrl(inputUrl);
    }

    const errors: string[] = [];

    // ─── Layer 1: page HTML + embed plugin (parallel) ───────────────────
    const pageTask = (async () => {
      try {
        const { html } = await fetchPage(pageUrl);
        const media = extractMediaFromPageHtml(html);
        if (media?.hdUrl || media?.sdUrl) return { media, html };
        errors.push('Page markup contained no playable URLs.');
        return null;
      } catch (err: any) {
        errors.push(err?.message || 'Page fetch failed.');
        return null;
      }
    })();

    const pageGate = pageTask.then(
      (m) => ({ done: Boolean(m) }),
      () => {
        throw null;
      }
    );
    const startWhenPageDelays = <T,>(delayMs: number, task: () => Promise<T | null>): Promise<T | null> =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (v: T | null) => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        const timer = setTimeout(() => {
          task().then(finish, () => finish(null));
        }, delayMs);
        pageGate.then((g) => {
          clearTimeout(timer);
          if (g.done) finish(null);
          else task().then(finish, () => finish(null));
        }).catch(() => {
          clearTimeout(timer);
          task().then(finish, () => finish(null));
        });
      });

    const embedTask = startWhenPageDelays(2000, async () => {
      try {
        const [embed, extra] = await Promise.all([
          fetchEmbed(pageUrl),
          fetchDesktopPageMeta(pageUrl).catch(() => null),
        ]);
        if (!embed.hdUrl && !embed.sdUrl) return null;
        return {
          title: (embed.title && embed.title !== 'Facebook Video' ? embed.title : extra?.title) || 'Facebook Video',
          cover: embed.cover || extra?.cover || '',
          duration: embed.duration ?? 0,
          hdUrl: embed.hdUrl ?? null,
          sdUrl: embed.sdUrl ?? null,
          author: {
            name: embed.author?.name || extra?.author?.name || '',
            avatar: embed.author?.avatar || embed.cover || extra?.cover || '',
          },
        };
      } catch (err: any) {
        errors.push(err?.message || 'Embed fetch failed.');
        return null;
      }
    });

    const [pageResult, embedResult] = await Promise.allSettled([pageTask, embedTask]);

    // Page succeeded with media — return immediately (fast path).
    if (pageResult.status === 'fulfilled' && pageResult.value) {
      const { media } = pageResult.value;
      let cover = media.cover ?? '';
      if (!cover) {
        const embedMedia = embedResult.status === 'fulfilled' ? embedResult.value : null;
        cover = embedMedia?.cover || '';
        if (!cover) {
          try {
            const extra = await fetchDesktopPageMeta(pageUrl);
            cover = extra?.cover || '';
          } catch { /* best effort */ }
        }
      }
      return {
        title: media.title ?? 'Facebook Video',
        cover,
        duration: media.duration ?? 0,
        hdUrl: media.hdUrl ?? null,
        sdUrl: media.sdUrl ?? null,
        author: { name: media.author?.name ?? '', avatar: media.author?.avatar ?? cover },
        like_count: media.like_count ?? 0,
        comment_count: media.comment_count ?? 0,
        share_count: media.share_count ?? 0,
        view_count: media.view_count ?? 0,
      };
    }

    // Page failed but embed succeeded — return embed result.
    if (pageResult.status === 'rejected') {
      const winner = embedResult.status === 'fulfilled' ? embedResult.value : null;
      if (winner) {
        return {
          title: winner.title || 'Facebook Video',
          cover: winner.cover ?? '',
          duration: winner.duration ?? 0,
          hdUrl: winner.hdUrl ?? null,
          sdUrl: winner.sdUrl ?? null,
          author: { name: winner.author?.name ?? '', avatar: winner.author?.avatar || winner.cover || '' },
          like_count: 0,
          comment_count: 0,
          share_count: 0,
          view_count: 0,
        };
      }
    }

    // Page returned null (no media) but embed succeeded.
    const embedWinner =
      (embedResult.status === 'fulfilled' ? embedResult.value : null) as FacebookMedia | null;
    if (embedWinner) {
      return {
        title: embedWinner.title || 'Facebook Video',
        cover: embedWinner.cover ?? '',
        duration: embedWinner.duration ?? 0,
        hdUrl: embedWinner.hdUrl ?? null,
        sdUrl: embedWinner.sdUrl ?? null,
        author: { name: embedWinner.author?.name ?? '', avatar: embedWinner.author?.avatar || embedWinner.cover || '' },
        like_count: 0,
        comment_count: 0,
        share_count: 0,
        view_count: 0,
      };
    }

    // ─── Layer 2: cobalt.tools video extraction ─────────────────────────
    // cobalt can extract video from Facebook URLs even when page+embed are
    // shelled. Requires either COBALT_API_KEY or a Turnstile token from client.
    // We try with NO turnstile token first (works if API key is configured);
    // if that fails, we still continue to Layer 3 — never block on cobalt.
    try {
      const { cobaltExtractVideo } = await import('./cobalt');
      const cobaltResult = await cobaltExtractVideo(pageUrl);
      if (cobaltResult?.url) {
        console.error('[Facebook] Layer 2: cobalt returned a video URL');
        return {
          title: 'Facebook Video',
          cover: '',
          duration: 0,
          hdUrl: cobaltResult.url,
          sdUrl: null,
          author: { name: '', avatar: '' },
          like_count: 0,
          comment_count: 0,
          share_count: 0,
          view_count: 0,
        };
      }
    } catch (err: any) {
      errors.push(`Cobalt: ${err?.message || 'extraction failed'}`);
    }

    // ─── Layer 3: direct CDN regex extraction from page HTML ────────────
    // Last resort: re-fetch the page (if we didn't get HTML from Layer 1)
    // and scan for Facebook CDN video URLs via regex. Works on some flagged
    // IPs where the page HTML is large but embed/page JSON extraction fails.
    try {
      let pageHtml = '';
      // Reuse HTML from pageTask if available
      if (pageResult.status === 'fulfilled' && pageResult.value?.html) {
        pageHtml = pageResult.value.html;
      } else {
        // Fetch the page ourselves as a last-ditch effort
        const cookie = getFbCookie();
        const resp = await fetch(pageUrl, {
          headers: {
            'User-Agent': UA_DESKTOP,
            'Accept': 'text/html,application/xhtml+xml,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            ...(cookie ? { 'Cookie': cookie } : {}),
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(8_000),
        });
        if (resp.ok) {
          pageHtml = await resp.text();
        }
      }

      if (pageHtml.length > 200) {
        const cdnMedia = extractMediaFromCdnRegex(pageHtml);
        if (cdnMedia) {
          console.error('[Facebook] Layer 3: CDN regex found video URLs');
          return cdnMedia;
        }
      }
    } catch (err: any) {
      errors.push(`CDN regex: ${err?.message || 'extraction failed'}`);
    }

    // ─── All layers failed — graceful error ─────────────────────────────
    const last = errors[errors.length - 1] || 'Could not load this video.';
    const lower = last.toLowerCase();
    if (lower.includes('private') || lower.includes('deleted') || lower.includes('not available')) {
      throw coded(
        'This video appears to be private, restricted, or unavailable. It may be in a closed group or shared with limited audience. Please try another public Facebook video link.',
        FB_ERR.NOT_AVAILABLE
      );
    }
    throw coded(
      'This video could not be downloaded right now. Facebook may be blocking the request. Please try again in a few minutes or try another public link.',
      FB_ERR.NO_MEDIA
    );
  });
}

/**
 * Layer 3 helper: extract Facebook video CDN URLs directly from page HTML
 * using regex. Catches URLs that JSON extraction misses on flagged IPs.
 */
function extractMediaFromCdnRegex(html: string): FacebookMedia | null {
  if (html.length < 500) return null;

  // Match Facebook video CDN URLs: video.twimg.com, *.fbcdn.net video paths,
  // and browser_native/playable_url embedded in HTML/JSON
  const videoUrlPatterns = [
    // Direct CDN progressive MP4 URLs
    /https?:\/\/video\.[\w.-]*fbcdn\.net\/[^"'\s\\]+\.mp4(?:[^"'\s\\]*)/g,
    // browser_native_hd/sd URLs in JSON
    /"browser_native_(?:hd|sd)_url"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    // playable_url variants in JSON
    /"playable_url(?:_quality_hd)?"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    // hd_src / sd_src in embed-style markup
    /"(?:hd|sd)_src(?:_no_ratelimit)?"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    // General fbcdn video URLs in src attributes
    /https?:\/\/[\w.-]*fbcdn\.net\/v\/[^"'\s\\]+\.mp4(?:[^"'\s\\]*)/g,
    // Mobile video URLs
    /https?:\/\/[\w.-]*fbcdn\.net\/(?:z|safe_image|video)[^"'\s\\]+\.mp4(?:[^"'\s\\]*)/g,
  ];

  const seen = new Set<string>();
  let bestHd: string | null = null;
  let bestSd: string | null = null;

  for (const pattern of videoUrlPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      let url = (match[1] || match[0]).replace(/\\u003F/g, '?').replace(/\\\//g, '/').replace(/&amp;/g, '&');
      if (!url.startsWith('http')) continue;
      // Clean trailing escapes
      url = url.split('"')[0].split("'")[0].split('\\')[0];
      if (seen.has(url)) continue;
      seen.add(url);

      // Classify as HD or SD based on URL characteristics
      const isHd = /quality_hd|1080|720|hd_src/i.test(url) || /\/v\/.*_hd/i.test(url);
      if (isHd && !bestHd) bestHd = url;
      else if (!bestSd) bestSd = url;
    }
  }

  const hdUrl = bestHd || bestSd;
  const sdUrl = bestSd || bestHd;
  if (!hdUrl) return null;

  // Try to extract title from og:title or <title>
  const ogTitle = getMetaContent(html, 'og:title') || '';
  const title = ogTitle.replace(/\s*\|\s*Facebook\s*$/i, '').trim() || 'Facebook Video';
  const cover = getMetaContent(html, 'og:image') || '';

  return {
    title,
    cover,
    duration: 0,
    hdUrl,
    sdUrl: sdUrl !== hdUrl ? sdUrl : null,
    author: { name: '', avatar: '' },
    like_count: 0,
    comment_count: 0,
    share_count: 0,
    view_count: 0,
  };
}

/**
 * Fetch a Facebook story. Story pages do not expose the media like regular
 * video pages, so we try several URL variants in parallel — the story
 * permalink (story.php?story_fbid=…&id=…), the classic video page
 * (video.php?v=…), and yt-dlp — and use the first one that yields media.
 * Also tries the reader proxy as a last resort for flagged IPs.
 */
export async function fetchFacebookStory(inputUrl: string): Promise<FacebookMedia> {
  return memoSWR(`fb:story:${inputUrl}`, MEDIA_TTL_MS, MEDIA_STALE_MS, async () => {
    const errors: string[] = [];

    // First: try to extract story segments directly from the page HTML.
    // The story.php page may contain data-sjs blobs even when
    // fetchFacebookMedia's extractMediaFromPageHtml doesn't find playable_url.
    try {
      const { html } = await fetchPage(inputUrl);
      const segments = parseStoryPage(html);
      const videoSeg = segments.find((s) => s.kind === 'video' && (s.hdUrl || s.sdUrl));
      if (videoSeg) {
        return {
          title: videoSeg.title || 'Facebook Story',
          cover: videoSeg.cover,
          duration: videoSeg.duration,
          hdUrl: videoSeg.hdUrl ?? null,
          sdUrl: videoSeg.sdUrl ?? null,
          author: { name: '', avatar: videoSeg.cover },
          like_count: 0,
          comment_count: 0,
          share_count: 0,
          view_count: 0,
        };
      }
      // Check if the page is login-walled (story pages behind login)
      if (detectUnavailable(html, inputUrl) === FB_ERR.LOGIN_REQUIRED) {
        errors.push(`[${FB_ERR.LOGIN_REQUIRED}] Story page requires login.`);
      }
    } catch (err: any) {
      errors.push(err?.message || 'Direct story page parse failed.');
    }

    // Second: try the classic video pipeline (page → embed → yt-dlp).
    const candidates = new Set<string>([inputUrl]);
    const storyFbid = inputUrl.match(/[?&]story_fbid=(\d+)/)?.[1];
    if (storyFbid) {
      candidates.add(`https://www.facebook.com/video.php?v=${storyFbid}`);
    }

    const results = await Promise.allSettled(
      [...candidates].map((u) =>
        fetchFacebookMedia(u).catch((err: any) => {
          const em = err?.message || `Variant failed: ${u}`;
          const code = err?.code || '';
          if (code) errors.push(`[${code}] ${em}`);
          else errors.push(em);
          throw err;
        })
      )
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value?.hdUrl) {
        return result.value;
      }
    }
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value?.sdUrl) {
        return result.value;
      }
    }

    // Third: try the reader proxy as a last resort for flagged IPs.
    const proxyHtml = await fetchStoryViaReaderProxy(inputUrl);
    if (proxyHtml && proxyHtml.length > 500) {
      const proxySegments = parseStoryPage(proxyHtml);
      const proxyVideo = proxySegments.find((s) => s.kind === 'video' && (s.hdUrl || s.sdUrl));
      if (proxyVideo) {
        return {
          title: proxyVideo.title || 'Facebook Story',
          cover: proxyVideo.cover,
          duration: proxyVideo.duration,
          hdUrl: proxyVideo.hdUrl ?? null,
          sdUrl: proxyVideo.sdUrl ?? null,
          author: { name: '', avatar: proxyVideo.cover },
          like_count: 0,
          comment_count: 0,
          share_count: 0,
          view_count: 0,
        };
      }
    }

    // All paths exhausted — determine the best error message.
    if (errors.some((e) => e.includes(FB_ERR.LOGIN_REQUIRED))) {
      throw coded('This story requires a Facebook login to view (private or restricted account). Please try another public story link.', FB_ERR.LOGIN_REQUIRED);
    }
    const last = errors[errors.length - 1] || 'Could not load this story.';
    if (last.toLowerCase().includes('private') || last.toLowerCase().includes('deleted')) {
      throw coded('This story is private or was deleted.', FB_ERR.NOT_AVAILABLE);
    }
    throw coded('Could not load this Facebook story. It may have expired or require login.', FB_ERR.NO_MEDIA);
  });
}

export interface FacebookStorySegment {
  kind: 'video' | 'photo';
  title: string;
  cover: string;
  duration: number;
  hdUrl: string | null;
  sdUrl: string | null;
  /** Full-size CDN URL for photo segments. */
  photoUrl: string | null;
  /** Un-promoted CDN URL — safe fallback when the promoted URL is refused. */
  altUrl?: string;
}

export interface FacebookStorySet {
  title: string;
  cover: string;
  author: { name: string; avatar: string };
  segments: FacebookStorySegment[];
}

const MAX_STORY_SEGMENTS = 30;
const MAX_SJS_BLOB_BYTES = 1_500_000;

/**
 * Collect every media segment of a story from a parsed `data-sjs>` JSON blob.
 * Stories render each segment as `story.attachments[].media` (the media item
 * is EITHER a single object or — for multi-segment stories — an array of
 * them); yt-dlp's extractor walks the same paths (`data.video.story
 * .attachments[].media`, `video.creation_story.attachments` and the
 * `node.comet_sections.content.story.attachments…attachment.media` relay
 * shape), which this walker finds GENERICALLY: any object holding an
 * `attachments` array whose items carry a `media` key. Video segments carry
 * `playable_url`(+`playable_url_quality_hd`, `thumbnailImage`, duration);
 * photo segments carry an `image.uri` with a Photo typename. Nested JSON
 * strings (relay payloads) are re-parsed when they clearly hold attachments.
 */
function storySegmentsFromJson(root: unknown, out: FacebookStorySegment[]): void {
  const seen = new Set<string>();
  const seenSd = new Map<string, FacebookStorySegment>();

  const collectMedia = (media: any) => {
    if (!media || typeof media !== 'object' || Array.isArray(media)) return;
    const hd = typeof media.playable_url_quality_hd === 'string' ? media.playable_url_quality_hd : null;
    const sd = typeof media.playable_url === 'string' ? media.playable_url : null;
    if (hd || sd) {
      const img = typeof media?.thumbnailImage?.uri === 'string' ? media.thumbnailImage.uri : '';
      const imgAlt = typeof media?.image?.uri === 'string' ? media.image.uri : '';
      // Dedupe by the SD stream: the same video can appear twice in a payload
      // (once bare, once with an HD variant). If we've seen the SD URL, upgrade
      // the existing segment in place with the HD URL so the best rendition wins.
      if (sd) {
        const existing = seenSd.get(sd);
        if (existing) {
          if (hd && !existing.hdUrl) existing.hdUrl = hd;
          if (!existing.cover && (img || imgAlt)) existing.cover = img || imgAlt;
          return;
        }
      }
      const url = hd || sd;
      if (seen.has(`v:${url}`)) return;
      seen.add(`v:${url}`);
      const seg: FacebookStorySegment = {
        kind: 'video',
        title: typeof media?.name === 'string' ? media.name : '',
        cover: img || imgAlt,
        duration:
          typeof media.playable_duration_in_ms === 'number' ? media.playable_duration_in_ms / 1000 : 0,
        hdUrl: hd,
        sdUrl: sd,
        photoUrl: null,
      };
      if (sd) seenSd.set(sd, seg);
      out.push(seg);
      return;
    }
    const uri = media?.image?.uri;
    if (typeof uri === 'string') {
      const typename = typeof media.__typename === 'string' ? media.__typename : '';
      if (typename && !/photo/i.test(typename)) return;
      const clean = uri.replace(/&amp;/g, '&');
      if (seen.has(`p:${clean}`)) return;
      seen.add(`p:${clean}`);
      out.push({
        kind: 'photo',
        title: '',
        cover: clean,
        duration: 0,
        hdUrl: null,
        sdUrl: null,
        photoUrl: promotePhotoUrl(clean),
        altUrl: clean,
      });
    }
  };

  const collectAttachmentMedia = (attachments: any[]) => {
    for (const a of attachments) {
      if (!a || typeof a !== 'object' || !('media' in a)) continue;
      const media = (a as any).media;
      if (Array.isArray(media)) for (const m of media) collectMedia(m);
      else collectMedia(media);
    }
  };

  const walk = (node: unknown, depth: number) => {
    if (node == null || depth > 18) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === 'string') {
      // Some relay payloads store nested JSON as escaped strings inside the
      // container blob — parse the ones that clearly hold attachments.
      if (node.length < MAX_SJS_BLOB_BYTES && node.startsWith('{') && node.includes('"attachments"')) {
        try {
          walk(JSON.parse(node), depth + 1);
        } catch {
          // ignore malformed nested payloads
        }
      }
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, any>;
    if (Array.isArray(obj.attachments)) collectAttachmentMedia(obj.attachments);
    for (const key of Object.keys(obj)) {
      if (key !== 'attachments') walk(obj[key], depth + 1);
    }
  };

  walk(root, 0);
}

/**
 * Parse every `data-sjs>` JSON blob of a story page into story segments.
 * Exported for tests.
 */
export function parseStoryPage(html: string): FacebookStorySegment[] {
  const out: FacebookStorySegment[] = [];
  const blobRe = /<script\s+[^>]*type="application\/json"[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(blobRe)) {
    const blob = m[1]?.trim();
    if (!blob || blob.length > MAX_SJS_BLOB_BYTES) continue;
    try {
      storySegmentsFromJson(JSON.parse(blob), out);
    } catch {
      // malformed blob — try the next one
    }
    if (out.length >= MAX_STORY_SEGMENTS) break;
  }
  return out.slice(0, MAX_STORY_SEGMENTS);
}

/**
 * Try fetching a story page through the reader proxy (r.jina.ai) which uses
 * a clean (unflagged) IP. Returns the raw HTML so parseStoryPage can extract
 * data-sjs blobs. Never throws — returns empty string on failure.
 */
async function fetchStoryViaReaderProxy(url: string): Promise<string> {
  const attempt = async (u: string): Promise<string> => {
    try {
      const resp = await fetch(`https://r.jina.ai/${u}`, {
        headers: {
          'Accept': 'text/html',
          'User-Agent': 'Mozilla/5.0 (compatible; TikSaveHub/1.0)',
        },
        signal: AbortSignal.timeout(READER_FALLBACK_TIMEOUT_MS),
      });
      if (!resp.ok) return '';
      return await resp.text();
    } catch {
      return '';
    }
  };

  // Try the original URL first, then one host variant — reader proxies
  // rate-limit, so keep attempts low.
  let html = await attempt(url);
  if (!html || html.length < 500) {
    const variants = hostVariantsOf(url);
    if (variants.length > 1) {
      html = await attempt(variants[1]);
    }
  }
  return html;
}

/**
 * Fetch EVERY segment of a Facebook story — multi-segment stories carry
 * several videos/photos in one story, and previously only the first video was
 * ever extracted. Story pages are fetched across host variants and user agents
 * in PARALLEL (flagged IPs shell some variants; the variant that yields the
 * most segments wins — same pattern as the photo pipeline). When no page
 * exposes the attachments JSON (heavily shelled pages), try the reader proxy
 * (clean IP) as a fallback before falling to the classic single-video pipeline.
 */
export async function fetchFacebookStorySet(inputUrl: string): Promise<FacebookStorySet> {
  return memoSWR(`fb:storyset:${inputUrl}`, MEDIA_TTL_MS, MEDIA_STALE_MS, async () => {
    const attempts: Array<{ url: string; ua: string }> = [];
    for (const u of hostVariantsOf(inputUrl)) {
      attempts.push({ url: u, ua: UA_MOBILE }, { url: u, ua: UA_DESKTOP });
    }

    const results = await Promise.allSettled(attempts.map(({ url, ua }) => fetchPage(url, ua)));

    let bestSegments: FacebookStorySegment[] = [];
    let bestHtml = '';
    for (const r of results) {
      if (r.status === 'rejected') continue;
      const segments = parseStoryPage(r.value.html);
      if (segments.length > bestSegments.length) {
        bestSegments = segments;
        bestHtml = r.value.html;
      }
    }

    if (bestSegments.length === 0) {
      // No attachments JSON anywhere from native fetches (flag-walled shells).
      // Try the reader proxy — it uses a clean IP that can see story data.
      const proxyHtml = await fetchStoryViaReaderProxy(inputUrl);
      if (proxyHtml && proxyHtml.length > 500) {
        const proxySegments = parseStoryPage(proxyHtml);
        if (proxySegments.length > 0) {
          bestSegments = proxySegments;
          bestHtml = proxyHtml;
        }
      }
    }

    if (bestSegments.length === 0) {
      // Still no segments — fall back to the classic single-video pipeline.
      const single = await fetchFacebookStory(inputUrl);
      if (!single.hdUrl && !single.sdUrl) {
        throw coded('Could not load this Facebook story.', FB_ERR.NO_MEDIA);
      }
      bestSegments = [
        {
          kind: 'video',
          title: single.title,
          cover: single.cover,
          duration: single.duration,
          hdUrl: single.hdUrl,
          sdUrl: single.sdUrl,
          photoUrl: null,
        },
      ];
      bestHtml = '';
    }

    let title =
      getMetaContent(bestHtml, 'og:title') ||
      htmlTitle(bestHtml) ||
      (bestSegments[0]?.kind === 'video' ? bestSegments[0].title : '') ||
      'Facebook Story';
    title = title.replace(/\s*\|\s*Facebook\s*$/i, '').trim() || 'Facebook Story';

    const ogImage = getMetaContent(bestHtml, 'og:image');
    const cover = ogImage || bestSegments[0]?.cover || '';

    const authorMatch = bestHtml.match(/"pageName"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const authorName = authorMatch ? unescapeJsonString(authorMatch[1]) : '';

    return {
      title,
      cover,
      author: { name: authorName, avatar: cover },
      segments: bestSegments,
    };
  });
}

/** Best-effort audio track extraction via cobalt.tools API. */
export async function fetchFacebookAudio(inputUrl: string, turnstileToken?: string): Promise<FacebookAudioResult | null> {
  try {
    const { cobaltExtractAudio } = await import('./cobalt');
    return await cobaltExtractAudio(inputUrl, turnstileToken);
  } catch {
    return null;
  }
}

/**
 * Extract the photo ID from a FB CDN file name. Gallery/sibling photos are
 * named `{photo_id}_{photo_fbid}_{…}_n.jpg`; the photo ID is the first segment
 * (photo.php?fbid={id} is the per-photo page).
 */
function photoIdFromUrl(u: string): string | null {
  const m = u.match(/\/(\d{4,20})_\d{4,20}_[A-Za-z0-9]*(?:_n|_o)\.(?:jpg|png|webp|gif|heic|avif)(?:[?#]|$)/);
  return m ? m[1] : null;
}

/**
 * Extract ALL photo candidates from a Facebook photo page.
 *
 * Photo pages carry the original image in several spots depending on the
 * served variant (desktop vs mobile, flag-walled or not). Multi-photo posts
 * and albums list every sibling photo in `"image":{"uri":"…"}` JSON blobs, so
 * instead of picking one URL we collect every candidate, in order:
 *  1. og:image meta — the photo being viewed.
 *  2. Every `"image":{"uri":"…"}` JSON blob (full-size uris; one per sibling).
 *  3. Every scontent/fbcdn `<img>` src (mobile pages).
 * Each URL is promoted to full resolution, and every rendition of the same
 * photo (same CDN path, different `stp` sizes/params) collapses to one entry —
 * keeping whichever variant rates highest (jpg over webp, bigger over smaller).
 */
export function extractPhotosFromHtml(html: string): PhotoCandidate[] {
  if (html.length < 100) return [];

  const candidates: PhotoCandidate[] = [];
  const add = (raw: string | null) => {
    if (!raw || !raw.startsWith('http')) return;
    const clean = raw.replace(/&amp;/g, '&');
    if (isNonPhotoAssetUrl(clean)) return;
    const promoted = promotePhotoUrl(clean);
    const key = cdnPathOf(promoted);
    const existing = candidates.find((c) => cdnPathOf(c.url) === key);
    if (existing) {
      if (photoQualityScore(promoted) > photoQualityScore(existing.url)) {
        existing.url = promoted;
        existing.alt = stripCtpCap(clean);
      }
      return;
    }
    candidates.push({ url: promoted, alt: stripCtpCap(clean) });
  };

  add(getMetaContent(html, 'og:image'));

  const jsonRe = /"image"\s*:\s*\{[\s\S]*?"uri"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const m of html.matchAll(jsonRe)) add(unescapeJsonString(m[1]));

  const imgRe = /<img[^>]*src="(https:\/\/[^"]*(?:scontent|fbcdn|fbsbx)[^"]*)"/gi;
  for (const m of html.matchAll(imgRe)) {
    const raw = m[1].replace(/&amp;/g, '&');
    // FB static hosts (emoji sprites, icons) are never photos.
    if (isNonPhotoAssetUrl(raw)) continue;
    // Ignore tiny avatars/emoji assets — both path tokens (s40x40, p40x40,
    // p75x75) and stp query tokens (…_s40x40_tt6, …_s96x96_tt6: anything
    // ≤160×160 is an avatar/icon, real photo thumbs are bigger).
    const stpSize = raw.match(/_s(\d{2,3})x(\d{2,3})(?:_tt\d|&|$)/);
    if (stpSize && Number(stpSize[1]) <= 160 && Number(stpSize[2]) <= 160) continue;
    if (/\/s\d{1,3}x\d{1,3}(\/|\.)|\/p\d{1,2}x\d{1,2}(\/|\.)|emoji|avatar|profile_image/.test(raw)) continue;
    add(raw);
  }

  return candidates;
}

const PHOTO_PAGE_TIMEOUT_MS = 10_000;
const MAX_PHOTO_HTML_BYTES = 2_500_000;
// Anything smaller than this is a quad/thumbnail rendition — worth fetching
// the photo's own page to look for the full-size original. (MIN_FULL_PHOTO_SCORE
// lives in facebook-photo-quality.ts — the locked invariant module.)

/**
 * Read a response body as text but stop early once `maxBytes` have been
 * consumed — FB photo pages can be several MB and we only need the first
 * portion (og:image lives in <head>, the JSON image blobs follow shortly
 * after). Cancelling the stream keeps the fetch fast and memory-light.
 */
async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let out = '';
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
    return { text: out + decoder.decode(), truncated };
  } catch {
    // Throttled/flagged IPs stall mid-body — the buffered head (og:image in
    // <head>, image JSON blobs right after) is already enough to extract,
    // but sibling thumbnails further down may have been missed.
    truncated = true;
    reader.cancel().catch(() => {});
    return { text: out + decoder.decode(), truncated };
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function fetchPhotoPage(
  url: string,
  ua: string,
  timeoutMs = PHOTO_PAGE_TIMEOUT_MS
): Promise<{ html: string; truncated: boolean }> {
  let resp: Response;
  const cookie = getFbCookie();
  try {
    resp = await fetch(url, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        ...(cookie ? { 'Cookie': cookie } : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw coded('The server took too long to reach Facebook.', FB_ERR.TIMEOUT);
    }
    throw err;
  }
  if (resp.status === 404) {
    throw coded('This photo was not found.', FB_ERR.NOT_AVAILABLE);
  }
  if (!resp.ok && resp.status >= 500) {
    throw coded('Facebook could not be reached right now.', FB_ERR.INVALID_RESPONSE);
  }
  const { text, truncated } = await readBoundedText(resp.body, MAX_PHOTO_HTML_BYTES);
  if (text.length < 100) {
    throw coded('Facebook returned an empty page.', FB_ERR.INVALID_RESPONSE);
  }
  return { html: text, truncated };
}

export interface FacebookPhotoSet {
  photos: FacebookPhoto[];
  title: string;
  cover: string;
  author: { name: string; avatar: string };
}

// No cap: the site serves EVERY photo in a link/album. (Owner requirement:
// "jitne link mein photos hongi, sab show + download hongi".)

/**
 * Facebook serves different page variants per host — flagged IPs regularly
 * shell `www.` and `m.` while `web.` (share links in particular) serves the
 * full story page, or vice versa. Return every host variant of a photo URL so
 * the extractor can try them all and keep the one with the most photos.
 */
function hostVariantsOf(url: string): string[] {
  const variants = new Set<string>();
  for (const host of ['www.facebook.com', 'web.facebook.com', 'm.facebook.com', 'touch.facebook.com']) {
    variants.add(url.replace(/^https:\/\/[^/]+/, `https://${host}`));
  }
  return [...variants];
}

/**
 * Fetch the download URLs + metadata for a public Facebook photo post.
 * Photo pages are fetched in parallel across host variants (www/web/m/touch)
 * and user agents (desktop + iPhone — flagged IPs serve the full og:image
 * story page to iPhone UAs on web. hosts). The page that yields the most
 * photos wins. Sibling photos that only appear as small thumbnails get their
 * own photo page fetched (`photo.php?fbid={id}` — the standard technique
 * downloaders use) in a further attempt to recover the full-size original.
 */
export async function fetchFacebookPhotoSet(inputUrl: string): Promise<FacebookPhotoSet> {
  return memoSWR(`fb:photos:${inputUrl}`, MEDIA_TTL_MS, MEDIA_STALE_MS, async () => {
    const attempts: Array<[string, string]> = [];
    for (const u of hostVariantsOf(inputUrl)) {
      attempts.push([u, UA_DESKTOP], [u, UA_IPHONE]);
    }

    const hasCookies = !!getFbCookie();
    const photoTimeout = hasCookies ? 5_000 : PHOTO_PAGE_TIMEOUT_MS;
    const round = (): Promise<Array<PromiseSettledResult<{ html: string; truncated: boolean }>>> =>
      Promise.allSettled(attempts.map(([u, ua]) => fetchPhotoPage(u, ua, photoTimeout)));

    const bestFrom = (results: Array<PromiseSettledResult<{ html: string; truncated: boolean }>>) => {
      let sawNotFound = false;
      let sawTruncated = false;
      let sawShell = false;
      let sawTimeout = false;
      let bestHtml = '';
      let bestCandidates: PhotoCandidate[] = [];
      for (const result of results) {
        if (result.status === 'rejected') {
          if (result.reason?.code === FB_ERR.NOT_AVAILABLE) sawNotFound = true;
          if (result.reason?.code === FB_ERR.TIMEOUT) sawTimeout = true;
          continue;
        }
        if (result.value.truncated) sawTruncated = true;
        // Flagged IPs serve tiny 400/error shells for most host variants — a
        // page that small (or truncated) can't be a faithful copy of the post,
        // so its single-fold og:image is NOT proof the post has only one photo.
        if (result.value.html.length < 15_000) sawShell = true;
        const candidates = extractPhotosFromHtml(result.value.html);
        if (candidates.length > bestCandidates.length) {
          bestCandidates = candidates;
          bestHtml = result.value.html;
        }
      }
      return { sawNotFound, sawTruncated, sawShell, sawTimeout, bestHtml, bestCandidates };
    };

    let results = await round();
    let { sawNotFound, sawTruncated, sawShell, sawTimeout, bestHtml, bestCandidates } = bestFrom(results);

    // A fully throttled IP times out every attempt — retrying immediately
    // won't lift the throttle, so skip the second round and let the reader
    // proxy path below handle recovery.
    const allTimedOut =
      bestCandidates.length === 0 &&
      results.length > 0 &&
      results.every((r) => r.status === 'rejected' && r.reason?.code === FB_ERR.TIMEOUT);

    // With cookies + ≥1 photo found, authenticated pages are consistent —
    // skip the retry round (saves 8 parallel requests). Still retry when
    // 0 photos found (flagged IPs may shell even with cookies on some hosts).
    // Without cookies on flagged IPs, FB serves different page variants per
    // request so retrying once can recover missing siblings.
    if (bestCandidates.length < 2 && !allTimedOut && !(hasCookies && bestCandidates.length >= 1)) {
      results = await round();
      const retried = bestFrom(results);
      if (retried.bestCandidates.length > bestCandidates.length) {
        sawNotFound = retried.sawNotFound;
        sawTruncated = retried.sawTruncated;
        sawShell = retried.sawShell;
        sawTimeout = retried.sawTimeout;
        bestHtml = retried.bestHtml;
        bestCandidates = retried.bestCandidates;
      }
    }

    // Flagged IPs shell every photo page locally — but the share page itself
    // still renders fully for unflagged readers. Fetch it once through a public
    // reader proxy and reuse its signed CDN URLs (signatures are IP-independent,
    // so the images download from any IP). This recovers either the whole set
    // (fully shelled) or the siblings lost to a throttled/truncated read — or
    // the additional photos a single-photo-looking result missed because the
    // serving variant was a shell/error page (tiny HTML, truncated body, or a
    // host that timed out). A clean single-photo page (large, complete, no
    // shells/timeouts) skips the proxy entirely — no wasted latency.
    // With cookies, authenticated pages return full content — skip the reader
    // proxy when we already have photos (no need for external recovery).
    // Still use reader when 0 photos found (flagged IPs may shell even with cookies).
    const needsReader =
      bestCandidates.length === 0 ||
      (bestCandidates.length === 1 && (sawTruncated || sawShell || sawTimeout));
    if (needsReader && !(hasCookies && bestCandidates.length >= 1)) {
      if (isReaderRecoverableUrl(inputUrl)) {
        const recovered = new Map<string, PhotoCandidate>();
        await fetchSiblingsViaReader(inputUrl, null, recovered);
        if (recovered.size) {
          for (const c of recovered.values()) {
            const key = cdnPathOf(c.url);
            const existing = bestCandidates.find((e) => cdnPathOf(e.url) === key);
            if (existing) {
              if (photoQualityScore(c.url) > photoQualityScore(existing.url)) {
                existing.url = c.url;
                existing.alt = c.alt;
              }
            } else {
              bestCandidates.push(c);
            }
          }
        }
      }
    }

    if (bestCandidates.length === 0) {
      if (sawNotFound) {
        throw coded('This photo is private or was deleted.', FB_ERR.NOT_AVAILABLE);
      }
      throw coded('Could not load this Facebook photo.', FB_ERR.NO_MEDIA);
    }

    // Sibling photos that only exist as small quads/thumbs (< ~320px) get
    // their own photo page fetched — photo.php exposes the full-size og:image
    // on unflagged IPs. The check runs on the RAW rendition (c.alt): promotion
    // to p2048 makes a signed thumb look full-size, but the promoted URL 403s
    // at download time and the delivered file is still the small thumb.
    const thumbIds = new Map<string, string>();
    for (const c of bestCandidates) {
      if (isThumbOnly(c.alt)) {
        const id = photoIdFromUrl(c.alt);
        if (id) thumbIds.set(id, c.alt);
      }
    }
    if (thumbIds.size) {
      const full = await fetchSiblingPhotosFull([...thumbIds.keys()], inputUrl);
      for (const c of bestCandidates) {
        const id = photoIdFromUrl(c.alt);
        const upgraded = id && full.get(id);
        if (upgraded) {
          c.url = upgraded.url;
          c.alt = upgraded.alt;
        }
      }
    }

    let title =
      getMetaContent(bestHtml, 'og:title') ||
      getMetaContent(bestHtml, 'og:image:alt') ||
      htmlTitle(bestHtml) ||
      'Facebook Photo';
    title = title.replace(/\s*\|\s*Facebook\s*$/i, '').trim() || 'Facebook Photo';

    const authorMatch = bestHtml.match(/"pageName"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const authorName = authorMatch ? unescapeJsonString(authorMatch[1]) : '';

    // OUTPUT-BOUNDARY ENFORCEMENT — see `enforcePhotoQuality` in
    // facebook-photo-quality.ts (the locked invariant module). No matter which
    // extraction/recovery path fed these candidates, this final pass strips
    // every `ctp=` cap, rejects sticker/emoji/avatar buckets, drops
    // thumbnail-only leftovers, and dedupes by CDN path. The photo set that
    // reaches the API can NEVER contain a capped or non-photo URL.
    bestCandidates = enforcePhotoQuality(bestCandidates);

    const photos: FacebookPhoto[] = bestCandidates.map((c) => ({
      title,
      cover: c.url,
      photoUrl: c.url,
      altUrl: c.alt !== c.url ? c.alt : undefined,
      author: { name: authorName, avatar: c.url },
    }));

    return {
      photos,
      title,
      cover: photos[0]?.cover ?? '',
      author: { name: authorName, avatar: photos[0]?.cover ?? '' },
    };
  });
}

const SIBLING_PAGE_TIMEOUT_MS = 6_000;

/** True for URLs the reader proxy can reliably render for unflagged readers:
 *  share photo links (`share/p/{code}`), profile/group post permalinks
 *  (`/{user}/posts/{token}`, `/groups/{gid}/permalink/{token}`) and legacy
 *  `permalink.php?story_fbid={id}` post pages (they redirect to the post
 *  permalink, which carries every carousel sibling) — everything else is
 *  login-walled for its IPs. Called with full `https://…` URLs. */
function isReaderRecoverableUrl(u: string): boolean {
  return (
    /\/share\/p\/[A-Za-z0-9_-]{4,20}\/?$/.test(u) ||
    /\/[A-Za-z0-9._-]+\/(?:posts|permalink)\/[A-Za-z0-9_-]{8,80}\/?$/.test(u) ||
    /\/groups\/[A-Za-z0-9._-]+\/(?:posts|permalink)\/[A-Za-z0-9_-]{8,80}\/?$/.test(u) ||
    /\/permalink\.php\?story_fbid=\d{5,30}$/.test(u)
  );
}

const READER_FALLBACK_TIMEOUT_MS = 20_000;

/**
 * Fetch the share page through a public reader proxy (r.jina.ai — unflagged
 * IPs) and collect signed CDN URLs for the photos in it. The signatures are
 * IP-independent, so the URLs download from any IP; `wantIds` limits the set
 * to specific siblings, or `null` accepts every photo in the post. Never
 * throws — flagged/throttled reads just keep the thumbnails.
 */
async function fetchSiblingsViaReader(
  shareUrl: string,
  wantIds: string[] | null,
  found: Map<string, PhotoCandidate>
): Promise<void> {
  const attempt = async (): Promise<boolean> => {
    try {
      const resp = await fetch(`https://r.jina.ai/${shareUrl}`, {
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(READER_FALLBACK_TIMEOUT_MS),
      });
      if (!resp.ok) return false;
      const text = await resp.text();
      const want = wantIds ? new Set(wantIds.filter((id) => !found.has(id))) : null;
      if (wantIds && want && !want.size) return true;
      const seen = new Set<string>();
      const re = /https?:\/\/[^()\s"']+scontent[^()\s"']*/g;
      for (const m of text.matchAll(re)) {
        const raw = m[0];
        if (seen.has(raw)) continue;
        seen.add(raw);
        if (isNonPhotoAssetUrl(raw)) continue;
        const id = photoIdFromUrl(raw);
        if (!id || (want && !want.has(id))) continue;
        const clean = raw.replace(/&amp;/g, '&');
        const candidate = { url: promotePhotoUrl(clean), alt: stripCtpCap(clean) };
        if (photoQualityScore(candidate.url) > MIN_FULL_PHOTO_SCORE) {
          found.set(id, candidate);
        }
      }
      return true;
    } catch {
      return false;
    }
  };
  // Reader proxies rate-limit aggressively — one quick retry before giving up
  // (the caller keeps the thumbnails when this fails).
  if (!(await attempt())) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await attempt();
  }
}

/**
 * Fetch the full-size image for a set of photo IDs via their own photo pages
 * (`photo.php?fbid={id}`). Rounds run parallel across all ids — variant 1
 * everywhere first, then variant 2/3 only for IDs still thumb-only (flagged
 * IPs shell photo.php regardless, so the extra attempts stay cheap). IDs the
 * native rounds could not recover fall back to one reader-proxy pass over the
 * share page (unflagged readers see it with every photo at ~590px, signed —
 * and those URLs download from any IP).
 */
async function fetchSiblingPhotosFull(
  ids: string[],
  shareUrl?: string
): Promise<Map<string, PhotoCandidate>> {
  const found = new Map<string, PhotoCandidate>();
  const variantUAs = [UA_IPHONE, UA_DESKTOP, UA_IPHONE];
  const variantHosts = ['web.facebook.com', 'www.facebook.com', 'm.facebook.com'];

  let remaining = ids;
  for (let round = 0; round < variantHosts.length && remaining.length; round++) {
    const results = await Promise.all(
      remaining.map(async (id) => {
        const url = `https://${variantHosts[round]}/photo.php?fbid=${id}`;
        try {
          const { html } = await fetchPhotoPage(url, variantUAs[round], SIBLING_PAGE_TIMEOUT_MS);
          const og = getMetaContent(html, 'og:image') || getMetaContent(html, 'og:image:url');
          if (!og || isNonPhotoAssetUrl(og) || /(?:static\.|rsrc\.php|facebook\.com)/i.test(og)) return null;
          const clean = og.replace(/&amp;/g, '&');
          return { id, candidate: { url: promotePhotoUrl(clean), alt: stripCtpCap(clean) } };
        } catch {
          return null;
        }
      })
    );
    for (const r of results) {
      if (r && photoQualityScore(r.candidate.url) > MIN_FULL_PHOTO_SCORE) {
        found.set(r.id, r.candidate);
      }
    }
    remaining = remaining.filter((id) => !found.has(id));
    // Flagged IPs shell photo.php for every id — one wasted round is enough;
    // the reader proxy recovers the rest much faster than more login walls.
    if (round === 0 && remaining.length === ids.length) break;
  }

  if (remaining.length && shareUrl && isReaderRecoverableUrl(shareUrl)) {
    await fetchSiblingsViaReader(shareUrl, remaining, found);
  }
  return found;
}

/** First photo of a photo post — kept for the single-photo download path. */
export async function fetchFacebookPhoto(inputUrl: string): Promise<FacebookPhoto> {
  const set = await fetchFacebookPhotoSet(inputUrl);
  const first = set.photos[0];
  return {
    title: first?.title || set.title,
    cover: first?.cover || set.cover,
    photoUrl: first?.photoUrl || '',
    altUrl: first?.altUrl,
    author: { name: set.author?.name ?? '', avatar: first?.cover || set.cover },
  };
}

const PHOTO_DL_CONCURRENCY = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download one photo, failing fast under the concurrent burst (short timeout
 * so throttled hosts cost ~seconds, not minutes) and cycling url → alt once.
 * Burst-throttled photos are healed by the sequential retry pass in
 * fetchFacebookPhotosAsFiles, which runs after the burst has cleared.
 */
async function fetchPhotoBuffer(
  url: string,
  altUrl?: string,
  opts?: { timeoutMs?: number }
): Promise<{ data: Uint8Array; contentType: string | null }> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const download = async (u: string): Promise<{ data: Uint8Array; contentType: string | null }> => {
    const resp = await fetch(u, {
      headers: {
        'User-Agent': UA_DESKTOP,
        'Referer': 'https://www.facebook.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`Facebook CDN returned ${resp.status}`);
    const data = new Uint8Array(await resp.arrayBuffer());
    if (data.length < 256) throw new Error('Facebook CDN returned an empty image');
    return { data, contentType: resp.headers.get('content-type') };
  };

  const fallback = altUrl && altUrl !== url ? altUrl : url;
  const attempts: Array<{ u: string; waitMs: number }> = [
    { u: url, waitMs: 0 },
    { u: fallback, waitMs: 800 },
  ];
  let lastErr: unknown = null;
  for (const { u, waitMs } of attempts) {
    if (waitMs) await sleep(waitMs);
    try {
      return await download(u);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Facebook CDN download failed');
}

function photoExtOf(url: string, contentType: string | null): string {
  if (contentType?.includes('png')) return 'png';
  if (contentType?.includes('webp')) return 'webp';
  if (contentType?.includes('gif')) return 'gif';
  if (contentType?.includes('heic')) return 'heic';
  if (contentType?.includes('avif')) return 'avif';
  const m = /\.(jpe?g|png|webp|gif|heic|avif)(?:[?#]|$)/i.exec(url);
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return 'jpg';
}

/**
 * Download every photo in a post as a buffer (bounded concurrency, CDN
 * referer set, retry pass for burst-throttled URLs). Failed entries are
 * skipped only as a last resort so one dead URL can't sink the whole bundle;
 * the caller decides what to do if ALL of them fail. Each entry may carry the
 * un-promoted original as a fallback for signed/locked URLs.
 */
export async function fetchFacebookPhotosAsFiles(
  photos: Array<{ url: string; alt?: string }>
): Promise<Array<{ name: string; data: Uint8Array }>> {
  const out: Array<{ name: string; data: Uint8Array }> = [];
  const failed: number[] = [];
  let next = 0;

  const worker = async () => {
    while (next < photos.length) {
      const i = next++;
      const { url, alt } = photos[i];
      try {
        const { data, contentType } = await fetchPhotoBuffer(url, alt);
        out.push({ name: `photo-${String(i + 1).padStart(2, '0')}.${photoExtOf(url, contentType)}`, data });
      } catch (err: any) {
        console.error(`[Facebook] photo ${i + 1} download failed:`, err?.message ?? err);
        failed.push(i);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PHOTO_DL_CONCURRENCY, photos.length) }, () => worker())
  );

  // Retry pass for burst-throttled photos. Waits out the CDN throttle window
  // (identical URLs that fail under the burst download fine seconds later
  // standalone — verified live), then re-fetches each failure one at a time
  // with no competing connections and a full-length timeout.
  if (failed.length) {
    const retried = new Set<number>();
    for (let pass = 0; pass < 2 && retried.size < failed.length; pass++) {
      await sleep(pass === 0 ? 5_000 : 4_000);
      for (const i of failed) {
        if (retried.has(i)) continue;
        const { url, alt } = photos[i];
        try {
          const { data, contentType } = await fetchPhotoBuffer(url, alt, { timeoutMs: 60_000 });
          out.push({ name: `photo-${String(i + 1).padStart(2, '0')}.${photoExtOf(url, contentType)}`, data });
          retried.add(i);
        } catch (err: any) {
          console.error(`[Facebook] photo ${i + 1} retry failed:`, err?.message ?? err);
        }
      }
    }
  }

  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

const STORY_DL_CONCURRENCY = 3;
const STORY_DL_TIMEOUT_MS = 60_000;

async function fetchStoryVideoBuffer(url: string): Promise<{ data: Uint8Array; contentType: string | null }> {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA_DESKTOP,
      'Referer': 'https://www.facebook.com/',
      'Accept': 'video/mp4,video/*,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(STORY_DL_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Facebook CDN returned ${resp.status}`);
  const data = new Uint8Array(await resp.arrayBuffer());
  if (data.length < 256) throw new Error('Facebook CDN returned an empty video');
  return { data, contentType: resp.headers.get('content-type') };
}

/**
 * Download every segment of a story (videos at HD, photos full-size) into one
 * bundle for the ZIP downloader. Failed entries are skipped so one dead URL
 * can't sink the whole archive.
 */
export async function fetchFacebookStoryAsFiles(
  set: FacebookStorySet
): Promise<Array<{ name: string; data: Uint8Array }>> {
  const out: Array<{ name: string; data: Uint8Array }> = [];
  let next = 0;

  const worker = async () => {
    while (next < set.segments.length) {
      const i = next++;
      const seg = set.segments[i];
      const label = String(i + 1).padStart(2, '0');
      try {
        if (seg.kind === 'photo' && seg.photoUrl) {
          const { data, contentType } = await fetchPhotoBuffer(seg.photoUrl, seg.altUrl);
          out.push({ name: `story-${label}.${photoExtOf(seg.photoUrl, contentType)}`, data });
        } else {
          const url = seg.hdUrl || seg.sdUrl;
          if (!url) continue;
          const { data } = await fetchStoryVideoBuffer(url);
          out.push({ name: `story-${label}.mp4`, data });
        }
      } catch (err: any) {
        console.error(`[Facebook] story segment ${i + 1} download failed:`, err?.message ?? err);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(STORY_DL_CONCURRENCY, Math.max(set.segments.length, 1)) }, () => worker())
  );

  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}