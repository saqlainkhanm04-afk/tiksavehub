/**
 * Instagram Cookie Pool — Round-Robin rotation with auto-fallback.
 *
 * Reads cookies from IG_COOKIE_1, IG_COOKIE_2 (and legacy IG_COOKIES /
 * IG_SESSIONID) and distributes requests evenly. If a cookie gets 401/429 or
 * a checkpoint error, the caller can retry with the next cookie in the pool.
 */

import { ensureInstagramEnv } from './ig-env';

ensureInstagramEnv();

export interface CookieEntry {
  /** Human-readable label (e.g. "cookie-1", "legacy"). */
  label: string;
  /** Full cookie header string (e.g. "sessionid=...; mid=...; ..."). */
  cookie: string;
  /** Whether this cookie is currently considered healthy. */
  healthy: boolean;
}

let pool: CookieEntry[] = [];
let roundRobinIndex = 0;
let initialised = false;

/**
 * One-time init: builds the pool from env vars.  Called lazily on first
 * `getNextCookie()` / `withCookiePool()` so that ig-env has had time to
 * load the .env file.
 */
function initPool(): void {
  if (initialised) return;
  initialised = true;

  const entries: CookieEntry[] = [];

  // --- Explicit numbered cookies (new system) ---
  for (const [idx, envKey] of ['IG_COOKIE_1', 'IG_COOKIE_2', 'IG_COOKIE_3', 'IG_COOKIE_4'] as const) {
    const val = process.env[envKey]?.trim();
    if (val) {
      entries.push({ label: `cookie-${idx}`, cookie: val, healthy: true });
    }
  }

  // --- Legacy single-cookie env vars (backward compatible) ---
  // Only added when no IG_COOKIE_* were found, so they don't compete in
  // the pool with the new numbered cookies.
  if (entries.length === 0) {
    const full = process.env.IG_COOKIES?.trim();
    if (full) {
      entries.push({ label: 'legacy-cookies', cookie: full, healthy: true });
      // Fall through: legacy partial cookies only used as absolute fallback.
    } else {
      const parts: string[] = [];
      const sid = process.env.IG_SESSIONID?.trim();
      if (sid) parts.push(`sessionid=${sid}`);
      if (process.env.IG_DS_USER_ID?.trim()) parts.push(`ds_user_id=${process.env.IG_DS_USER_ID}`);
      if (process.env.IG_CSRF_TOKEN?.trim()) parts.push(`csrftoken=${process.env.IG_CSRF_TOKEN}`);
      if (parts.length > 0) {
        entries.push({ label: 'legacy-partial', cookie: parts.join('; '), healthy: true });
      }
    }
  }

  pool = entries;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Number of healthy cookies currently in the pool. */
export function poolSize(): number {
  initPool();
  return pool.filter((c) => c.healthy).length;
}

/** Total number of cookies ever registered (healthy + marked-bad). */
export function poolTotalSize(): number {
  initPool();
  return pool.length;
}

/**
 * Round-robin: return the next cookie and rotate the pointer.
 * If all cookies are unhealthy, reset them all (transient outage) and retry.
 */
export function getNextCookie(): CookieEntry {
  initPool();

  if (pool.length === 0) {
    return { label: 'empty', cookie: '', healthy: true };
  }

  // Try to find the next healthy cookie.
  for (let i = 0; i < pool.length; i++) {
    const idx = (roundRobinIndex + i) % pool.length;
    if (pool[idx].healthy) {
      roundRobinIndex = (idx + 1) % pool.length;
      return pool[idx];
    }
  }

  // All marked unhealthy — assume transient issue, reset all and take the
  // first one.
  console.warn('[ig-cookie-pool] All cookies marked unhealthy — resetting pool');
  for (const c of pool) c.healthy = true;
  roundRobinIndex = 1 % pool.length;
  return pool[0];
}

/**
 * Mark the given cookie as unhealthy so the next `getNextCookie()` skips it.
 * Label is matched; if no match the call is a no-op.
 */
export function markUnhealthy(label: string): void {
  initPool();
  const entry = pool.find((c) => c.label === label);
  if (entry) entry.healthy = false;
}

/** Reset all cookies back to healthy (e.g. after cooldown period). */
export function resetPool(): void {
  initPool();
  for (const c of pool) c.healthy = true;
  roundRobinIndex = 0;
}

// ─── High-level helper ───────────────────────────────────────────────────────

/**
 * Execute `fn(cookie)` with automatic round-robin rotation and retry.
 *
 * If `fn` throws and the error looks like a session/cookie failure
 * (401, 429, checkpoint, login_required, useragent mismatch), the failed
 * cookie is marked unhealthy and `fn` is retried with the next cookie.
 *
 * If ALL cookies are exhausted, the last error is thrown.
 *
 * `maxAttempts` caps total tries to prevent infinite loops — defaults to
 * pool size + 1 (one try per cookie plus one extra with the reset pool).
 */
export async function withCookiePool<T>(
  fn: (cookie: string, label: string) => Promise<T>,
  maxAttempts?: number,
): Promise<T> {
  initPool();
  const total = pool.length || 1;
  const limit = maxAttempts ?? total + 1;

  let lastError: any = null;

  for (let attempt = 0; attempt < limit; attempt++) {
    const entry = getNextCookie();

    try {
      return await fn(entry.cookie, entry.label);
    } catch (err: any) {
      lastError = err;
      const msg = String(err?.message || err || '').toLowerCase();
      const code = String(err?.code || '').toLowerCase();

      const isCookieFailure =
        msg.includes('login_required') ||
        msg.includes('challenge_required') ||
        msg.includes('checkpoint_required') ||
        msg.includes('session_expired') ||
        msg.includes('useragent mismatch') ||
        msg.includes('401') ||
        msg.includes('429') ||
        code.includes('401') ||
        code.includes('429');

      if (isCookieFailure) {
        console.warn(
          `[ig-cookie-pool] Cookie "${entry.label}" failed (${msg.slice(0, 80)}), trying next…`
        );
        markUnhealthy(entry.label);
        continue;
      }

      // Non-cookie error (private content, invalid URL, etc.) — don't
      // waste other cookies on it, throw immediately.
      throw err;
    }
  }

  // All attempts exhausted — reset pool for future requests and throw.
  resetPool();
  throw lastError || new Error('All Instagram cookies in the pool failed.');
}
