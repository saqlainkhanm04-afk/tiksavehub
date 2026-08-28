/**
 * Media cache — backed by KV (Cloudflare) or in-memory Map (dev).
 * No disk I/O, no Node.js APIs.
 */

import { kvSet, kvDel, kvGetRaw, kvInit } from './kv';
import type { CfEnv } from './env';
import { envNum } from './env';

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

export function initMediaCache(env: CfEnv): void {
  kvInit(env.CACHE ?? null);
}

const DEFAULT_MEDIA_TTL = 24 * 60 * 60 * 1000;
const DEFAULT_IG_TTL = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE = 48 * 60 * 60 * 1000;
const VALIDATE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8_000;

let mediaTtl = DEFAULT_MEDIA_TTL;
let igTtl = DEFAULT_IG_TTL;
let maxCacheAge = DEFAULT_MAX_AGE;

export function configureMediaCache(env: CfEnv): void {
  mediaTtl = envNum(env, 'MEDIA_TTL_MS', DEFAULT_MEDIA_TTL);
  igTtl = envNum(env, 'INSTAGRAM_MEDIA_TTL_MS', DEFAULT_IG_TTL);
  maxCacheAge = envNum(env, 'MAX_CACHE_AGE_MS', DEFAULT_MAX_AGE);
}

export function mediaKey(prefix: string, canonical: string, mode: string): string {
  return `media:${prefix}:${mode}:${canonical}`;
}

export function ttlForPlatform(platform: string): number {
  if (platform === 'instagram') return igTtl;
  return mediaTtl;
}

export async function cacheRead(
  prefix: string,
  canonical: string,
  mode: string
): Promise<MediaCacheValue | null> {
  const key = mediaKey(prefix, canonical, mode);
  const entry = await kvGetRaw<MediaCacheValue>(key);
  if (!entry) return null;
  if (entry.exp <= Date.now()) return null;
  return entry.value;
}

export async function cacheWrite(
  platform: string,
  prefix: string,
  canonical: string,
  mode: string,
  value: Omit<MediaCacheValue, 'extractedAt' | 'expiresAt'>
): Promise<MediaCacheValue> {
  const now = Date.now();
  const ttl = ttlForPlatform(platform);
  const expiresAt = Math.min(now + ttl, now + maxCacheAge);
  const stored: MediaCacheValue = {
    ...value,
    provider: 'from_cache',
    extractedAt: now,
    expiresAt,
  };
  await kvSet(mediaKey(prefix, canonical, mode), stored, ttl);
  return stored;
}

export async function invalidateCache(
  prefix: string,
  canonical: string,
  mode: string
): Promise<void> {
  await kvDel(mediaKey(prefix, canonical, mode));
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
    if (!ok) await invalidateCache(prefix, canonical, mode);
  } catch {
    // best-effort
  }
}

export async function cacheHit(
  _platform: string,
  prefix: string,
  canonical: string,
  mode: string
): Promise<MediaCacheValue | null> {
  const value = await cacheRead(prefix, canonical, mode);
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

export { mediaTtl as MEDIA_TTL_MS, igTtl as INSTAGRAM_MEDIA_TTL_MS };
