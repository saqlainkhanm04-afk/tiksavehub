import { memoSWR } from './cache';
import { type CfEnv, envStr } from './env';
import { parseFacebookUrl } from './facebook-url';
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
import { runWithFallback } from './api-fallback';
import { fetchWithBrowser } from './fb-browser';
import { facebookSources } from './platforms/facebook';
import type { MediaMeta } from './platforms/types';

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

/**
 * Detect a Facebook login wall in HTML/text content. Facebook serves these
 * when it decides to block anonymous/bot access to a post — even publicly
 * visible ones. The response contains form elements with "Log into Facebook",
 * "Email or mobile number", "Password" fields, or a redirect to /login/.
 *
 * This is NOT a code bug — it's Facebook's variable anti-scraping behavior
 * that affects some posts from certain IPs. Most public posts work fine;
 * login-walled posts are an inherent limitation of anonymous scraping.
 *
 * NOTE: This detection is used in reader proxy paths (r.jina.ai) for photos,
 * stories, and albums. The video pipeline (page/embed/yt-dlp) does NOT use
 * the reader proxy, so login walls in video paths produce generic errors.
 *
 * DOCUMENTED in AGENTS.md under "Facebook Login Wall Limitation".
 */
export function detectLoginWall(text: string): boolean {
  if (!text || text.length < 200) return false;
  const lower = text.toLowerCase();
  // Primary markers: the login form itself
  if (lower.includes('log into facebook')) return true;
  if (lower.includes('log in to facebook')) return true;
  if (lower.includes('you must log in to continue')) return true;
  // The email/password form fields (present in the login wall page)
  if (lower.includes('email or mobile number') && lower.includes('password')) return true;
  // Login redirect markers
  if (lower.includes('url=/login/?next=') || lower.includes('url=/login/?')) return true;
  if (lower.includes('action="/login"') || lower.includes("action='/login'")) return true;
  // Password input field (definitive — only on login pages)
  if (lower.includes('type="password"') || lower.includes("type='password'")) return true;
  // CAPTCHA / challenge pages served by Facebook or reader proxies
  if (lower.includes('requiring captcha') || lower.includes('please solve this captcha')) return true;
  // Tiny response with only a login link and no actual post content
  if (text.length < 800 && lower.includes('[log in]') && lower.includes('forgot account')) return true;
  return false;
}

export function detectUnavailable(html: string, finalUrl: string): string | null {
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

/**
 * Resolve share links, fb.watch short links, and mobile URLs to their final
 * canonical Facebook page URL.  Facebook share links (/share/r/, /share/v/,
 * fb.watch) redirect server-side to the real media page — but Cobalt and
 * other extractors can't follow those redirects, so we must expand them
 * first.
 *
 * Tracking query params (mibextid, ref, __tn__, etc.) are stripped from the
 * resolved URL so it stays cache-friendly.
 */
const SHARE_SHORT_RE = /^\/share\/[rvp]\//i;
const TRACKING_PARAMS = new Set([
  'mibextid', 'ref', 's', '_rdr', 'wtsid', 'eid', 'ft', 'ftid', 'fref',
  'extid', 'tn', '__tn__', '__cft__[0]', '__xts__', 'qid', 'epa', 'n',
  'sfnsn', 'sfnsmo', 'source', 'rdid', 'locale', 'patrk',
]);

function stripTracking(u: URL): URL {
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  return u;
}

async function resolveFacebookUrl(url: string): Promise<string> {
  // Only resolve links that actually need it: fb.watch, /share/r|v|p/,
  // or mobile hosts that may redirect.
  const needsResolve =
    /fb\.watch\//i.test(url) ||
    SHARE_SHORT_RE.test(new URL(url).pathname) ||
    /m\.facebook\.com|touch\.facebook\.com|mobile\.facebook\.com/i.test(url);
  if (!needsResolve) return url;

  // IMPORTANT: Facebook's 302 redirect for /share/r|v|p/ links is only
  // served to non-browser User-Agents (curl, wget, etc.). Browser UAs
  // (Chrome, Firefox) get a JS/login shell instead of the redirect.
  const RESOLVE_UA = 'curl/8.0';

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': RESOLVE_UA,
        'Accept': '*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8_000),
    });
    if (resp.ok && resp.url) {
      let resolved = new URL(resp.url);
      // Facebook redirects /share/p/ links to a login page on some IPs
      // (especially Cloudflare Workers datacenter IPs). If the resolved URL
      // is a login page, discard it and use the original share URL — it's
      // still reader-recoverable and direct-fetchable.
      if (/\/login(\/|$|\?)/i.test(resolved.pathname + resolved.search)) {
        console.error(`[FB-ALBUM-DEBUG] resolveFacebookUrl: redirected to login page — keeping original share URL`);
        return url;
      }
      // Normalise host to www.facebook.com
      const host = resolved.hostname.toLowerCase().replace(/^(m|mobile|touch|web)\./, 'www.');
      resolved.hostname = host;
      stripTracking(resolved);
      // Ensure trailing slash for consistent cache keys
      let path = resolved.pathname.replace(/\/+$/, '');
      resolved.pathname = path + '/';
      return resolved.toString();
    }
  } catch { /* fall through — use original URL */ }
  return url;
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
/**
 * Convert MediaMeta (from platform sources) back to the FacebookMedia shape
 * that the API route expects.
 */
