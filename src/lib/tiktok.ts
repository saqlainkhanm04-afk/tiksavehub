import { memo, memoSWR } from './cache';
import { resolveTikTokShortLink } from './normalize';

const TIKWM_HOSTS = ['https://tikwm.com/api/', 'https://www.tikwm.com/api/'];

const TIKWM_UA =
  'Mozilla/5.0 (iPad; U; CPU OS 3_2 like Mac OS X; en-us) AppleWebKit/531.21.10 (KHTML, like Gecko) Version/4.0.4 Mobile/7B334b Safari/531.21.10';

const FETCH_TIMEOUT_MS = 20_000;
const FALLBACK_THRESHOLD_MS = 600;
const ITEM_DETAIL_TIMEOUT_MS = 8_000;
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

export async function fetchTikTokItemDetail(itemId: string): Promise<{ url: string; width: number; height: number; bitrate?: number } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ITEM_DETAIL_TIMEOUT_MS);
    try {
      const resp = await fetch(
        `https://www.tiktok.com/api/item/detail/?itemId=${encodeURIComponent(itemId)}&aid=1988`,
        {
          headers: {
            'User-Agent': TIKWM_UA,
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://www.tiktok.com/',
          },
          signal: controller.signal,
        }
      );
      if (!resp.ok) return null;
      const text = await resp.text();
      if (!text || !text.trim().startsWith('{')) return null;
      const data = JSON.parse(text);
      const video = data?.itemInfo?.itemStruct?.video;
      const url = video?.downloadAddr || video?.playAddr || null;
      if (typeof url !== 'string' || !url) return null;
      return {
        url,
        width: video.width || 0,
        height: video.height || 0,
        bitrate: video.bitrate || undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function itemIdFromUrl(url: string): string | null {
  const m = url.match(/\/video\/(\d{15,20})/);
  return m ? m[1] : null;
}

export function isValidTikTokUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const validHosts = [
      'tiktok.com',
      'www.tiktok.com',
      'm.tiktok.com',
      'vm.tiktok.com',
      'vt.tiktok.com',
    ];
    return validHosts.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith('.' + host)
    );
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

async function resolveShortLink(url: string): Promise<string> {
  return memo(`tt:resolve:${url}`, RESOLVE_TTL_MS, async () => {
    try {
      const resp = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': TIKWM_UA,
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
        signal: AbortSignal.timeout(20_000),
      });
      const finalUrl = cleanUrl(resp.url);
      if (/\/video\/\d+/.test(finalUrl)) return finalUrl;
    } catch {
      // fall through
    }
    return cleanUrl(url);
  });
}

function raceFirstSuccess<T>(
  primary: (signal?: AbortSignal) => Promise<T>,
  fallbacks: Array<(signal?: AbortSignal) => Promise<T>>,
  thresholdMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveFirst: ((value: T) => void) | null = null;
  let rejectLast: ((error: unknown) => void) | null = null;
  let done = false;

  const promise = new Promise<T>((resolve, reject) => {
    resolveFirst = resolve;
    rejectLast = reject;
  });

  const started = new Array(fallbacks.length).fill(false);
  let pending = 0;
  const controllers: AbortController[] = [];

  const abortAll = () => {
    for (const c of controllers) c.abort();
    controllers.length = 0;
  };

  const startFallbacks = () => {
    for (let i = 0; i < fallbacks.length; i++) {
      if (started[i]) continue;
      started[i] = true;
      pending++;
      const controller = new AbortController();
      controllers.push(controller);
      fallbacks[i](controller.signal).then(
        (value) => {
          if (done) return;
          done = true;
          if (timer) { clearTimeout(timer); timer = null; }
          abortAll();
          resolveFirst!(value);
        },
        () => {
          pending--;
          if (done) return;
          if (pending === 0) {
            done = true;
            abortAll();
            rejectLast!(new Error('All TikTok servers are busy. Please try again.'));
          }
        }
      );
    }
  };

  pending = 1;
  const primaryController = new AbortController();
  controllers.push(primaryController);
  primary(primaryController.signal).then(
    (value) => {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      abortAll();
      resolveFirst!(value);
    },
    () => {
      pending--;
      if (done) return;
      if (timer) { clearTimeout(timer); timer = null; }
      if (pending === 0) {
        done = true;
        abortAll();
        rejectLast!(new Error('All TikTok servers are busy. Please try again.'));
        return;
      }
      startFallbacks();
    }
  );

  timer = setTimeout(startFallbacks, thresholdMs);
  return promise;
}

