/**
 * Rate limiter — in-memory sliding window per IP.
 * In CF Workers, state is per-isolate (not distributed).
 * Acceptable for basic abuse prevention; use CF WAF Rules for production.
 */

import type { CfEnv } from './env';
import { envNum } from './env';

const WINDOW_MS = 60_000;
const rateMap = new Map<string, number[]>();
let lastCleanup = Date.now();
let limitPerMin = 30;

export function configureRateLimit(env: CfEnv): void {
  limitPerMin = envNum(env, 'RATE_LIMIT_PER_MIN', 30);
}

export function clientIpFrom(request: Request): string {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (ip) return ip;
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

export function isRateLimited(
  ip: string,
  overrideLimit?: number
): boolean {
  const limit = overrideLimit ?? limitPerMin;
  if (limit <= 0) return false;

  const now = Date.now();
  if (now - lastCleanup > WINDOW_MS) {
    cleanup();
    lastCleanup = now;
  }

  const hits = (rateMap.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= limit) {
    rateMap.set(ip, hits);
    return true;
  }

  hits.push(now);
  rateMap.set(ip, hits);
  return false;
}

function cleanup(): void {
  const now = Date.now();
  for (const [key, times] of rateMap) {
    const kept = times.filter((t) => now - t < WINDOW_MS);
    if (kept.length === 0) rateMap.delete(key);
    else rateMap.set(key, kept);
  }
}
