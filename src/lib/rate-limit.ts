/**
 * Rate limiter — in-memory sliding window per IP.
 * In CF Workers, state is per-isolate (not distributed).
 * Acceptable for basic abuse prevention; use CF WAF Rules for production.
 */

import type { CfEnv } from './env';
import { envNum } from './env';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const minuteMap = new Map<string, number[]>();
const hourMap = new Map<string, number[]>();
let lastMinuteCleanup = Date.now();
let lastHourCleanup = Date.now();
let limitPerMin = 30;
let limitPerHour = 300;

export function configureRateLimit(env: CfEnv): void {
  limitPerMin = envNum(env, 'RATE_LIMIT_PER_MIN', 30);
  limitPerHour = envNum(env, 'RATE_LIMIT_PER_HOUR', 300);
}

export function clientIpFrom(request: Request): string {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (ip) return ip;
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

/**
 * Check if IP has exceeded the per-minute limit WITHOUT incrementing the counter.
 * Use this for cache-hit paths where you want to skip rate limiting entirely.
 */
export function isRateLimitedCheck(ip: string, overrideLimit?: number): boolean {
  const limit = overrideLimit ?? limitPerMin;
  if (limit <= 0) return false;
  const now = Date.now();
  const hits = (minuteMap.get(ip) || []).filter((t) => now - t < MINUTE_MS);
  return hits.length >= limit;
}

/**
 * Check if IP has exceeded the hourly limit WITHOUT incrementing the counter.
 */
export function isHourlyRateLimitedCheck(ip: string): boolean {
  if (limitPerHour <= 0) return false;
  const now = Date.now();
  const hits = (hourMap.get(ip) || []).filter((t) => now - t < HOUR_MS);
  return hits.length >= limitPerHour;
}

/**
 * Check and increment both per-minute and per-hour counters.
 * Returns detailed info including retryAfter seconds.
 * Call this only on cache MISS (when the request actually hits upstream APIs).
 */
export function isRateLimitedDetailed(
  ip: string,
  overrideLimit?: number
): { limited: boolean; retryAfter?: number } {
  const now = Date.now();

  // Cleanup minute map
  if (now - lastMinuteCleanup > MINUTE_MS) {
    cleanupMap(minuteMap, MINUTE_MS);
    lastMinuteCleanup = now;
  }

  // Cleanup hour map
  if (now - lastHourCleanup > HOUR_MS) {
    cleanupMap(hourMap, HOUR_MS);
    lastHourCleanup = now;
  }

  // Check per-minute
  const minLimit = overrideLimit ?? limitPerMin;
  const minHits = (minuteMap.get(ip) || []).filter((t) => now - t < MINUTE_MS);
  if (minLimit > 0 && minHits.length >= minLimit) {
    const oldest = minHits[0];
    const retryAfter = Math.ceil((oldest + MINUTE_MS - now) / 1000);
    minuteMap.set(ip, minHits);
    return { limited: true, retryAfter };
  }

  // Check per-hour
  const hourHits = (hourMap.get(ip) || []).filter((t) => now - t < HOUR_MS);
  if (limitPerHour > 0 && hourHits.length >= limitPerHour) {
    const oldest = hourHits[0];
    const retryAfter = Math.ceil((oldest + HOUR_MS - now) / 1000);
    hourMap.set(ip, hourHits);
    return { limited: true, retryAfter };
  }

  // Increment both counters
  minHits.push(now);
  minuteMap.set(ip, minHits);
  hourHits.push(now);
  hourMap.set(ip, hourHits);

  return { limited: false };
}

/**
 * Check and INCREMENT per-minute counter (backward-compatible boolean).
 * Used by all other API routes.
 */
export function isRateLimited(
  ip: string,
  overrideLimit?: number
): boolean {
  const limit = overrideLimit ?? limitPerMin;
  if (limit <= 0) return false;

  const now = Date.now();
  if (now - lastMinuteCleanup > MINUTE_MS) {
    cleanupMap(minuteMap, MINUTE_MS);
    lastMinuteCleanup = now;
  }

  const hits = (minuteMap.get(ip) || []).filter((t) => now - t < MINUTE_MS);
  if (hits.length >= limit) {
    minuteMap.set(ip, hits);
    return true;
  }

  hits.push(now);
  minuteMap.set(ip, hits);
  return false;
}

function cleanupMap(map: Map<string, number[]>, windowMs: number): void {
  const now = Date.now();
  for (const [key, times] of map) {
    const kept = times.filter((t) => now - t < windowMs);
    if (kept.length === 0) map.delete(key);
    else map.set(key, kept);
  }
}
