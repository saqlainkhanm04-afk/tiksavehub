import { memoSWR, cacheGet, cacheSet, cacheDelete } from './cache';
import { fetchInstagramWithYtDlp, instagramUrlFor } from './ytdlp';
import { ensureInstagramEnv } from './ig-env';

ensureInstagramEnv();

const STORY_TTL_MS = 6 * 60 * 60 * 1000;
const STORY_STALE_MS = 6 * 60 * 60 * 1000;

// Sentinel error messages — the API route maps these to honest, per-case copy.
export const ERR_SESSION_REQUIRED = 'instagram_session_required';
export const ERR_SESSION_MISSING = 'instagram_session_missing';
export const ERR_LOGIN_REQUIRED = 'instagram_login_required';
export const ERR_STORY_EXPIRED = 'instagram_story_expired';
export const ERR_HIGHLIGHTS_UNSUPPORTED = 'instagram_highlights_not_supported';

const INSTAGRAM_GRAPHQL = 'https://www.instagram.com/graphql/query';
const INSTAGRAM_HOME = 'https://www.instagram.com/';
const INSTAGRAM_API = 'https://i.instagram.com/api/v1';
const INSTAGRAM_API_WEB = 'https://www.instagram.com/api/v1';
const SHORTCODE_DOC_ID = '27128499623469141';
const MEDIA_INFO_DOC_ID = '4740221914432035';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Instagram 219.0.0.12.117 Android (23/6.0; 420dpi; 1080x2310; Meizu; Meizu 16; meizu16; zh_CN; 62401037)';
// Browser sessions are device-bound: the private-API calls only authenticate
// when the request matches the mobile-Chrome client that created the session
// (verified live 2026: web session + full cookie jar + these hints + this UA on
// the www host = 200; any other host/app-UA combination = 403/useragent mismatch).
const MOBILE_WEB_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36';
const MOBILE_WEB_HINTS: Record<string, string> = {
  'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
  'sec-ch-ua-full-version-list':
    '"Not=A?Brand";v="99.0.0.0", "Google Chrome";v="151.0.7922.138", "Chromium";v="151.0.7922.138"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-model': '"Pixel 7"',
  'sec-ch-ua-platform': '"Android"',
  'sec-ch-ua-platform-version': '"13"',
  'sec-ch-prefers-color-scheme': 'dark',
  dpr: '1',
  'viewport-width': '150',
};

const CSRF_TTL_MS = 24 * 60 * 60 * 1000;
const MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
const MEDIA_STALE_MS = 24 * 60 * 60 * 1000;

export type InstagramType = 'video' | 'reels' | 'story' | 'audio';

export interface InstagramParseResult {
  type: InstagramType;
  shortcode?: string;
  mediaId?: string;
  username?: string;
}

function readSession(): string {
  return process.env.IG_SESSIONID || '';
}

export function hasSession(): boolean {
  return Boolean(readSession());
}

function getSessionCookie(): string {
  // Full browser cookie jar (recommended): Instagram's web API now expects the
  // whole cookie family (mid, ig_did, rur, datr...) — sessionid alone gets 403.
  // Get it via DevTools → Network → Copy as cURL → the `cookie: '...'` value.
  const full = process.env.IG_COOKIES || '';
  if (full.trim()) return full.trim();

  const parts: string[] = [];
  const session = readSession();
  if (session) parts.push(`sessionid=${session}`);
  if (process.env.IG_DS_USER_ID) parts.push(`ds_user_id=${process.env.IG_DS_USER_ID}`);
  if (process.env.IG_CSRF_TOKEN) parts.push(`csrftoken=${process.env.IG_CSRF_TOKEN}`);
  return parts.join('; ');
}

