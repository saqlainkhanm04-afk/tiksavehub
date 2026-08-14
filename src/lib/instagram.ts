import { memoSWR } from './cache';
import { fetchInstagramWithYtDlp, instagramUrlFor } from './ytdlp';

const STORY_TTL_MS = 6 * 60 * 60 * 1000;
const STORY_STALE_MS = 6 * 60 * 60 * 1000;

const INSTAGRAM_GRAPHQL = 'https://www.instagram.com/graphql/query';
const INSTAGRAM_HOME = 'https://www.instagram.com/';
const INSTAGRAM_API = 'https://i.instagram.com/api/v1';
const SHORTCODE_DOC_ID = '27128499623469141';
const MEDIA_INFO_DOC_ID = '4740221914432035';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Instagram 219.0.0.12.117 Android (23/6.0; 420dpi; 1080x2310; Meizu; Meizu 16; meizu16; zh_CN; 62401037)';

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
    /\/reel\/([^/]+)|\/(?:p|tv)\/([^/]+)|\/stories\/([^/]+)\/(\d+)/
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

async function privateApiRequest<T>(path: string): Promise<T> {
  const sessionCookie = getSessionCookie();
  if (!readSession()) {
    throw new Error('instagram_session_missing');
  }

  const resp = await fetch(`${INSTAGRAM_API}${path}`, {
    headers: {
      'User-Agent': MOBILE_UA,
      Accept: 'application/json, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-IG-Capabilities': '3brTvw==',
      'X-IG-Connection-Type': 'WIFI',
      'X-IG-App-ID': '567067343352427',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.instagram.com',
      Referer: 'https://www.instagram.com/stories/',
      Cookie: sessionCookie,
    },
    signal: AbortSignal.timeout(25_000),
  });

  const text = await resp.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Instagram API returned an invalid response.');
  }

  if (json.message === 'login_required' || json == null && resp.status === 403) {
    throw new Error('instagram_login_required');
  }
  if (json.status && json.status !== 'ok') {
    throw new Error('instagram_request_failed');
  }

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
        if (err?.message === 'instagram_login_required') {
          throw new Error('Could not retrieve this content with the configured Instagram session.');
        }
        throw err;
      }
    }

    return fetchShortcodeWithFallbacks(shortcode, type);
  });
}

export async function fetchStoryByMediaId(mediaId: string, username?: string): Promise<any> {
  return memoSWR(`ig:story:${mediaId}`, STORY_TTL_MS, STORY_STALE_MS, async () => {
    if (hasSession()) {
      try {
        return await fetchMediaByMediaId(mediaId);
      } catch (err: any) {
        if (err?.message === 'instagram_login_required') {
          throw new Error('Stories require an Instagram session, or the story has expired.');
        }
        throw err;
      }
    }

    try {
      const json = await graphqlRequest(MEDIA_INFO_DOC_ID, {
        media_id: mediaId,
        should_track_viewed: false,
      });

      const media = json.data?.xdt_api__v1__media__info__web?.media_union;
      if (!media) {
        throw new Error('No story found. It may have expired, be private, or the link is invalid.');
      }
      return media;
    } catch (err: any) {
      if (!username) throw err;

      try {
        return await fetchInstagramWithYtDlp(
          `https://www.instagram.com/stories/${username}/${mediaId}/`
        );
      } catch (err2: any) {
        throw err;
      }
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