async function fetchFromHost(host: string, videoUrl: string, signal?: AbortSignal): Promise<any> {
  const apiUrl = `${host}?url=${encodeURIComponent(videoUrl)}&hd=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      headers: {
        'User-Agent': TIKWM_UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://tikwm.com/',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (!response.ok) throw new Error(`Upstream API returned ${response.status}`);

  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error('Upstream returned invalid response.'); }

  if (data.code !== 0 || !data.data) {
    throw new Error(data.msg || 'Could not retrieve video. The link may be private or expired.');
  }
  return data.data;
}

function normalize(data: any): TikTokVideoMeta {
  const musicSource = data.music_info ?? data.music;
  const author = data.author ?? {};
  return {
    play: data.play ?? data.hdplay ?? null,
    hdplay: data.hdplay ?? data.play ?? null,
    wmplay: data.wmplay ?? null,
    cover: data.cover ?? null,
    origin_cover: data.origin_cover ?? data.cover ?? null,
    title: data.title ?? '',
    duration: data.duration ?? 0,
    author: {
      unique_id: author.unique_id ?? '',
      nickname: author.nickname ?? '',
      avatar: author.avatar ?? null,
    },
    digg_count: data.digg_count ?? 0,
    comment_count: data.comment_count ?? 0,
    share_count: data.share_count ?? 0,
    play_count: data.play_count ?? 0,
    music: musicSource
      ? {
          play: musicSource.play ?? musicSource.play_url ?? null,
          title: musicSource.title ?? undefined,
          author: musicSource.author ?? undefined,
          album: musicSource.album ?? null,
        }
      : undefined,
  };
}

export async function fetchTikTokMeta(
  videoUrl: string,
  opts: { ttlMs?: number; hd?: boolean } = {}
): Promise<TikTokVideoMeta> {
  const { ttlMs = META_TTL_MS } = opts;
  const resolved = isShortLink(videoUrl) ? await resolveShortLink(videoUrl) : cleanUrl(videoUrl);
  return memoSWR(`tt:${resolved}`, ttlMs, META_STALE_MS, async () => {
    const data = await loadTikTokData(resolved);
    return normalize(data);
  });
}

export async function fetchTikTokMetaWithFallback(
  videoUrl: string,
  opts: { ttlMs?: number; hd?: boolean } = {}
): Promise<TikTokVideoMeta> {
  const { ttlMs = META_TTL_MS } = opts;
  const resolved = await resolveTikTokShortLink(videoUrl);
  return memoSWR(`tt:fb:${resolved}`, ttlMs, META_STALE_MS, async () => {
    const data = await loadTikTokData(resolved);
    const meta = normalize(data);
    // Try item-detail API for 1080p upgrade
    const itemId = itemIdFromUrl(resolved);
    if (itemId) {
      const direct = await fetchTikTokItemDetail(itemId);
      if (direct?.url) {
        meta.hdplay = direct.url;
        if (direct.width && direct.height) {
          meta.quality = { width: direct.width, height: direct.height };
        }
      }
    }
    return meta;
  });
}

async function loadTikTokData(resolvedUrl: string): Promise<any> {
  const run = () =>
    raceFirstSuccess(
      (signal) => fetchFromHost(TIKWM_HOSTS[0], resolvedUrl, signal),
      TIKWM_HOSTS.slice(1).map((host) => (signal) => fetchFromHost(host, resolvedUrl, signal)),
      FALLBACK_THRESHOLD_MS
    );

  try {
    return await run();
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    if (isTimeout) throw err;
    return run();
  }
}

export { AUDIO_TTL_MS, META_TTL_MS };