function mediaMetaToFbMedia(m: MediaMeta): FacebookMedia {
  return {
    title: m.title || 'Facebook Video',
    cover: m.cover || '',
    duration: m.duration || 0,
    hdUrl: m.hdUrl ?? null,
    sdUrl: m.sdUrl ?? null,
    author: { name: m.authorName || '', avatar: m.authorAvatar || '' },
    like_count: m.stats.likes ?? 0,
    comment_count: m.stats.comments ?? 0,
    share_count: m.stats.shares ?? 0,
    view_count: m.stats.views ?? 0,
  };
}

export async function fetchFacebookMedia(inputUrl: string): Promise<FacebookMedia> {
  return memoSWR(`fb:media:${inputUrl}`, MEDIA_TTL_MS, MEDIA_STALE_MS, async () => {
    let pageUrl = await resolveFacebookUrl(inputUrl);
    const result = await runWithFallback(pageUrl, facebookSources());
    console.log(`[Facebook] Resolved via ${result.source} in ${result.attemptMs}ms`);
    return mediaMetaToFbMedia(result.data);
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

    // Resolve share/short links to canonical URLs before extraction.
    const resolvedUrl = await resolveFacebookUrl(inputUrl);

    // First: try to extract story segments directly from the page HTML.
    // The story.php page may contain data-sjs blobs even when
    // fetchFacebookMedia's extractMediaFromPageHtml doesn't find playable_url.
    try {
      const { html } = await fetchPage(resolvedUrl);
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
      if (detectUnavailable(html, resolvedUrl) === FB_ERR.LOGIN_REQUIRED) {
        errors.push(`[${FB_ERR.LOGIN_REQUIRED}] Story page requires login.`);
      }
    } catch (err: any) {
      errors.push(err?.message || 'Direct story page parse failed.');
    }

    // Second: try the classic video pipeline (page → embed → yt-dlp).
    const candidates = new Set<string>([resolvedUrl]);
    const storyFbid = resolvedUrl.match(/[?&]story_fbid=(\d+)/)?.[1];
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
    const proxyHtml = await fetchStoryViaReaderProxy(resolvedUrl);
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
 * a clean (unflagged) IP. Uses `web.facebook.com` host which returns full
 * content even when www./m. are shelled. Returns the raw HTML so
 * parseStoryPage can extract data-sjs blobs. Never throws — returns empty
 * string on failure.
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
      const text = await resp.text();
      // Facebook login wall: the reader proxy got a login page instead of the story.
      // This is Facebook's anti-scraping behavior — not a code bug.
      if (detectLoginWall(text)) {
        console.error(`[Facebook] Story reader proxy: LOGIN WALL detected from ${u} — skipping`);
        return '';
      }
      return text;
    } catch {
      return '';
    }
  };

  // KEY FIX: Always try web.facebook.com first — it returns full post content
  // through the reader proxy even when www./m. are login-walled.
  const webUrl = toWebHost(url);
  let html = await attempt(webUrl);
  if (!html || html.length < 500) {
    html = await attempt(url);
  }
  if (!html || html.length < 500) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    html = await attempt(webUrl);
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
 * after). Canceling the stream keeps the fetch fast and memory-light.
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
  /** Total photos in the post when Facebook's "+N" overflow is detected. */
  totalPhotoCount?: number;
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
 * Fetch all photos from a Facebook album. The album page
 * (/{user}/albums/{albumId}) lists every photo with thumbnails. We extract
 * photo IDs from the page, then fetch each photo's full-size URL via the
 * reader proxy (which returns signed CDN URLs that work from any IP).
 */