export function parseInstagramUrl(rawUrl: string): InstagramParseResult | null {
  let url = rawUrl.trim();

  if (!/^[a-z]+:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const match = parsed.pathname.match(
    /(?:\/reel|\/reels)\/([^/]+)|\/(?:p|tv)\/([^/]+)|\/stories\/([^/]+)\/(\d+)/
  );
  if (!match) return null;

  if (match[1]) return { type: 'reels', shortcode: match[1] };
  if (match[2]) return { type: 'video', shortcode: match[2] };
  if (match[3] && match[4]) return { type: 'story', mediaId: match[4], username: match[3] };

  return null;
}

export function isValidInstagramUrl(rawUrl: string, type?: InstagramType): boolean {
  const parsed = parseInstagramUrl(rawUrl);
  if (!parsed) return false;
  if (!type) return true;
  return parsed.type === type;
}

async function getCsrfToken(): Promise<{ token: string; cookies: string }> {
  const sessionCookie = getSessionCookie();

  return memoSWR('ig:csrf', CSRF_TTL_MS, CSRF_TTL_MS, async () => {
    const resp = await fetch(INSTAGRAM_HOME, {
      headers: {
        'User-Agent': USER_AGENT,
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const setCookies = resp.headers.getSetCookie();
    const csrfCookie = setCookies.find((c) => c.startsWith('csrftoken='));
    const token = csrfCookie ? csrfCookie.split(';')[0].replace('csrftoken=', '') : '';
    const cookies = setCookies.map((c) => c.split(';')[0]).join('; ');
    return {
      token: token || process.env.IG_CSRF_TOKEN || '',
      cookies: [sessionCookie, cookies].filter(Boolean).join('; '),
    };
  });
}

async function graphqlRequest(docId: string, variables: Record<string, unknown>): Promise<any> {
  const { token, cookies } = await getCsrfToken();

  const resp = await fetch(INSTAGRAM_GRAPHQL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': token,
      Cookie: cookies,
      Accept: '*/*',
      Origin: 'https://www.instagram.com',
      Referer: 'https://www.instagram.com/',
    },
    body: new URLSearchParams({
      doc_id: docId,
      variables: JSON.stringify(variables),
      server_timestamps: 'true',
    }),
    signal: AbortSignal.timeout(25_000),
  });

  const text = await resp.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Instagram returned an invalid response.');
  }

  if (json.errors) {
    throw new Error('Could not retrieve this content. It may be private, deleted, or the link is invalid.');
  }

  return json;
}

function isSessionBlockedMessage(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return (
    m === ERR_LOGIN_REQUIRED ||
    m.includes('login_required') ||
    m.includes('challenge_required') ||
    m.includes('checkpoint_required') ||
    m.includes('session_expired') ||
    m.includes('useragent mismatch')
  );
}

function errorWithCode(message: string, code?: string): Error {
  const err = new Error(message);
  if (code) (err as any).code = code;
  return err;
}

/**
 * Bust the memoized CSRF/session cookies and retry once. Instagram frequently
 * rotates csrftoken and rejects stale sessions with challenge/login responses,
 * so a single refresh-and-retry heals the majority of transient session blocks
 * without surfacing them to the user.
 */
async function withSessionRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const msg = err?.message || String(err);
    const code = err?.code || '';
    if (isSessionBlockedMessage(msg) || isSessionBlockedMessage(code)) {
      cacheDelete('ig:csrf');
      return await fn();
    }
    throw err;
  }
}

/**
 * Shared Instagram private-API GET with optional session and per-call headers.
 * `requireSession` endpoints are only reachable with a configured session;
 * `web_profile_info` also works anonymously (verified), which is how we resolve
 * a story username -> user id without any login state.
 */
function csrfFromCookie(cookie: string): string {
  const m = cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return m ? m[1] : '';
}

