import { memo, memoSWR } from './cache';
import { resolveTikTokShortLink } from './normalize';
import { cobaltExtractVideo } from './cobalt';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const TIKWM_UA =
  'Mozilla/5.0 (iPad; U; CPU OS 3_2 like Mac OS X; en-us) AppleWebKit/531.21.10 (KHTML, like Gecko) Version/4.0.4 Mobile/7B334b Safari/531.21.10';
const TIKWM_HOSTS = ['https://tikwm.com/api/', 'https://www.tikwm.com/api/'];

const META_TTL_MS = 6 * 60 * 60 * 1000;
const AUDIO_TTL_MS = 2 * 60 * 60 * 1000;
const META_STALE_MS = 6 * 60 * 60 * 1000;
const RESOLVE_TTL_MS = 24 * 60 * 60 * 1000;

export interface TikTokAuthor {
  unique_id: string;
  nickname: string;
  avatar: string | null;
}

export interface TikTokMusicInfo {
  play: string | null;
  title?: string;
  author?: string;
  album?: string | null;
}

export interface TikTokVideoMeta {
  play: string | null;
  hdplay: string | null;
  wmplay: string | null;
  cover: string | null;
  origin_cover: string | null;
  title: string;
  duration: number;
  author: TikTokAuthor;
  digg_count: number;
  comment_count: number;
  share_count: number;
  play_count: number;
  music?: TikTokMusicInfo;
  quality?: { width: number; height: number };
}

