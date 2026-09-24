import { memo, memoSWR } from './cache';
import { resolveTikTokShortLink } from './normalize';
import { runWithFallback, runWithRace } from './api-fallback';
import {
  tikwmSource,
  cobaltSource,
  tiktokDownbloderSource,
  tiktokItemDetailSource,
  tiktokCdnDirectSource,
} from './platforms/tiktok';
import { tiktokDirectSource } from './platforms/tiktok-direct';
import { thirdPartyApiHeaders } from './platforms/headers';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

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

const TIKWM_HOSTS = ['https://tikwm.com/api/', 'https://www.tikwm.com/api/'];

async function fetchAudioFromTikwm(videoUrl: string): Promise<TikTokMusicInfo | null> {
  for (const host of TIKWM_HOSTS) {
    try {
      const headers = thirdPartyApiHeaders('https://tikwm.com/');
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const body = `url=${encodeURIComponent(videoUrl)}&hd=1`;
      const resp = await fetch(host, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(4_000),
      });
      if (!resp.ok) continue;
      const data: any = await resp.json();
      if (data.code !== 0 || !data.data) continue;
      const musicSource = data.data.music_info ?? data.data.music;
      const playUrl = musicSource?.play ?? musicSource?.play_url ?? null;
      if (playUrl) {
        console.log(`[TikTok AudioFallback] Got audio from TikWM: ${host}`);
        return {
          play: playUrl,
          title: musicSource?.title ?? data.data.title ?? undefined,
          author: musicSource?.author ?? undefined,
          album: musicSource?.album ?? null,
        };
      }
    } catch {}
  }
  return null;
}

/**
 * Core resolution pipeline — uses the generic fallback runner via
 * src/lib/platforms/tiktok.ts source definitions.
 *  1. Resolve short links → canonical URL
 *  2. Run sources: TikWM → Cobalt → TikTok item-detail
 *  3. Enrich with oEmbed metadata (title, cover, author)
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

  // Fetch oEmbed metadata in parallel with the fallback chain
  const oembedP = fetchOembedMeta(canonicalUrl);

  // ─── Phase 1: Race fast sources in PARALLEL (first success wins) ───
  // TikCDN Direct (multi-pattern, 8s), TikWM (4s), TikTok ItemDetail (5s), TikTok Direct (8s)
  // First one to return a valid result wins. On a fast IP this takes 1-3s.
  let mediaResult: { data: import('./platforms/types').MediaMeta; source: string; attemptMs: number };
  const phase1Start = Date.now();
  try {
    mediaResult = await runWithRace(candidate, [
      tiktokCdnDirectSource,       // Direct CDN probe with fallback patterns (~2-5s)
      tikwmSource,                 // 3rd-party CDN API (~2-4s)
      tiktokItemDetailSource,      // TikTok's own web API (~3-5s)
      tiktokDirectSource,          // Direct page HTML parse (~5-8s)
    ]);
    console.log(`[TikTok] Phase 1 RACE WINNER: ${mediaResult.data.resolvedBy} in ${mediaResult.attemptMs}ms (total ${Date.now() - phase1Start}ms)`);
  } catch (raceErr) {
    // ─── Phase 2: Sequential fallback — slower but more thorough sources ───
    // Only reached when all 4 fast sources fail (rare on production IPs).
    console.log(`[TikTok] Phase 1 race failed (${Date.now() - phase1Start}ms), trying Phase 2 fallback sources...`);
    mediaResult = await runWithFallback(candidate, [
      cobaltSource(turnstileToken),  // cobalt.tools (~10-15s)
      tiktokDownbloderSource,       // Vercel wrapper (~8-10s)
    ]);
    console.log(`[TikTok] Phase 2 FALLBACK WINNER: ${mediaResult.data.resolvedBy} in ${mediaResult.attemptMs}ms`);
  }

  const meta: TikTokVideoMeta = {
    play: mediaResult.data.sdUrl,
    hdplay: mediaResult.data.hdUrl,
    wmplay: mediaResult.data.wmUrl,
    cover: mediaResult.data.cover,
    origin_cover: mediaResult.data.cover,
    title: mediaResult.data.title,
    duration: mediaResult.data.duration,
    author: {
      unique_id: mediaResult.data.authorUsername || '',
      nickname: mediaResult.data.authorName,
      avatar: mediaResult.data.authorAvatar,
    },
    digg_count: mediaResult.data.stats.likes ?? 0,
    comment_count: mediaResult.data.stats.comments ?? 0,
    share_count: mediaResult.data.stats.shares ?? 0,
    play_count: mediaResult.data.stats.views ?? 0,
    music: mediaResult.data.audioUrl
      ? { play: mediaResult.data.audioUrl, title: mediaResult.data.title, author: mediaResult.data.authorName }
      : undefined,
  };
  console.log(`[TikTok] Resolved via ${mediaResult.data.resolvedBy} in ${mediaResult.attemptMs}ms`);

  // Enrich with oEmbed metadata if fields are sparse
  const oembed = await oembedP;
  if (oembed) {
    if (!meta.title && oembed.title) meta.title = oembed.title;
    if (!meta.author?.nickname && oembed.author) {
      meta.author.nickname = oembed.author;
      meta.author.unique_id = meta.author.unique_id || oembed.author;
    }
    if (!meta.cover && oembed.cover) meta.cover = oembed.cover;
  }

  // Audio fallback: if the winning source didn't provide audio, try TikWM directly
  if (!meta.music) {
    console.log(`[TikTok] No audio from ${mediaResult.data.resolvedBy} — trying TikWM audio fallback`);
    const audioFallback = await fetchAudioFromTikwm(canonicalUrl);
    if (audioFallback) {
      meta.music = audioFallback;
    }
  }

  return meta;
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