async function apiGet(
  path: string,
  opts: { requireSession?: boolean; extra?: Record<string, string> } = {}
): Promise<{ status: number; json: any }> {
  const sessionCookie = getSessionCookie();
  const sessionAvailable = Boolean(readSession());

  if (opts.requireSession && !sessionAvailable) {
    throw errorWithCode(ERR_SESSION_MISSING, ERR_SESSION_MISSING);
  }

  const usingSession = Boolean(sessionCookie);
  const headers: Record<string, string> = usingSession
    ? {
        'User-Agent': MOBILE_WEB_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-PK,en;q=0.9,ur-PK;q=0.8,ur;q=0.7',
        'X-Requested-With': 'XMLHttpRequest',
        'X-IG-App-ID': '936619743392459',
        'X-ASBD-ID': '129477',
        'X-IG-WWW-Claim': '0',
        'X-CSRFToken': csrfFromCookie(sessionCookie) || process.env.IG_CSRF_TOKEN || '',
        Origin: 'https://www.instagram.com',
        Referer: 'https://www.instagram.com/',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        ...MOBILE_WEB_HINTS,
      }
    : {
        'User-Agent': MOBILE_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-IG-Capabilities': '3brTvw==',
        'X-IG-Connection-Type': 'WIFI',
        'X-IG-App-ID': '567067343352427',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://www.instagram.com',
        Referer: 'https://www.instagram.com/stories/',
      };
  if (sessionCookie) headers.Cookie = sessionCookie;
  if (opts.extra) Object.assign(headers, opts.extra);

  const host = usingSession ? INSTAGRAM_API_WEB : INSTAGRAM_API;
  const resp = await fetch(`${host}${path}`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });

  const text = await resp.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  const message = json?.message;
  if (resp.status === 403 || isSessionBlockedMessage(message)) {
    throw errorWithCode(
      ERR_LOGIN_REQUIRED,
      String(message || 'login_required').toLowerCase()
    );
  }
  if (json?.status && json.status !== 'ok') {
    throw new Error(`Instagram API request failed (${resp.status}).`);
  }

  return { status: resp.status, json };
}

async function privateApiRequest<T>(path: string): Promise<T> {
  const { json } = await apiGet(path, { requireSession: true });
  return json as T;
}

function mediaFromItems(json: any): any {
  const items = json?.items;
  if (items && items.length > 0) return items[0];
  if (json?.media) return json.media;
  if (json?.item) return json.item;
  return null;
}

function shortcodeToMediaId(shortcode: string): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = 0n;
  for (const ch of shortcode) {
    id = id * 64n + BigInt(ALPHABET.indexOf(ch));
  }
  return id.toString();
}

async function fetchMediaByMediaId(mediaId: string): Promise<any> {
  const json = await privateApiRequest<any>(`/media/${encodeURIComponent(mediaId)}/info/`);
  const media = mediaFromItems(json);
  if (!media) {
    throw new Error('No media found. The link may be private or invalid.');
  }
  return media;
}

function getMetaContent(html: string, property: string): string {
  const pattern = new RegExp(
    `<meta\\s+property="${property}"\\s+content="([^"]*)"|<meta\\s+content="([^"]*)"\\s+property="${property}"`,
    'i'
  );
  const m = html.match(pattern);
  return m ? (m[1] || m[2] || '') : '';
}

function extractMediaFromEmbedHtml(html: string): any {
  if (html.length < 100) return null;
  const video =
    getMetaContent(html, 'og:video') ||
    getMetaContent(html, 'og:video:secure_url') ||
    getMetaContent(html, 'twitter:player:stream');
  const image = getMetaContent(html, 'og:image') || getMetaContent(html, 'twitter:image');
  const title = getMetaContent(html, 'og:title');
  if (!video && !image) return null;

  const media: any = {
    video_versions: video ? [{ url: video, width: 1080, height: 1920 }] : undefined,
    image_versions_2: image ? { candidates: [{ url: image }] } : undefined,
    display_url: image,
  };
  if (title) media.display_title = title;
  return media;
}

