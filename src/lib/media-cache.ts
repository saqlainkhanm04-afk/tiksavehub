import { kvStart, kvSet, kvDel, kvGetRaw } from './kv';

export interface MediaCacheValue {
  args: Record<string, string>;
  mediaUrl: string | null;
  thumb: string | null;
  title: string;
  data: unknown;
  extractedAt: number;
  expiresAt: number;
  provider?: 'primary' | 'fallback' | 'ytdlp' | 'from_cache';
}

const MEDIA_TTL_MS = Number(process.env.MEDIA_TTL_MS || 24 * 60 * 60 * 1000);
const INSTAGRAM_MEDIA_TTL_MS = Number(process.env.INSTAGRAM_MEDIA_TTL_MS || 12 * 60 * 60 * 1000);
const YTDLP_TTL_MS = Number(process.env.YTDLP_TTL_MS || 48 * 60 * 60 * 1000);
const MAX_CACHE_AGE_MS = Number(process.env.MAX_CACHE_AGE_MS || 48 * 60 * 60 * 1000);
const VALIDATE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8_000;

kvStart();

export function mediaKey(prefix: string, canonical: string, mode: string): string {
  return `media:${prefix}:${mode}:${canonical}`;
}

export function ttlForPlatform(platform: string): number {
  if (platform === 'instagram') return INSTAGRAM_MEDIA_TTL_MS;
  if (platform === 'tiktok') return MEDIA_TTL_MS;
  return MEDIA_TTL_MS;
}

export function cacheRead(prefix: string, canonical: string, mode: string): MediaCacheValue | null {
  const key = mediaKey(prefix, canonical, mode);
  const entry = kvGetRaw<MediaCacheValue>(key);
  if (!entry) return null;
  if (entry.exp <= Date.now()) return null;
  return entry.value;
}

export function cacheWrite(
  platform: string,
  prefix: string,
  canonical: string,
  mode: string,
  value: Omit<MediaCacheValue, 'extractedAt' | 'expiresAt'>
): MediaCacheValue {
  const now = Date.now();
  const ttl = ttlForPlatform(platform);
  const expiresAt = Math.min(now + ttl, now + MAX_CACHE_AGE_MS);
  const stored: MediaCacheValue = {
    ...value,
    provider: 'from_cache',
    extractedAt: now,
    expiresAt,
  };
  kvSet(mediaKey(prefix, canonical, mode), stored, ttl);
  return stored;
}

export function invalidateCache(prefix: string, canonical: string, mode: string): void {
  kvDel(mediaKey(prefix, canonical, mode));
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Range': 'bytes=0-0',
        'Accept': '*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return resp.ok || resp.status === 206;
  } catch {
    return false;
  }
}

export async function lazilyValidate(
  prefix: string,
  canonical: string,
  mode: string,
  value: MediaCacheValue
): Promise<void> {
  if (!value.mediaUrl) return;
  if (Date.now() - value.extractedAt < VALIDATE_THRESHOLD_MS) return;

  try {
    const ok = await probeUrl(value.mediaUrl);
    if (!ok) invalidateCache(prefix, canonical, mode);
  } catch {
    // Validation is best-effort; leave the entry as-is.
  }
}

export function cacheHit(
  _platform: string,
  prefix: string,
  canonical: string,
  mode: string
): MediaCacheValue | null {
  const value = cacheRead(prefix, canonical, mode);
  if (!value) return null;
  lazilyValidate(prefix, canonical, mode, value).catch(() => {});
  return value;
}

const inflight = new Map<string, Promise<unknown>>();

export function inFlightOn<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = task().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export { MEDIA_TTL_MS, INSTAGRAM_MEDIA_TTL_MS, YTDLP_TTL_MS };