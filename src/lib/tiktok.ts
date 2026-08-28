import { memo, memoSWR } from './cache';
import { resolveTikTokShortLink } from './normalize';
import { cobaltExtractVideo } from './cobalt';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'com.zhiliaoapp.musically/2023205030 (Linux; U; Android 13; en_US; Pixel 7; Build/TQ3A.230901.001; Cronet/TTNetVersion)';
const TIKTOK_APP_UA =
  'TikTok 26.2.0 rv:262018 (iPhone; iOS 14.4.2; en_US) Cronet';

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

function pickUrl(...values: any[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
  }
  return null;
}

function preferPlayableUrl(candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes('/aweme/v1/play/')) return c;
  }
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

async function resolveShortLink(url: string): Promise<string> {
  return memo(`tt:resolve:${url}`, RESOLVE_TTL_MS, async () => {
    try {
      const resp = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': DESKTOP_UA, 'Accept': 'text/html,*/*' },
        signal: AbortSignal.timeout(15_000),
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
      signal: AbortSignal.timeout(8_000),
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

function parseEmbeddedJson(html: string): any | null {
  const universal = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i);
  if (universal) {
    try {
      const json = JSON.parse(universal[1]);
      const item = json?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
      if (item?.id) return item;
    } catch {}
  }
  const sigi = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i);
  if (sigi) {
    try {
      const json = JSON.parse(sigi[1]);
      const modules = json?.ItemModule;
      if (modules) {
        const keys = Object.keys(modules);
        if (keys.length && modules[keys[0]]?.id) return modules[keys[0]];
      }
    } catch {}
  }
  return null;
}

async function tryPageScrape(pageUrl: string): Promise<any | null> {
  const attempts = [
    { url: pageUrl, ua: DESKTOP_UA },
  ];
  for (const { url, ua } of attempts) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Referer': 'https://www.tiktok.com/',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(12_000),
      });
      if (!resp.ok) continue;
      const html = await resp.text();
      const item = parseEmbeddedJson(html);
      if (item) return item;
    } catch {}
  }
  return null;
}

async function tryWebApi(videoId: string): Promise<{ item: any; downloadUrl: string } | null> {
  const qs = new URLSearchParams({
    itemId: videoId,
    aid: '1988',
    app_language: 'en',
    app_name: 'tiktok_web',
    channel: 'tiktok_web',
    device_platform: 'web_pc',
    region: 'US',
  }).toString();
  try {
    const resp = await fetch(`https://www.tiktok.com/api/item/detail/?${qs}`, {
      headers: {
        'User-Agent': DESKTOP_UA,
        'Referer': 'https://www.tiktok.com/',
        'Accept': 'application/json, text/plain, */*',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const item = data?.itemInfo?.itemStruct;
    if (!item) return null;
    const downloadUrl = preferPlayableUrl([
      item.video?.playAddr?.urlList?.[0],
      item.video?.playAddr?.url_list?.[0],
      item.video?.downloadAddr?.urlList?.[0],
      item.video?.download_addr?.url_list?.[0],
    ]);
    if (!downloadUrl) return null;
    return { item, downloadUrl };
  } catch {
    return null;
  }
}

async function tryMobileApi(videoId: string): Promise<{ item: any; downloadUrl: string } | null> {
  const endpoints = [
    'https://api22-normal-c-useast2a.tiktokv.com',
    'https://api16-normal-c-useast1a.tiktokv.com',
    'https://api19-normal-c-useast1a.tiktokv.com',
  ];
  const qs = new URLSearchParams({
    aweme_id: videoId,
    iid: '7318518857994389254',
    device_id: '7318517557120613121',
    channel: 'App',
    app_name: 'musical_ly',
    version_code: '260202',
    device_platform: 'iphone',
    device_type: 'iPhone14,5',
    os_version: '15.6.1',
  }).toString();
  for (const base of endpoints) {
    try {
      const resp = await fetch(`${base}/aweme/v1/feed/?${qs}`, {
        headers: { 'User-Agent': TIKTOK_APP_UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const item = data?.aweme_list?.[0];
      const downloadUrl = preferPlayableUrl([
        item?.video?.play_addr?.url_list?.[0],
        item?.video?.download_addr?.url_list?.[0],
      ]);
      if (item && downloadUrl) return { item, downloadUrl };
    } catch {}
  }
  return null;
}

function buildMetaFromItem(item: any, downloadUrl: string, oembed: { title: string; author: string; cover: string } | null): TikTokVideoMeta {
  const video = item.video || {};
  const author = item.author || {};
  const music = item.music || {};
  const duration = video.duration || 0;
  const rawDur = duration > 1000 ? Math.round(duration / 1000) : duration;

  const playAddr = preferPlayableUrl([
    video.playAddr?.urlList?.[0],
    video.playAddr?.url_list?.[0],
    video.play_addr?.url_list?.[0],
    downloadUrl,
  ]);
  const downloadAddr = preferPlayableUrl([
    video.downloadAddr?.urlList?.[0],
    video.downloadAddr?.url_list?.[0],
    video.download_addr?.url_list?.[0],
  ]);
  const coverUrl = preferPlayableUrl([
    video.originCover?.urlList?.[0],
    video.origin_cover?.url_list?.[0],
    video.cover?.urlList?.[0],
    video.cover?.url_list?.[0],
  ]);

  return {
    play: playAddr || downloadUrl,
    hdplay: playAddr || downloadUrl,
    wmplay: downloadAddr || null,
    cover: coverUrl || oembed?.cover || null,
    origin_cover: coverUrl || null,
    title: item.desc || oembed?.title || 'TikTok video',
    duration: rawDur || 0,
    author: {
      unique_id: author.uniqueId || author.unique_id || oembed?.author || '',
      nickname: author.nickname || author.unique_id || oembed?.author || '',
      avatar: pickUrl(author.avatarLarger, author.avatarMedium, author.avatarThumb?.url_list?.[0]) || null,
    },
    digg_count: (item.stats || item.statistics)?.diggCount || (item.stats || item.statistics)?.digg_count || 0,
    comment_count: (item.stats || item.statistics)?.commentCount || (item.stats || item.statistics)?.comment_count || 0,
    share_count: (item.stats || item.statistics)?.shareCount || (item.stats || item.statistics)?.share_count || 0,
    play_count: (item.stats || item.statistics)?.playCount || (item.stats || item.statistics)?.play_count || 0,
    music: music.playUrl || music.play_url ? {
      play: preferPlayableUrl([music.playUrl, music.play_url?.url_list?.[0]]) || null,
      title: music.title || undefined,
      author: music.authorName || music.author || undefined,
      album: music.album || null,
    } : undefined,
  };
}

async function tryTikWM(resolvedUrl: string): Promise<TikTokVideoMeta | null> {
  const run = async (host: string): Promise<TikTokVideoMeta> => {
    const apiUrl = `${host}?url=${encodeURIComponent(resolvedUrl)}&hd=1`;
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': TIKWM_UA, 'Accept': 'application/json', 'Referer': 'https://tikwm.com/' },
      signal: AbortSignal.timeout(15_000),
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

  if (!videoId && isShortLink(candidate)) {
    const resolved = await resolveShortLink(candidate);
    try {
      const rp = new URL(resolved);
      videoId = extractVideoId(rp.pathname);
      username = username || (rp.pathname.match(/^\/@([^/]+)/) || [])[1] || null;
    } catch {}
  }

  if (!videoId) {
    const oembed = await fetchOembedMeta(candidate);
    if (oembed?.videoId) {
      videoId = oembed.videoId;
      username = null;
    }
  }

  if (!videoId) throw new Error('Could not find a video ID in that link.');

  const oembed = await fetchOembedMeta(
    username ? `https://www.tiktok.com/@${username}/video/${videoId}` : `https://www.tiktok.com/embed/v2/${videoId}`
  );
  const finalUsername = username || oembed?.author || null;
  const pageUrl = finalUsername
    ? `https://www.tiktok.com/@${finalUsername}/video/${videoId}`
    : `https://www.tiktok.com/embed/v2/${videoId}`;

  console.log(`[TikTok] Resolving videoId=${videoId} page=${pageUrl}`);

  const pageItem = await tryPageScrape(pageUrl);
  if (pageItem) {
    const meta = buildMetaFromItem(pageItem, '', oembed);
    if (meta.play) {
      console.log(`[TikTok] Page scrape SUCCESS: ${meta.title.slice(0, 50)}`);
      return meta;
    }
  }

  const webResult = await tryWebApi(videoId);
  if (webResult) {
    const meta = buildMetaFromItem(webResult.item, webResult.downloadUrl, oembed);
    console.log(`[TikTok] Web API SUCCESS: ${meta.title.slice(0, 50)}`);
    return meta;
  }

  const mobileResult = await tryMobileApi(videoId);
  if (mobileResult) {
    const meta = buildMetaFromItem(mobileResult.item, mobileResult.downloadUrl, oembed);
    console.log(`[TikTok] Mobile API SUCCESS: ${meta.title.slice(0, 50)}`);
    return meta;
  }

  console.log('[TikTok] Native methods failed, trying TikWM...');
  const tikwm = await tryTikWM(candidate);
  if (tikwm) {
    console.log(`[TikTok] TikWM SUCCESS: ${tikwm.title.slice(0, 50)}`);
    return tikwm;
  }

  console.log('[TikTok] TikWM failed, trying Cobalt...');
  const cobalt = await tryCobalt(candidate, turnstileToken);
  if (cobalt) {
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