async function fetchFromEmbed(shortcode: string): Promise<any> {
  const paths = [
    `https://www.instagram.com/reel/${shortcode}/embed/captioned/`,
    `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
  ];

  let lastError: any = null;
  for (const path of paths) {
    try {
      const resp = await fetch(path, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,*/*',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
      if (!resp.ok) {
        lastError = new Error(`Embed page returned ${resp.status}`);
        continue;
      }
      const html = await resp.text();
      const media = extractMediaFromEmbedHtml(html);
      if (media) return media;
      lastError = new Error('Embed page returned no media.');
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Embed fallback failed.');
}

async function fetchShortcodeWithFallbacks(shortcode: string, type: string = 'video'): Promise<any> {
  const errors: string[] = [];

  // Primary: public GraphQL with fresh CSRF.
  try {
    const json = await graphqlRequest(SHORTCODE_DOC_ID, {
      shortcode,
      __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
    });
    const items = json?.data?.xdt_api__v1__media__shortcode__web_info?.items;
    if (items && items.length > 0) return items[0];
    errors.push('GraphQL returned no items.');
  } catch (err: any) {
    errors.push(err?.message || 'GraphQL failed.');
  }

  // Fallback: lightweight embed page (OG meta) — much harder for Instagram to block.
  try {
    return await fetchFromEmbed(shortcode);
  } catch (err: any) {
    errors.push(err?.message || 'Embed fallback failed.');
  }

  // Fallback: legacy __a=1 endpoint.
  try {
    const resp = await fetch(`https://www.instagram.com/p/${shortcode}/?__a=1`, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    if (resp.ok) {
      const json = await resp.json();
      const media = json?.graphql?.shortcode_media ?? json?.items?.[0];
      if (media) return media;
      errors.push('__a=1 returned no media.');
    } else {
      errors.push(`__a=1 returned ${resp.status}.`);
    }
  } catch (err: any) {
    errors.push(err?.message || '__a=1 failed.');
  }

  // Fallback: yt-dlp binary (if installed on the server) — the most reliable
  // free provider because it sends a full browser-like request with cookies.
  try {
    return await fetchInstagramWithYtDlp(instagramUrlFor(shortcode, type));
  } catch (err: any) {
    errors.push(err?.message || 'yt-dlp failed.');
  }

  throw new Error(errors[errors.length - 1] || 'Could not load this Instagram content.');
}

export async function fetchMediaByShortcode(shortcode: string, type: string = 'video'): Promise<any> {
  return memoSWR(`ig:media:${shortcode}`, MEDIA_TTL_MS, MEDIA_STALE_MS, async () => {
    if (hasSession()) {
      try {
        return await fetchMediaByMediaId(shortcodeToMediaId(shortcode));
      } catch (err: any) {
        if (err?.message === ERR_LOGIN_REQUIRED) {
          throw new Error('Could not retrieve this content with the configured Instagram session.');
        }
        throw err;
      }
    }

    return fetchShortcodeWithFallbacks(shortcode, type);
  });
}

