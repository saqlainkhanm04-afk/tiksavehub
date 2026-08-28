/**
 * Per-request environment initialization.
 * Call `initRequestEnv(getEnv(ctx))` at the top of every API route handler.
 */
/**
 * Per-request environment initialization.
 * Call `initRequestEnv(getEnv(ctx))` at the top of every API route handler.
 */
import { initMediaCache, configureMediaCache } from './media-cache';
import { configureRateLimit } from './rate-limit';
import type { CfEnv } from './env';

export { getEnv, type CfEnv } from './env';

export function initRequestEnv(env: CfEnv): void {
  initMediaCache(env);
  configureMediaCache(env);
  configureRateLimit(env);
}
