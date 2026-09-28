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

/* ── Cloudflare env resolution ────────────────────────────────────────────
 *
 * Astro v6 REMOVED `Astro.locals.runtime.env` (accessing it now throws), and
 * @astrojs/cloudflare v14 no longer injects it. The only supported source on
 * Workers is the native `cloudflare:workers` module, which hands out the full
 * binding bag (secrets, vars, KV, and the Browser Rendering binding).
 *
 * Two hard rules learned the expensive way:
 *
 * 1. NEVER import it while Astro is prerendering. The Cloudflare adapter runs
 *    the BUILD inside workerd, so `cloudflare:workers` RESOLVES there and every
 *    prerendered page (there are ~300 of them) used to re-import it and re-log,
 *    which stalled the build at /404.html. Prerendered pages never need
 *    bindings and API routes are never prerendered, so middleware skips it via
 *    `ctx.isPrerendered`.
 * 2. Import exactly ONCE per isolate. The promise is cached, so the resolution
 *    log can only ever appear a single time and no amount of traffic can turn
 *    it into a loop. A timeout caps the damage if the import ever stalls.
 *
 * The module does not exist on the Node dev server, so the import uses a
 * non-literal specifier (the bundler leaves it alone) and any failure falls
 * back to process.env. `primeCfEnv()` is awaited in middleware before the first
 * route handler runs, which keeps getEnv() synchronous.
 */
let cfEnv: CfEnv | null = null;
let cfEnvPromise: Promise<CfEnv | null> | null = null;

const CLOUDFLARE_WORKERS_MODULE = 'cloudflare:workers';
const CF_ENV_IMPORT_TIMEOUT_MS = 3_000;

function loadCfEnv(): Promise<CfEnv | null> {
  const spec = CLOUDFLARE_WORKERS_MODULE;
  const importPromise = import(/* @vite-ignore */ spec)
    .then((mod: any) => {
      const bag = mod?.env;
      if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
        cfEnv = bag as CfEnv;
        console.log(`[env] Cloudflare bindings resolved (browser=${!!bag.MYBROWSER})`);
      }
      return cfEnv;
    })
    .catch(() => cfEnv);

  return Promise.race([
    importPromise,
    new Promise<CfEnv | null>((resolve) =>
      setTimeout(() => {
        if (!cfEnv) console.warn('[env] cloudflare:workers import timed out; using process.env fallback');
        resolve(cfEnv);
      }, CF_ENV_IMPORT_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Resolve the Cloudflare binding bag once per isolate.
 *
 * Pass `prerendered: true` to skip the import entirely (build-time page
 * rendering). Safe to call on every request.
 */
export function primeCfEnv(opts?: { prerendered?: boolean }): Promise<CfEnv | null> {
  if (opts?.prerendered === true) return Promise.resolve(cfEnv);
  if (!cfEnvPromise) cfEnvPromise = loadCfEnv();
  return cfEnvPromise;
}

/** Read a property without letting a throwing getter kill the request. */
function safe(obj: any, key: string): any {
  try {
    return obj?.[key];
  } catch {
    return undefined;
  }
}

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
  /** Auth key for the SaveFromIns fallback used by Instagram reels. */
  IG_SAVEFROMINS_AUTH?: string;
  /** Optional HikerAPI access key (https://hikerapi.com/tokens). Empty = source skipped. */
  IG_HIKERAPI_KEY?: string;
  /** Kill switch for the Cloudflare Browser Rendering Instagram source. */
  IG_BROWSER_DISABLED?: string;
  RATE_LIMIT_PER_MIN?: string;
  RATE_LIMIT_PER_HOUR?: string;
  MEDIA_TTL_MS?: string;
  INSTAGRAM_MEDIA_TTL_MS?: string;
  MAX_CACHE_AGE_MS?: string;
  FB_RSA_PUBLIC_KEY?: string;
}

/**
 * Extract env from the Cloudflare bindings bag, falling back to process.env
 * for the local Node dev server.
 *
 * Callers pass the whole `APIContext` (getEnv(ctx)), and the shape differs per
 * adapter version, so probe every place the bindings can live. Probing the wrong
 * one silently strips ALL secrets and bindings (MYBROWSER, KV) from a request
 * that still looks perfectly healthy — which is exactly what a missing
 * `Astro.locals.runtime` did.
 */
export function getEnv(ctx?: Record<string, any>): CfEnv {
  // 0. Already-resolved Cloudflare bindings (production, primed by middleware).
  if (cfEnv) return cfEnv;

  // 1. The value itself may already be an env bag.
  if (ctx && typeof ctx === 'object' && !safe(ctx, 'request') && !safe(ctx, 'locals')) return ctx as CfEnv;

  // 2. Adapter shapes that still expose env on the context/locals.
  const locals = safe(ctx, 'locals');
  const candidates = [safe(safe(locals, 'runtime'), 'env'), safe(ctx, 'runtime')?.env, safe(ctx, 'cloudflare')?.env];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate as CfEnv;
  }

  // Local dev fallback — read from process.env
  return {
    CACHE: undefined, // KV not available in dev; use in-memory fallback
    IG_COOKIES: (globalThis as any).process?.env?.IG_COOKIES || '',
    IG_SESSIONID: (globalThis as any).process?.env?.IG_SESSIONID || '',
    IG_DS_USER_ID: (globalThis as any).process?.env?.IG_DS_USER_ID || '',
    IG_CSRF_TOKEN: (globalThis as any).process?.env?.IG_CSRF_TOKEN || '',
    FB_COOKIES: (globalThis as any).process?.env?.FB_COOKIES || '',
    FB_APP_TOKEN: (globalThis as any).process?.env?.FB_APP_TOKEN || '',
    IG_SAVEFROMINS_AUTH: (globalThis as any).process?.env?.IG_SAVEFROMINS_AUTH || '',
    IG_HIKERAPI_KEY: (globalThis as any).process?.env?.IG_HIKERAPI_KEY || '',
    IG_BROWSER_DISABLED: (globalThis as any).process?.env?.IG_BROWSER_DISABLED || '',
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