export async function resolveUserIdByUsername(username: string): Promise<string> {
  const cacheKey = `ig:uid:${username.toLowerCase()}`;
  const cached = cacheGet<string>(cacheKey);
  if (cached) return cached;

  const { json } = await apiGet(`/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  const userId = json?.data?.user?.id;
  if (!userId || !/^\d+$/.test(String(userId))) {
    throw new Error('Could not resolve the Instagram user for this story link.');
  }
  cacheSet(cacheKey, String(userId), 7 * 24 * 60 * 60 * 1000);
  return String(userId);
}

export async function fetchStoryTray(userId: string): Promise<any[]> {
  const { json } = await apiGet(`/feed/reels_media/?reel_ids=${encodeURIComponent(userId)}`, {
    requireSession: true,
  });
  const reels = json?.reels;
  const tray = reels?.[userId] || reels?.[String(userId)] as any;
  const items = Array.isArray(tray?.items) ? tray.items : [];
  return items;
}

export function findStoryInTray(items: any[], mediaId: string): any | null {
  if (!Array.isArray(items)) return null;
  const target = String(mediaId);
  return items.find((it) => String(it?.media_id || it?.pk || it?.id) === target) || null;
}

export function isImageOnlyMedia(media: any): boolean {
  if (!media) return false;
  const mediaType = Number(media.media_type);
  if (mediaType === 1) return true;
  if (mediaType === 2 || mediaType === 8) return false;
  return !getBestVideoUrl(media) && Boolean(getThumbnailUrl(media));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Anonymous story attempt kept as a last chance in case Instagram ever re-opens
 * guest story access. Bounded to ~6s so a guaranteed-fail environment returns an
 * honest error fast instead of hanging on dead endpoints.
 */
async function tryAnonymousStory(mediaId: string): Promise<any> {
  const json = await withTimeout(
    graphqlRequest(MEDIA_INFO_DOC_ID, {
      media_id: mediaId,
      should_track_viewed: false,
    }),
    6_000
  );
  const media = json?.data?.xdt_api__v1__media__info__web?.media_union;
  if (!media) throw new Error('no media item');
  return media;
}

async function fetchStoryWithSession(username: string | undefined, mediaId: string): Promise<any> {
  const errors: string[] = [];

  if (username === 'highlights') {
    throw errorWithCode(ERR_HIGHLIGHTS_UNSUPPORTED);
  }

  // Layer 1: resolve the user -> story tray, locate the exact story by media id.
  if (username) {
    try {
      const userId = await resolveUserIdByUsername(username);
      const tray = await fetchStoryTray(userId);
      const found = findStoryInTray(tray, mediaId);
      if (found) return found;
      if (tray.length > 0) {
        throw errorWithCode(ERR_STORY_EXPIRED);
      }
      errors.push('The story is not in the active story tray.');
    } catch (err: any) {
      if (err?.message === ERR_STORY_EXPIRED || err?.message === ERR_HIGHLIGHTS_UNSUPPORTED) throw err;
      if (err?.message === ERR_LOGIN_REQUIRED) throw err; // session problem — handled by withSessionRetry
      errors.push(err?.message || 'Story tray lookup failed.');
    }
  }

  // Layer 2: direct media info lookup.
  try {
    return await fetchMediaByMediaId(mediaId);
  } catch (err: any) {
    if (err?.message === ERR_LOGIN_REQUIRED || err?.message === ERR_SESSION_MISSING) throw err;
    errors.push(err?.message || 'Media info lookup failed.');
  }

  // Layer 3: yt-dlp with the session cookie header (handles both photo and video stories).
  if (username) {
    try {
      return await fetchInstagramWithYtDlp(`https://www.instagram.com/stories/${username}/${mediaId}/`);
    } catch (err: any) {
      errors.push(err?.message || 'yt-dlp story fetch failed.');
    }
  }

  throw new Error(errors[errors.length - 1] || ERR_STORY_EXPIRED);
}

export async function fetchStoryByMediaId(mediaId: string, username?: string): Promise<any> {
  return memoSWR(`ig:story:${mediaId}`, STORY_TTL_MS, STORY_STALE_MS, async () => {
    if (hasSession()) {
      return withSessionRetry(() => fetchStoryWithSession(username, mediaId));
    }

    try {
      return await tryAnonymousStory(mediaId);
    } catch {
      // Insta stories are session-only content in current builds (2026): the
      // web page is a JS shell, public GraphQL doc ids are dead, reels_media
      // returns empty to guests and media/info returns 403. Fail fast and
      // honestly instead of burning ~90s on dying anonymous sources.
      throw errorWithCode(ERR_SESSION_REQUIRED);
    }
  });
}

export function getBestVideoUrl(media: any): string | null {
  const versions = media.video_versions || media.video_versions_web;
  if (!versions || versions.length === 0) return null;
  const sorted = [...versions].sort((a: any, b: any) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || null;
}

export function getThumbnailUrl(media: any): string {
  const candidates = media.image_versions2?.candidates;
  if (candidates && candidates.length > 0) return candidates[0].url;
  const url = media.display_url;
  return url || '';
}

export function getAudioUrl(media: any): string | null {
  const audioVersions = media.audio_versions;
  if (audioVersions && audioVersions.length > 0) {
    const sorted = [...audioVersions].sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
    if (sorted[0]?.url) return sorted[0].url;
  }
  return null;
}