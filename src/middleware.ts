import { defineMiddleware } from 'astro:middleware';
import { startCookieHealthChecker } from './lib/ig-cookie-health';

let started = false;

export const onRequest = defineMiddleware((_ctx, next) => {
  if (!started) {
    started = true;
    startCookieHealthChecker();
  }
  return next();
});