export function isValidTikTokUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const validHosts = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'];
    return validHosts.some((h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

function isShortLink(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'vm.tiktok.com' || host === 'vt.tiktok.com' ||
      host.endsWith('.vm.tiktok.com') || host.endsWith('.vt.tiktok.com');
  } catch {
    return false;
  }
}

function cleanUrl(url: string): string {
  return url.split('#')[0].split('?')[0];
}

function extractVideoId(pathname: string): string | null {
  const patterns = [/\/video\/(\d{6,})/, /\/photo\/(\d{6,})/, /\/v\/(\d{6,})/, /\/embed\/v2\/(\d{6,})/];
  for (const p of patterns) {
    const m = pathname.match(p);
    if (m) return m[1];
  }
  const trailing = pathname.match(/(\d{15,})\/?$/);
  return trailing ? trailing[1] : null;
}

async function resolveShortLink(url: string): Promise<string> {
  return memo(`tt:resolve:${url}`, RESOLVE_TTL_MS, async () => {
    try {
      const resp = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': DESKTOP_UA, 'Accept': 'text/html,*/*' },
        signal: AbortSignal.timeout(8_000),
      });
      const finalUrl = cleanUrl(resp.url);
      if (/\/video\/\d+/.test(finalUrl)) return finalUrl;
    } catch {}
    return cleanUrl(url);
  });
}

async function fetchOembedMeta(pageUrl: string): Promise<{ title: string; author: string; cover: string; videoId: string | null } | null> {
  try {
    const resp = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(pageUrl)}`, {
      headers: { 'User-Agent': DESKTOP_UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const videoId = data.html?.match(/\/video\/(\d+)/)?.[1] ?? null;
    return {
      title: data.title || '',
      author: data.author_name || '',
      cover: data.thumbnail_url || '',
      videoId,
    };
  } catch {
    return null;
  }
}

/**
 * PRIMARY ENGINE: TikWM API — fast, reliable, returns direct CDN URLs.
 * Tries two host variants with a tight timeout each.
 */
async function tryTikWM(resolvedUrl: string): Promise<TikTokVideoMeta | null> {
  const run = async (host: string): Promise<TikTokVideoMeta> => {
    const apiUrl = `${host}?url=${encodeURIComponent(resolvedUrl)}&hd=1`;
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': TIKWM_UA, 'Accept': 'application/json', 'Referer': 'https://tikwm.com/' },
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) throw new Error(`TikWM returned ${resp.status}`);
    const data = await resp.json();
    if (data.code !== 0 || !data.data) throw new Error(data.msg || 'TikWM failed');
    const d = data.data;
    const author = d.author ?? {};
    const musicSource = d.music_info ?? d.music;
    return {
      play: d.play ?? d.hdplay ?? null,
      hdplay: d.hdplay ?? d.play ?? null,
      wmplay: d.wmplay ?? null,
      cover: d.cover ?? null,
      origin_cover: d.origin_cover ?? d.cover ?? null,
      title: d.title ?? '',
      duration: d.duration ?? 0,
      author: { unique_id: author.unique_id ?? '', nickname: author.nickname ?? '', avatar: author.avatar ?? null },
      digg_count: d.digg_count ?? 0,
      comment_count: d.comment_count ?? 0,
      share_count: d.share_count ?? 0,
      play_count: d.play_count ?? 0,
      music: musicSource ? {
        play: musicSource.play ?? musicSource.play_url ?? null,
        title: musicSource.title ?? undefined,
        author: musicSource.author ?? undefined,
        album: musicSource.album ?? null,
      } : undefined,
    };
  };
  try {
    return await run(TIKWM_HOSTS[0]);
  } catch {
    try {
      return await run(TIKWM_HOSTS[1]);
    } catch {
      return null;
    }
  }
}

/**
 * FALLBACK ENGINE: Cobalt API — requires turnstile token from client.
 * Uses cobalt's own extraction pipeline.
 */
async function tryCobalt(resolvedUrl: string, turnstileToken?: string): Promise<TikTokVideoMeta | null> {
  if (!turnstileToken) return null;
  try {
    const cobalt = await cobaltExtractVideo(resolvedUrl, turnstileToken);
    if (!cobalt?.url) return null;
    const oembed = await fetchOembedMeta(resolvedUrl);
    return {
      play: cobalt.url,
      hdplay: cobalt.url,
      wmplay: null,
      cover: oembed?.cover || null,
      origin_cover: null,
      title: oembed?.title || 'TikTok video',
      duration: 0,
      author: {
        unique_id: oembed?.author || '',
        nickname: oembed?.author || '',
        avatar: null,
      },
      digg_count: 0,
      comment_count: 0,
      share_count: 0,
      play_count: 0,
    };
  } catch {
    return null;
  }
}

/**
 * Core resolution pipeline:
 *  1. Resolve short links → canonical URL
 *  2. TikWM (primary, fast) + oEmbed metadata (parallel)
 *  3. Cobalt (fallback, needs turnstile token)
 */
async function resolveTikTok(videoUrl: string, turnstileToken?: string): Promise<TikTokVideoMeta> {
  let candidate = videoUrl.trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Invalid URL. Please provide a valid TikTok video link.');
  }

  let videoId = extractVideoId(parsed.pathname);
  let username = (parsed.pathname.match(/^\/@([^/]+)/) || [])[1] || null;

  // Resolve short links (vm.tiktok.com, vt.tiktok.com)
  if (!videoId && isShortLink(candidate)) {
    const resolved = await resolveShortLink(candidate);
    try {
      const rp = new URL(resolved);
      videoId = extractVideoId(rp.pathname);
      username = username || (rp.pathname.match(/^\/@([^/]+)/) || [])[1] || null;
    } catch {}
  }

  // Fallback: use oEmbed to find video ID
  if (!videoId) {
    const oembed = await fetchOembedMeta(candidate);
    if (oembed?.videoId) {
      videoId = oembed.videoId;
      username = null;
    }
  }

  if (!videoId) throw new Error('Could not find a video ID in that link.');

  const canonicalUrl = username
    ? `https://www.tiktok.com/@${username}/video/${videoId}`
    : `https://www.tiktok.com/embed/v2/${videoId}`;

  console.log(`[TikTok] Resolving videoId=${videoId} canonical=${canonicalUrl}`);

  // ─── Tier 1: TikWM (primary) + oEmbed metadata in parallel ───
  const [tikwm, oembed] = await Promise.all([
    tryTikWM(candidate),
    fetchOembedMeta(canonicalUrl),
  ]);

  if (tikwm) {
    // Enrich with oEmbed metadata if TikWM fields are sparse
    if (oembed) {
      if (!tikwm.title && oembed.title) tikwm.title = oembed.title;
      if (!tikwm.author?.nickname && oembed.author) {
        tikwm.author.nickname = oembed.author;
        tikwm.author.unique_id = tikwm.author.unique_id || oembed.author;
      }
      if (!tikwm.cover && oembed.cover) tikwm.cover = oembed.cover;
    }
    console.log(`[TikTok] TikWM SUCCESS: ${tikwm.title.slice(0, 50)}`);
    return tikwm;
  }

  // ─── Tier 2: Cobalt (fallback, requires turnstile token) ───
  console.log('[TikTok] TikWM failed, trying Cobalt...');
  const cobalt = await tryCobalt(candidate, turnstileToken);
  if (cobalt) {
    // Enrich with oEmbed metadata
    if (oembed) {
      if (!cobalt.title || cobalt.title === 'TikTok video') cobalt.title = oembed.title || cobalt.title;
      if (!cobalt.author?.nickname) cobalt.author.nickname = oembed.author || '';
      if (!cobalt.cover) cobalt.cover = oembed.cover || null;
    }
    console.log(`[TikTok] Cobalt SUCCESS`);
    return cobalt;
  }

  throw new Error('All TikTok servers are busy. Please try again.');
}

export async function fetchTikTokMetaWithFallback(
  videoUrl: string,
  opts: { ttlMs?: number; hd?: boolean; turnstileToken?: string } = {}
): Promise<TikTokVideoMeta> {
  const { ttlMs = META_TTL_MS, turnstileToken } = opts;
  const resolved = await resolveTikTokShortLink(videoUrl);
  return memoSWR(`tt:fb:${resolved}`, ttlMs, META_STALE_MS, async () => {
    return resolveTikTok(resolved, turnstileToken);
  });
}

export async function fetchTikTokMeta(
  videoUrl: string,
  opts: { ttlMs?: number; hd?: boolean } = {}
): Promise<TikTokVideoMeta> {
  const { ttlMs = META_TTL_MS } = opts;
  const resolved = isShortLink(videoUrl) ? await resolveShortLink(videoUrl) : cleanUrl(videoUrl);
  return memoSWR(`tt:${resolved}`, ttlMs, META_STALE_MS, async () => {
    return resolveTikTok(resolved);
  });
}

export { AUDIO_TTL_MS, META_TTL_MS };
