import { defineMiddleware } from 'astro:middleware';

/* ─── HTTPS redirect + Security headers middleware ──────────────────────────
 *
 * 1. HTTP → HTTPS 301 redirect (checks X-Forwarded-Proto for Cloudflare proxy)
 * 2. Security headers on EVERY response:
 *    - X-Frame-Options: SAMEORIGIN
 *    - X-Content-Type-Options: nosniff
 *    - Referrer-Policy: strict-origin-when-cross-origin
 *    - Permissions-Policy: geolocation=(), microphone=(), camera=()
 *    - Content-Security-Policy-Report-Only (convert to CSP once verified)
 *
 * CSP allowlist (browser-enforced, server-side fetches excluded):
 *   script-src: self, googletagmanager.com (GA), challenges.cloudflare.com (Turnstile), unsafe-inline
 *   style-src:  self, unsafe-inline (Tailwind + component <style>)
 *   img-src:    self, data:, blob:, *.fbcdn.net, scontent.*, pbs.twimg.com, video.twimg.com,
 *               https://*.sentry.io (error tracking)
 *   connect-src: self (all external API calls are server-side only)
 *   font-src:   self (fonts are self-hosted /fonts/*.woff2)
 *   frame-src:  self, challenges.cloudflare.com (Turnstile iframe)
 *   worker-src: self, blob: (Turnstile web worker)
 *   frame-ancestors: self (equivalent to X-Frame-Options: SAMEORIGIN)
 *   base-uri / form-action: self
 *   upgrade-insecure-requests (browser-level HTTPS upgrade as fallback)
 * ────────────────────────────────────────────────────────────────────────── */

const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',

  // ⚠️  REPORT-ONLY — monitor browser console for violations.
  //     Once confirmed clean, rename to "Content-Security-Policy" to enforce.
  'Content-Security-Policy-Report-Only': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.fbcdn.net https://scontent.* https://pbs.twimg.com https://video.twimg.com",
    "connect-src 'self'",
    "font-src 'self'",
    "frame-src 'self' https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; '),
};

export const onRequest = defineMiddleware(async (ctx, next) => {
  /* ── 1. HTTPS redirect ─────────────────────────────────────────────────── */
  const proto = ctx.request.headers.get('x-forwarded-proto');
  if (proto === 'http') {
    const httpsUrl = ctx.url.toString().replace(/^http:/, 'https:');
    return Response.redirect(httpsUrl, 301);
  }

  /* ── 2. Run downstream handler (SSR page or static asset) ─────────────── */
  const response = await next();

  /* ── 3. Wrap with security headers ─────────────────────────────────────── */
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    newHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
});
