/**
 * Cloudflare Workers env accessor.
 *
 * In the Cloudflare adapter, environment variables are passed via bindings
 * (KV, secrets, vars) — NOT process.env. This module provides a typed
 * accessor that works in both dev (process.env) and production (CF bindings).
 *
 * Usage in API routes:  const env = getEnv(Astro);
 * Usage in lib files:   import { getEnv } from './env';
 */

export interface CfEnv {
  // KV namespace
  CACHE?: KVNamespace;

  // Browser Run binding (Cloudflare Browser Rendering)
  MYBROWSER?: unknown;

  // Secrets / vars
  IG_COOKIES?: string;
  IG_SESSIONID?: string;
  IG_DS_USER_ID?: string;
  IG_CSRF_TOKEN?: string;
  FB_COOKIES?: string;
  FB_APP_TOKEN?: string;
  RATE_LIMIT_PER_MIN?: string;
  RATE_LIMIT_PER_HOUR?: string;
  MEDIA_TTL_MS?: string;
  INSTAGRAM_MEDIA_TTL_MS?: string;
  MAX_CACHE_AGE_MS?: string;
  FB_RSA_PUBLIC_KEY?: string;
}

/**
 * Extract env from Astro.locals.runtime.env (Cloudflare adapter)
 * or fall back to process.env for local dev.
 */
export function getEnv(locals?: Record<string, any>): CfEnv {
  // Cloudflare adapter stores env in locals.runtime.env
  const runtimeEnv = locals?.runtime?.env;
  if (runtimeEnv && typeof runtimeEnv === 'object') return runtimeEnv as CfEnv;

  // Local dev fallback — read from process.env
  return {
    CACHE: undefined, // KV not available in dev; use in-memory fallback
    IG_COOKIES: (globalThis as any).process?.env?.IG_COOKIES || '',
    IG_SESSIONID: (globalThis as any).process?.env?.IG_SESSIONID || '',
    IG_DS_USER_ID: (globalThis as any).process?.env?.IG_DS_USER_ID || '',
    IG_CSRF_TOKEN: (globalThis as any).process?.env?.IG_CSRF_TOKEN || '',
    FB_COOKIES: (globalThis as any).process?.env?.FB_COOKIES || '',
    FB_APP_TOKEN: (globalThis as any).process?.env?.FB_APP_TOKEN || '',
    RATE_LIMIT_PER_MIN: (globalThis as any).process?.env?.RATE_LIMIT_PER_MIN || '30',
    RATE_LIMIT_PER_HOUR: (globalThis as any).process?.env?.RATE_LIMIT_PER_HOUR || '300',
    MEDIA_TTL_MS: (globalThis as any).process?.env?.MEDIA_TTL_MS || '',
    INSTAGRAM_MEDIA_TTL_MS: (globalThis as any).process?.env?.INSTAGRAM_MEDIA_TTL_MS || '',
    MAX_CACHE_AGE_MS: (globalThis as any).process?.env?.MAX_CACHE_AGE_MS || '',
  } as CfEnv;
}

/** Helper: get a string env var with default */
export function envStr(env: CfEnv, key: keyof CfEnv, fallback: string = ''): string {
  return (env[key] as string) || fallback;
}

/** Helper: get a numeric env var with default */
export function envNum(env: CfEnv, key: keyof CfEnv, fallback: number): number {
  const v = env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