async function fetchAlbumPhotos(
  albumId: string,
  originalUrl: string
): Promise<FacebookPhotoSet> {
  console.error(`[FB-ALBUM-DEBUG] Album fetch: albumId=${albumId}`);
  // Build album page URL variants for the reader proxy
  const albumUrls = [
    `https://www.facebook.com/albums/${albumId}`,
    `https://web.facebook.com/albums/${albumId}`,
  ];

  const recovered = new Map<string, PhotoCandidate>();
  let albumHtml = '';

  // Fetch album page through reader proxy to extract all photo IDs + CDN URLs
  for (const albumUrl of albumUrls) {
    try {
      console.error(`[FB-ALBUM-DEBUG] Album reader: fetching https://r.jina.ai/${toWebHost(albumUrl)}`);
      const resp = await fetch(`https://r.jina.ai/${toWebHost(albumUrl)}`, {
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(READER_FALLBACK_TIMEOUT_MS),
      });
      console.error(`[FB-ALBUM-DEBUG] Album reader: status=${resp.status} for ${albumUrl}`);
      if (!resp.ok) {
        console.error(`[FB-ALBUM-DEBUG] Album reader proxy returned ${resp.status} for ${albumUrl}`);
        continue;
      }
      const text = await resp.text();
      if (text.length > albumHtml.length) albumHtml = text;
      console.error(`[FB-ALBUM-DEBUG] Album reader: got ${text.length} chars from ${albumUrl}`);
      console.log(`[FB-RAW-DEBUG] ALBUM READER TEXT (${text.length} chars) from ${albumUrl}:`);
      console.log(text.substring(0, 3000));
      console.log(`[FB-RAW-DEBUG] END RAW (showing ${Math.min(text.length, 3000)} of ${text.length})`);

      // Facebook login wall: skip this response
      if (detectLoginWall(text)) {
        console.error(`[FB-ALBUM-DEBUG] Album reader: LOGIN WALL detected from ${albumUrl} — skipping`);
        continue;
      }

      // Extract photo IDs from photo.php?fbid= links in the album page
      const fbidRe = /photo\.php\?fbid=(\d{5,30})/g;
      const photoIds = new Set<string>();
      for (const m of text.matchAll(fbidRe)) {
        photoIds.add(m[1]);
      }
      console.error(`[FB-ALBUM-DEBUG] Album fbid regex found ${photoIds.size} IDs: ${[...photoIds].slice(0, 10).join(', ')}${photoIds.size > 10 ? '...' : ''}`);

      // Also extract from markdown links: [text](url/photo.php?fbid=...)
      const mdLinkRe = /\(https?:\/\/[^)]*photo\.php\?fbid=(\d{5,30})[^)]*\)/g;
      for (const m of text.matchAll(mdLinkRe)) {
        photoIds.add(m[1]);
      }
      console.error(`[FB-ALBUM-DEBUG] After markdown links: ${photoIds.size} IDs total`);

      // Also extract from /photos/{id} paths
      const photoPathRe = /\/photos\/(\d{5,30})/g;
      for (const m of text.matchAll(photoPathRe)) {
        photoIds.add(m[1]);
      }
      console.error(`[FB-ALBUM-DEBUG] After photo paths: ${photoIds.size} IDs total: ${[...photoIds].slice(0, 15).join(', ')}${photoIds.size > 15 ? '...' : ''}`);

      if (photoIds.size > 0) {
        console.error(`[FB-ALBUM-DEBUG] Album reader found ${photoIds.size} photo IDs from ${albumUrl}`);
        // Use fetchSiblingsViaReader to get CDN URLs for all photo IDs
        const prevSize = recovered.size;
        const { sawLoginWall } = await fetchSiblingsViaReader(toWebHost(albumUrl), [...photoIds], recovered);
        console.error(`[FB-ALBUM-DEBUG] fetchSiblingsViaReader: recovered went from ${prevSize} to ${recovered.size} (wanted ${photoIds.size} IDs, loginWall=${sawLoginWall})`);
        if (sawLoginWall) console.error(`[FB-ALBUM-DEBUG] Reader hit Facebook login wall for album ${albumUrl}`);
        if (recovered.size >= photoIds.size) break; // Got all photos
      }

      // Also extract raw CDN URLs directly from the album page
      const rawRe = /https?:\/\/[^()\s"']+scontent[^()\s"']*/g;
      const seen = new Set<string>();
      let rawCount = 0;
      for (const m of text.matchAll(rawRe)) {
        const raw = m[0].replace(/&amp;/g, '&');
        if (seen.has(raw)) continue;
        seen.add(raw);
        if (isNonPhotoAssetUrl(raw)) continue;
        const id = photoIdFromUrl(raw);
        if (!id || recovered.has(id)) continue;
        const candidate = { url: promotePhotoUrl(raw), alt: stripCtpCap(raw) };
        if (photoQualityScore(candidate.url) > MIN_FULL_PHOTO_SCORE) {
          recovered.set(id, candidate);
          rawCount++;
        }
      }
      console.error(`[FB-ALBUM-DEBUG] Raw CDN extraction added ${rawCount} photos (total: ${recovered.size})`);

      // Also extract from markdown image syntax
      const mdImgRe = /!\[[^\]]*\]\((https?:\/\/[^)\s]+scontent[^)\s]*)\)/g;
      let mdCount = 0;
      for (const m of text.matchAll(mdImgRe)) {
        const raw = m[1].replace(/&amp;/g, '&');
        if (seen.has(raw)) continue;
        seen.add(raw);
        if (isNonPhotoAssetUrl(raw)) continue;
        const id = photoIdFromUrl(raw);
        if (!id || recovered.has(id)) continue;
        const candidate = { url: promotePhotoUrl(raw), alt: stripCtpCap(raw) };
        if (photoQualityScore(candidate.url) > MIN_FULL_PHOTO_SCORE) {
          recovered.set(id, candidate);
          mdCount++;
        }
      }
      console.error(`[FB-ALBUM-DEBUG] Markdown image extraction added ${mdCount} photos (total: ${recovered.size})`);

      if (recovered.size > 0) break;
    } catch (e: any) {
      console.error(`[FB-ALBUM-DEBUG] Album reader failed for ${albumUrl}: ${e?.message ?? e}`);
    }
  }

  console.error(`[FB-ALBUM-DEBUG] Album reader recovered ${recovered.size} photos from CDN`);

  // If reader proxy didn't recover enough, try fetching individual photo pages
  // with concurrency control — for large albums (50+), limit parallel requests
  // and add delays between batches to prevent CDN URL expiry.
  console.error(`[FB-ALBUM-DEBUG] Fallback gate: recovered.size=${recovered.size}, albumHtml.length=${albumHtml.length}`);
  if (recovered.size < 3 && albumHtml) {
    const fbidRe = /photo\.php\?fbid=(\d{5,30})/g;
    const photoIds = new Set<string>();
    for (const m of albumHtml.matchAll(fbidRe)) {
      photoIds.add(m[1]);
    }
    const missingIds = [...photoIds].filter((id) => !recovered.has(id));
    console.error(`[FB-ALBUM-DEBUG] Fallback: ${photoIds.size} IDs in HTML, ${missingIds.length} missing from recovered`);
    if (missingIds.length > 0) {
      console.error(`[FB-ALBUM-DEBUG] Album fallback: fetching ${missingIds.length} individual photo pages`);
      // Process in batches of 10 with 1s delay between batches for large albums
      const BATCH_SIZE = 10;
      for (let i = 0; i < missingIds.length; i += BATCH_SIZE) {
        const batch = missingIds.slice(i, i + BATCH_SIZE);
        console.error(`[FB-ALBUM-DEBUG] Fallback batch ${Math.floor(i / BATCH_SIZE) + 1}: fetching [${batch.join(', ')}]`);
        const full = await fetchSiblingPhotosFull(batch);
        let batchAdded = 0;
        for (const [id, candidate] of full) {
          if (!recovered.has(id)) { recovered.set(id, candidate); batchAdded++; }
        }
        console.error(`[FB-ALBUM-DEBUG] Fallback batch ${Math.floor(i / BATCH_SIZE) + 1}: added ${batchAdded} photos (total: ${recovered.size})`);
        // Delay between batches for large albums to prevent CDN throttling
        if (i + BATCH_SIZE < missingIds.length) {
          await sleep(1_000);
        }
      }
    }
  }

  console.error(`[FB-ALBUM-DEBUG] Album total recovered BEFORE quality enforcement: ${recovered.size} photos`);

  if (recovered.size === 0) {
    console.error(`[FB-ALBUM-DEBUG] Album ABORT: zero photos recovered, throwing NO_MEDIA`);
    throw coded('Could not load this Facebook album. The album may be private or empty.', FB_ERR.NO_MEDIA);
  }

  let bestCandidates = [...recovered.values()];
  const beforeQuality = bestCandidates.length;
  bestCandidates = enforcePhotoQuality(bestCandidates);
  console.error(`[FB-ALBUM-DEBUG] Quality enforcement: ${beforeQuality} -> ${bestCandidates.length} photos (filtered ${beforeQuality - bestCandidates.length})`);

  // Extract title from album page
  let title = 'Facebook Album';
  if (albumHtml) {
    const titleMatch = albumHtml.match(/<title[^>]*>([^<]+)<\/title>/i)
      || albumHtml.match(/^(.+?)(?:\s*[-|]\s*Facebook)$/m);
    if (titleMatch) title = titleMatch[1].replace(/\s*\|\s*Facebook\s*$/i, '').trim() || title;
  }

  const authorMatch = albumHtml?.match(/"pageName"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const authorName = authorMatch ? unescapeJsonString(authorMatch[1]) : '';

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
export async function fetchFacebookPhotoSet(inputUrl: string, albumId?: string | null): Promise<FacebookPhotoSet> {
  // When an album ID is present, fetch the full album instead of a single photo.
  const cacheKey = albumId ? `fb:album:${albumId}` : `fb:photos:${inputUrl}`;
  return memoSWR(cacheKey, MEDIA_TTL_MS, MEDIA_STALE_MS, async () => {
    console.error(`[FB-ALBUM-DEBUG] fetchFacebookPhotoSet: url=${inputUrl} albumId=${albumId ?? 'none'} cacheKey=${cacheKey}`);

    // ─── Share-link redirect resolution ─────────────────────────────────
    // Facebook /share/p/{code} links are opaque shortcodes — the actual
    // post URL (with fbid, set=a.{albumId}, etc.) is only revealed after
    // following the 302 redirect. Without this, the URL parser sees
    // albumId=null and the reader proxy gets a loading shell every time.
    let resolvedUrl = inputUrl;
    let resolvedParsed = null;
    if (/\/share\/[rp]\//i.test(inputUrl)) {
      try {
        console.error(`[FB-ALBUM-DEBUG] Resolving share link: ${inputUrl}`);
        const finalUrl = await resolveFacebookUrl(inputUrl);
        if (finalUrl !== inputUrl) {
          console.error(`[FB-ALBUM-DEBUG] Resolved share link ${inputUrl} → ${finalUrl}`);
          resolvedUrl = finalUrl;
          resolvedParsed = parseFacebookUrl(finalUrl);
          console.error(`[FB-ALBUM-DEBUG] Re-parsed resolved URL:`, JSON.stringify(resolvedParsed, null, 2));
          // If the resolved URL revealed an albumId, use it
          if (resolvedParsed.albumId && !resolvedParsed.albumId.startsWith('pcb.')) {
            console.error(`[FB-ALBUM-DEBUG] Resolved URL has albumId=${resolvedParsed.albumId} → routing to album fetch`);
            return fetchAlbumPhotos(resolvedParsed.albumId, resolvedUrl);
          }
        } else {
          console.error(`[FB-ALBUM-DEBUG] Share link did not redirect (same URL returned)`);
        }
      } catch (e: any) {
        console.error(`[FB-ALBUM-DEBUG] Share link resolve failed: ${e?.message ?? e} — falling through to original URL`);
      }
    }

    // ─── Album path: fetch all photos from a Facebook album ──────────────
    // pcb.{postId} is NOT a real album — it's a carousel post ID used in
    // the `set=pcb.{postId}` parameter. Skip album fetch and let the normal
    // extraction + reader proxy path recover all carousel siblings.
    // Also check resolvedParsed (from share-link redirect resolution above).
    const effectiveAlbumId = albumId || resolvedParsed?.albumId || null;
    if (effectiveAlbumId && !effectiveAlbumId.startsWith('pcb.')) {
      console.error(`[FB-ALBUM-DEBUG] Routing to album fetch: albumId=${effectiveAlbumId} (source: ${albumId ? 'original' : 'resolved'})`);
      return fetchAlbumPhotos(effectiveAlbumId, resolvedUrl);
    }
    if (effectiveAlbumId?.startsWith('pcb.')) {
      console.error(`[FB-ALBUM-DEBUG] Carousel post detected (pcb), using reader proxy path`);
    }

    // Use resolved URL for the actual photo page fetch attempts (if resolved
    // URL differs from original, it carries the real fbid/post path).
    const fetchUrl = resolvedUrl !== inputUrl ? resolvedUrl : inputUrl;
    console.error(`[FB-ALBUM-DEBUG] Using fetch URL: ${fetchUrl} (resolved=${resolvedUrl !== inputUrl})`);
    const attempts: Array<[string, string]> = [];
    for (const u of hostVariantsOf(fetchUrl)) {
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
      let resultIdx = 0;
      for (const result of results) {
        resultIdx++;
        if (result.status === 'rejected') {
          if (result.reason?.code === FB_ERR.NOT_AVAILABLE) sawNotFound = true;
          if (result.reason?.code === FB_ERR.TIMEOUT) sawTimeout = true;
          console.error(`[FB-RAW-DEBUG] bestFrom result #${resultIdx}: REJECTED (${result.reason?.code ?? result.reason?.message ?? 'unknown'})`);
          continue;
        }
        const html = result.value.html;
        console.error(`[FB-RAW-DEBUG] bestFrom result #${resultIdx}: OK, html.length=${html.length}, truncated=${result.value.truncated}`);
        console.log(`[FB-RAW-DEBUG] DIRECT FETCH HTML #${resultIdx} (${html.length} chars):`);
        console.log(html.substring(0, 3000));
        console.log(`[FB-RAW-DEBUG] END DIRECT #${resultIdx} (showing ${Math.min(html.length, 3000)} of ${html.length})`);
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
    console.error(`[Facebook] Initial round: ${bestCandidates.length} photos found, shell=${sawShell} truncated=${sawTruncated} timeout=${sawTimeout} notFound=${sawNotFound}`);
    if (bestHtml) {
      console.log(`[FB-RAW-DEBUG] DIRECT PAGE BEST HTML (${bestHtml.length} chars):`);
      console.log(bestHtml.substring(0, 3000));
      console.log(`[FB-RAW-DEBUG] END RAW (showing ${Math.min(bestHtml.length, 3000)} of ${bestHtml.length})`);
    } else {
      console.error(`[FB-RAW-DEBUG] No bestHtml — ALL results were rejected or had 0 candidates`);
    }

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

    // ─── Graph API layer (optional, needs FB_APP_TOKEN) ─────────────────
    // When FB_APP_TOKEN is set, try the Graph API which returns ALL image
    // sizes per photo at full resolution. This is the highest-quality path
    // and works even when the IP is fully flagged. Silent no-op when token
    // is not configured.
    if (bestCandidates.length < 2) {
      try {
        const graphCandidates = await fetchPhotosViaGraphApi(fetchUrl);
        if (graphCandidates && graphCandidates.length > bestCandidates.length) {
          console.error(`[Facebook] Graph API returned ${graphCandidates.length} photos`);
          bestCandidates = graphCandidates;
        }
      } catch { /* silent — Graph API is optional */ }
    }

    // Track whether the reader proxy hit a Facebook login wall (anti-scraping
    // block). This is NOT a code bug — Facebook variable-blocks some posts from
    // anonymous/bot readers. Used to give the user a specific error message.
    let sawLoginWallFromReader = false;

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
    // Carousel posts (set=pcb.{postId}) always need the reader proxy — the photo
    // page shows only one photo but the post contains multiple. Force reader
    // recovery even when 1 photo was found without truncation/shell.
    const isCarousel = /set=pcb\.\d{5,30}/.test(fetchUrl);
    const needsReader =
      bestCandidates.length === 0 ||
      (bestCandidates.length === 1 && (sawTruncated || sawShell || sawTimeout || isCarousel));
    // Detect the "+N" overflow indicator from the direct HTML first, then
    // let the reader proxy update it if it finds a higher count.
    let extraPhotoCount = detectExtraPhotoCount(bestHtml);
    console.error(`[FB-RAW-DEBUG] needsReader=${needsReader}, hasCookies=${hasCookies}, bestCandidates=${bestCandidates.length}, isReaderRecoverable=${isReaderRecoverableUrl(fetchUrl)}`);
    if (needsReader && !(hasCookies && bestCandidates.length >= 1)) {
      if (isReaderRecoverableUrl(fetchUrl)) {
        console.error(`[FB-RAW-DEBUG] Reader proxy: recovering siblings (carousel=${isCarousel}), url=${fetchUrl}`);
        const recovered = new Map<string, PhotoCandidate>();
        const readerResult = await fetchSiblingsViaReader(fetchUrl, null, recovered);
        const readerExtra = readerResult.extraCount;
        if (readerResult.sawLoginWall) sawLoginWallFromReader = true;
        console.error(`[FB-RAW-DEBUG] Reader proxy returned: ${recovered.size} photos recovered, extra=${readerExtra}, loginWall=${readerResult.sawLoginWall}`);
        if (readerExtra > extraPhotoCount) extraPhotoCount = readerExtra;
        console.error(`[Facebook] Reader recovered ${recovered.size} photos (extra count: ${readerExtra})`);
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

    // ─── Browser Run fallback (Cloudflare Browser Rendering) ────────────
    // When the reader proxy hit a login wall and we have few/no candidates,
    // try loading the page via a real Chromium browser. This uses Cloudflare's
    // Browser Run service which runs on clean IPs and executes JavaScript —
    // bypassing the login walls that lightweight fetchers trigger.
    // Only for photo extraction: the browser fetches the share page HTML and
    // we extract photo URLs from the rendered DOM (same as reader proxy).
    const needsBrowser =
      bestCandidates.length === 0 &&
      sawLoginWallFromReader &&
      _env.MYBROWSER;
    if (needsBrowser && isReaderRecoverableUrl(fetchUrl)) {
      console.error(`[FB-BROWSER] Reader hit login wall, trying Browser Run for ${fetchUrl}`);
      const browserResult = await fetchWithBrowser(_env, toWebHost(fetchUrl));
      if (browserResult?.html) {
        const browserCandidates = extractPhotosFromHtml(browserResult.html);
        console.error(`[FB-BROWSER] Browser returned ${browserCandidates.length} photo candidates`);
        if (browserCandidates.length > bestCandidates.length) {
          bestCandidates = browserCandidates;
          // Reset login wall flag — browser succeeded
          sawLoginWallFromReader = false;
        }
      }
    }

    if (bestCandidates.length === 0) {
      if (sawNotFound) {
        throw coded('This photo is private or was deleted.', FB_ERR.NOT_AVAILABLE);
      }
      if (sawLoginWallFromReader) {
        throw coded(
          'This Facebook post\'s privacy settings are preventing access. Facebook sometimes blocks anonymous access to public posts — try a different public post.',
          FB_ERR.LOGIN_REQUIRED
        );
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
      console.error(`[Facebook] Upgrading ${thumbIds.size} thumbnail-only photos via photo.php`);
      const full = await fetchSiblingPhotosFull([...thumbIds.keys()], fetchUrl);
      let upgraded = 0;
      for (const c of bestCandidates) {
        const id = photoIdFromUrl(c.alt);
        const up = id && full.get(id);
        if (up) {
          c.url = up.url;
          c.alt = up.alt;
          upgraded++;
        }
      }
      console.error(`[Facebook] Thumb upgrade: ${upgraded}/${thumbIds.size} succeeded`);
    }

    console.error(`[Facebook] Final result: ${bestCandidates.length} photos, title="${bestCandidates.length > 0 ? '...' : ''}"`);

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
      ...(extraPhotoCount > 0 ? { totalPhotoCount: photos.length + extraPhotoCount } : {}),
    };
  });
}

/**
 * Try fetching photo metadata via the Facebook Graph API. Returns the highest
 * resolution image URL for each photo in the post. Requires an App Access
 * Token (FB_APP_TOKEN env var) — public page photos work with any token,
 * individual user photos need user_photos permission. Returns null when:
 *  - No FB_APP_TOKEN is configured (silent fallback to other layers)
 *  - The post is private/not found
 *  - The response contains no images
 *
 * Graph API returns ALL image sizes per photo — we pick the largest.
 * For multi-photo posts (carousel), each photo's fbid is extracted from the
 * post's `attachments` field.
 */
async function fetchPhotosViaGraphApi(
  postUrl: string
): Promise<PhotoCandidate[] | null> {
  const token = envStr(_env, 'FB_APP_TOKEN');
  if (!token) return null;

  // Extract the post ID from the URL. Graph API needs the numeric post ID,
  // which we can get from the oembed endpoint or by resolving the URL.
  // For share/p/{code} links, we need to resolve to the actual post URL first.
  let resolvedUrl = postUrl;
  try {
    resolvedUrl = await resolveFacebookUrl(postUrl);
  } catch { /* use original */ }

  // Try to extract fbid from various URL patterns
  const fbid =
    resolvedUrl.match(/[?&]story_fbid=(\d+)/)?.[1] ||
    resolvedUrl.match(/\/posts\/([A-Za-z0-9_-]+)/)?.[1] ||
    resolvedUrl.match(/\/permalink\/([A-Za-z0-9_-]+)/)?.[1] ||
    resolvedUrl.match(/\/photo\.php\?fbid=(\d+)/)?.[1] ||
    resolvedUrl.match(/\/photo\/\?fbid=(\d+)/)?.[1] ||
    resolvedUrl.match(/\/pfbid([A-Za-z0-9_-]+)/)?.[1];

  if (!fbid) return null;

  // Graph API query: get attachments (photos) with all image sizes
  const fields = 'attachments{media,subattachments{media},type},message';
  const apiUrl = `https://graph.facebook.com/v21.0/${fbid}?fields=${fields}&access_token=${token}`;

  try {
    const resp = await fetch(apiUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;

    const json = await resp.json() as any;
    if (json.error) return null;

    const candidates: PhotoCandidate[] = [];
    const seen = new Set<string>();

    const collectFromMedia = (media: any) => {
      if (!media || typeof media !== 'object') return;
      // images array has all sizes — pick the largest
      if (Array.isArray(media.images)) {
        let bestUrl = '';
        let bestSize = 0;
        for (const img of media.images) {
          const size = (img.width || 0) * (img.height || 0);
          if (size > bestSize && img.source) {
            bestSize = size;
            bestUrl = img.source;
          }
        }
        if (bestUrl && !seen.has(bestUrl)) {
          seen.add(bestUrl);
          candidates.push({ url: promotePhotoUrl(bestUrl), alt: stripCtpCap(bestUrl) });
        }
      }
      // Fallback: single source URL
      if (media.source && !seen.has(media.source)) {
        seen.add(media.source);
        candidates.push({ url: promotePhotoUrl(media.source), alt: stripCtpCap(media.source) });
      }
    };

    // Walk attachments (carousel posts have multiple)
    const attachments = json.attachments?.data || [];
    for (const att of attachments) {
      if (att.media) collectFromMedia(att.media);
      // Sub-attachments for carousel posts
      const subAttachments = att.subattachments?.data || [];
      for (const sub of subAttachments) {
        if (sub.media) collectFromMedia(sub.media);
      }
    }

    return candidates.length > 0 ? candidates : null;
  } catch {
    return null;
  }
}

const SIBLING_PAGE_TIMEOUT_MS = 6_000;

/** True for URLs the reader proxy can reliably render for unflagged readers.
 *  web.facebook.com is the KEY host — it returns full post content through
 *  the reader proxy even when www./m. are login-walled. Expanded to cover
 *  photo pages, share links, post permalinks, and photo.php pages.
 *  Called with full `https://…` URLs. */
function isReaderRecoverableUrl(u: string): boolean {
  return (
    /\/share\/p\/[A-Za-z0-9_-]{4,20}\/?$/.test(u) ||
    /\/[A-Za-z0-9._-]+\/(?:posts|permalink)\/[A-Za-z0-9_-]{8,80}\/?$/.test(u) ||
    /\/groups\/[A-Za-z0-9._-]+\/(?:posts|permalink)\/[A-Za-z0-9_-]{8,80}\/?$/.test(u) ||
    /\/permalink\.php\b/i.test(u) ||
    /\/photo\.php\?fbid=\d{5,30}/.test(u) ||
    /\/photo\/\?fbid=\d{5,30}/.test(u) ||
    /\/photos\/[A-Za-z0-9._-]+\/\d+/i.test(u) ||
    /\/albums\/\d+/.test(u) ||
    // Carousel posts: photo.php?fbid=X&set=pcb.{postId}
    /set=pcb\.\d{5,30}/.test(u)
  );
}

const READER_FALLBACK_TIMEOUT_MS = 20_000;

/**
 * Convert any Facebook URL to the `web.facebook.com` host variant. The reader
 * proxy (r.jina.ai) gets the FULL post content from `web.facebook.com` even
 * when `www.` / `m.` shells the page — verified live: `www.` returns a 1542B
 * error shell, `web.` returns the full 18KB+ page with every carousel photo
 * at s590 (which we strip to full-res via `stripCtpCap`).
 */
function toWebHost(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = 'web.facebook.com';
    return u.toString();
  } catch {
    return url.replace(/^https:\/\/[^/]+/, 'https://web.facebook.com');
  }
}

/**
 * Fetch the share page through a public reader proxy (r.jina.ai — unflagged
 * IPs) and collect signed CDN URLs for the photos in it. The signatures are
 * IP-independent, so the URLs download from any IP; `wantIds` limits the set
 * to specific siblings, or `null` accepts every photo in the post. Never
 * throws — flagged/throttled reads just keep the thumbnails.
 *
 * KEY FIX: Always tries `web.facebook.com` host first — this host returns
 * the full post content through the reader proxy even when www./m. hosts
 * return login walls or error shells. Parses BOTH raw scontent URLs (from
 * HTML pages) AND markdown image syntax `![...](scontent-url)` (from the
 * reader's markdown output).
 */

/** Detect the "+N" overflow indicator from Facebook carousel pages. */
function detectExtraPhotoCount(text: string): number {
  // HTML: aria-label="+10"
  const htmlAttr = text.match(/aria-label="\+(\d+)"/);
  if (htmlAttr) return parseInt(htmlAttr[1], 10);
  // Markdown: ... +10](https://...)
  const mdLink = text.match(/\+(\d+)\]\(https?:\/\//);
  if (mdLink) return parseInt(mdLink[1], 10);
  // Plain text: "+10" near end of carousel
  const plain = text.match(/\b\+(\d{1,4})\b/);
  if (plain) return parseInt(plain[1], 10);
  return 0;
}

async function fetchSiblingsViaReader(
  shareUrl: string,
  wantIds: string[] | null,
  found: Map<string, PhotoCandidate>
): Promise<{ extraCount: number; sawLoginWall: boolean }> {
  let maxExtraCount = 0;
  let sawLoginWall = false;
  const extractPhotos = (text: string, want: Set<string> | null, sourceUrl: string): boolean => {
    let foundAny = false;
    const seen = new Set<string>();

    // Pattern 1: Raw scontent CDN URLs (HTML pages, text/plain output)
    const rawRe = /https?:\/\/[^()\s"']+scontent[^()\s"']*/g;
    let rawMatches = 0;
    for (const m of text.matchAll(rawRe)) {
      rawMatches++;
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
        foundAny = true;
      }
    }
    console.error(`[FB-ALBUM-DEBUG] extractPhotos(${sourceUrl}): ${rawMatches} raw scontent matches, ${found.size} unique photos in map`);

    // Pattern 2: Markdown image syntax ![...](scontent-url) — the reader
    // proxy returns markdown when fetching web.facebook.com pages. Each
    // carousel photo is: [![Image N](CDN-URL)](photo-page-link)
    const mdRe = /!\[[^\]]*\]\((https?:\/\/[^)\s]+scontent[^)\s]*)\)/g;
    let mdMatches = 0;
    for (const m of text.matchAll(mdRe)) {
      mdMatches++;
      const raw = m[1];
      if (seen.has(raw)) continue;
      seen.add(raw);
      if (isNonPhotoAssetUrl(raw)) continue;
      const id = photoIdFromUrl(raw);
      if (!id || (want && !want.has(id))) continue;
      const clean = raw.replace(/&amp;/g, '&');
      const candidate = { url: promotePhotoUrl(clean), alt: stripCtpCap(clean) };
      if (photoQualityScore(candidate.url) > MIN_FULL_PHOTO_SCORE) {
        found.set(id, candidate);
        foundAny = true;
      }
    }
    console.error(`[FB-ALBUM-DEBUG] extractPhotos(${sourceUrl}): ${mdMatches} markdown image matches, ${found.size} total photos in map`);

    return foundAny;
  };

  let anyAttemptRan = false;
  const attempt = async (url: string): Promise<boolean> => {
    anyAttemptRan = true;
    try {
      console.error(`[FB-ALBUM-DEBUG] fetchSiblingsViaReader: fetching https://r.jina.ai/${url}`);
      const resp = await fetch(`https://r.jina.ai/${url}`, {
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(READER_FALLBACK_TIMEOUT_MS),
      });
      console.error(`[FB-ALBUM-DEBUG] fetchSiblingsViaReader: status=${resp.status} for ${url}`);
      if (!resp.ok) {
        // Non-200 from reader proxy (rate-limit, block, etc.) — treat as
        // inaccessible, same as a login wall, so the caller surfaces an
        // honest message instead of a generic "could not load".
        console.error(`[FB-ALBUM-DEBUG] fetchSiblingsViaReader: non-ok ${resp.status} from ${url} — marking as blocked`);
        sawLoginWall = true;
        return false;
      }
      const text = await resp.text();
      console.error(`[FB-ALBUM-DEBUG] fetchSiblingsViaReader: got ${text.length} chars from ${url}`);
      console.log(`[FB-RAW-DEBUG] SIBLINGS READER TEXT (${text.length} chars) from ${url}:`);
      console.log(text.substring(0, 3000));
      console.log(`[FB-RAW-DEBUG] END RAW (showing ${Math.min(text.length, 3000)} of ${text.length})`);

      // Facebook login wall: the reader proxy got a login page instead of the post.
      // This is Facebook's anti-scraping behavior — not a code bug. Skip this
      // response and try the next host variant; if all fail, the caller keeps
      // whatever thumbnails were already recovered.
      if (detectLoginWall(text)) {
        console.error(`[FB-ALBUM-DEBUG] fetchSiblingsViaReader: LOGIN WALL detected from ${url} — skipping (Facebook anti-scraping block)`);
        sawLoginWall = true;
        return false;
      }

      const extra = detectExtraPhotoCount(text);
      if (extra > maxExtraCount) maxExtraCount = extra;
      const want = wantIds ? new Set(wantIds.filter((id) => !found.has(id))) : null;
      console.error(`[FB-ALBUM-DEBUG] fetchSiblingsViaReader: wantIds=${wantIds?.length ?? 'null'}, remaining want=${want?.size ?? 'null'}, found already=${found.size}`);
      if (wantIds && want && !want.size) return true;
      return extractPhotos(text, want, url);
    } catch (e: any) {
      console.error(`[FB-ALBUM-DEBUG] fetchSiblingsViaReader failed for ${url}: ${e?.message ?? e}`);
      // Network error / timeout / Workers fetch failure — also treat as
      // inaccessible so the caller shows an honest message.
      sawLoginWall = true;
      return false;
    }
  };

  // KEY FIX: Always try web.facebook.com first — it returns the full post
  // even when www./m. hosts are login-walled or shelled.
  const webUrl = toWebHost(shareUrl);
  if (await attempt(webUrl)) return { extraCount: maxExtraCount, sawLoginWall };

  // Fallback: try the original URL (may work for some post types).
  if (await attempt(shareUrl)) return { extraCount: maxExtraCount, sawLoginWall };

  // Reader proxies rate-limit aggressively — one quick retry before giving up
  // (the caller keeps the thumbnails when this fails).
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  if (await attempt(webUrl)) return { extraCount: maxExtraCount, sawLoginWall };
  await attempt(shareUrl);
  // If every reader proxy attempt ran but none returned photos or a login wall,
  // the proxy itself is likely blocked/rate-limited on this IP (common for
  // Cloudflare Workers datacenter IPs). Mark as blocked so the caller surfaces
  // an honest error instead of a generic "could not load".
  if (anyAttemptRan && found.size === 0 && !sawLoginWall) {
    console.error(`[FB-ALBUM-DEBUG] fetchSiblingsViaReader: all attempts ran but returned 0 photos and no login wall — treating reader as blocked`);
    sawLoginWall = true;
  }
  return { extraCount: maxExtraCount, sawLoginWall };
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
    // Login wall detection is handled at the caller level (fetchFacebookPhotoSet)
  }
  return found;
}

/** First photo of a photo post — kept for the single-photo download path. */
export async function fetchFacebookPhoto(inputUrl: string, albumId?: string | null): Promise<FacebookPhoto> {
  const set = await fetchFacebookPhotoSet(inputUrl, albumId);
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