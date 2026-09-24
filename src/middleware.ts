import { defineMiddleware } from 'astro:middleware';
import { resolvePathRedirect } from './lib/path-redirects';

/* ─── HTTPS redirect + Security headers middleware ──────────────────────────
 *
 * 1. HTTP → HTTPS 301 redirect (checks X-Forwarded-Proto for Cloudflare proxy)
 * 2. www → non-www 301 redirect
 * 3. Security headers on EVERY response:
 *    - X-Frame-Options: DENY
 *    - X-Content-Type-Options: nosniff
 *    - Referrer-Policy: strict-origin-when-cross-origin
 *    - Permissions-Policy: geolocation=(), microphone=(), camera=()
 *    - Content-Security-Policy (enforced)
 *    - Strict-Transport-Security (HSTS)
 *
 * CSP allowlist (browser-enforced, server-side fetches excluded):
 *   script-src: self, unsafe-inline, googletagmanager.com (GA), google-analytics.com, challenges.cloudflare.com (Turnstile)
 *   style-src:  self, unsafe-inline, fonts.googleapis.com (Tailwind + component <style>)
 *   img-src:    self, data:, blob:, *.fbcdn.net, scontent.*, pbs.twimg.com, video.twimg.com
 *   connect-src: self, google-analytics.com, challenges.cloudflare.com
 *   font-src:   self, fonts.gstatic.com
 *   frame-src:  self, challenges.cloudflare.com (Turnstile iframe)
 *   worker-src: self, blob: (Turnstile web worker)
 *   frame-ancestors: none (equivalent to X-Frame-Options: DENY)
 *   base-uri / form-action: self
 *   upgrade-insecure-requests (browser-level HTTPS upgrade as fallback)
 * ────────────────────────────────────────────────────────────────────────── */

const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',

  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.google-analytics.com https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https://*.fbcdn.net https://scontent.* https://*.cdninstagram.com https://*.tiktokcdn.com https://*.tiktokcdn-us.com https://pbs.twimg.com https://video.twimg.com https://*.twimg.com https://*.snapcdn.com",
    "connect-src 'self' https://www.google-analytics.com https://challenges.cloudflare.com",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-src 'self' https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; '),
};

export const onRequest = defineMiddleware(async (ctx, next) => {
  /* ── 1. Canonical URL redirects — single-hop, preserves path + query ──────
   *
   * Collapses every protocol/host variant into ONE 301 so no request ever
   * needs a second redirect hop (avoids chains Google can mislabel as 5xx):
   *
   *   http://tiksavehub.com/...        →  https://tiksavehub.com/...
   *   http://www.tiksavehub.com/...    →  https://tiksavehub.com/...
   *   https://www.tiksavehub.com/...   →  https://tiksavehub.com/...
   *
   * Cloudflare proxies set `x-forwarded-proto`; the ctx.url.protocol check is
   * the local-dev fallback (non-Cloudflare). */
  const isHttp =
    ctx.request.headers.get('x-forwarded-proto') === 'http' || ctx.url.protocol === 'http:';
  const hostname = ctx.url.hostname;
  const needsHttps = isHttp;
  const needsWwwStrip = hostname === 'www.tiksavehub.com';

  if (needsHttps || needsWwwStrip) {
    const canonical = new URL(ctx.url.toString());
    canonical.protocol = 'https:';
    canonical.host = 'tiksavehub.com';
    return Response.redirect(canonical.toString(), 301);
  }

  /* ── 2.5. Path redirects (legacy slugs, double-locale-prefix, localized
   * blog posts). Mirrors public/_redirects so the SSR Cloudflare Worker
   * honors them even though _redirects itself is a Pages-only feature. ──── */
  const pathRedirect = resolvePathRedirect(ctx.url.pathname);
  if (pathRedirect) {
    return Response.redirect(new URL(pathRedirect, ctx.url).toString(), 301);
  }

  /* ── 3. Run downstream handler (SSR page or static asset) ─────────────── */
  const response = await next();

  /* ── 4. Cache-Control for HTML pages (Cloudflare edge caching) ─────────── */
  const contentType = response.headers.get('content-type') || '';
  const newHeaders = new Headers(response.headers);
  if (contentType.includes('text/html')) {
    // Cache HTML on Cloudflare edge for 5 minutes (300s), browser for 60s.
    // Stale-while-revalidate serves cached page while fetching fresh copy.
    newHeaders.set('Cache-Control', 'public, s-maxage=300, max-age=60, stale-while-revalidate=86400');
  } else if (contentType.includes('image/') || contentType.includes('font/')) {
    // Immutable static assets (fingerprinted filenames) — cache forever on edge+browser.
    newHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
  }

  /* ── 5. Wrap with security headers ─────────────────────────────────────── */
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    newHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
});
