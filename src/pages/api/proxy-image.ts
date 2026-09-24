import type { APIRoute } from 'astro';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { getEnv, initRequestEnv } from '../../lib/init-env';

export const prerender = false;

// Only proxy images from known CDN hosts — never arbitrary URLs.
const ALLOWED_HOST_PATTERNS = [
  // Facebook
  /(^|\.)fbcdn\.net$/,
  /(^|\.)fna\.fbcdn\.net$/,
  /(^|\.)scontent-.*\.(fbcdn\.net|cdninstagram\.com)$/,
  // Instagram
  /(^|\.)cdninstagram\.com$/,
  /(^|\.)external\.cdn-instagram\.com$/,
  // TikTok
  /(^|\.)tikwm\.com$/,
  /(^|\.)tiktokcdn\.com$/,
  /(^|\.)z-m\.scontent\.tiktokcdn\.com$/,
  // X / Twitter
  /(^|\.)twimg\.com$/,
  // Snapchat
  /(^|\.)snapcdn\.com$/,
];

// 1x1 transparent PNG (so frontend never shows a broken-image icon)
const TRANSPARENT_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

function isAllowedUrl(input: string): boolean {
  try {
    const u = new URL(input);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return ALLOWED_HOST_PATTERNS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export const GET: APIRoute = async (ctx) => {
  initRequestEnv(getEnv(ctx));
  const { url, request } = ctx;
  const clientIp = clientIpFrom(request);
  if (isRateLimited(clientIp)) {
    return new Response(
      JSON.stringify({ success: false, error: 'Rate limit exceeded. Try again later.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const imageUrl = url.searchParams.get('url');

  if (!imageUrl) {
    return new Response(
      JSON.stringify({ success: false, error: 'Missing "url" query parameter.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!isAllowedUrl(imageUrl)) {
    return new Response(
      JSON.stringify({ success: false, error: 'URL host is not allowed.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const host = new URL(imageUrl).hostname;
    const isTikTok = host.includes('tiktokcdn') || host.includes('tikwm');
    const isInstagram = host.includes('cdninstagram') || host.includes('fbcdn');
    const isX = host.includes('twimg');
    const isSnapchat = host.includes('snapcdn');
    const referer = isTikTok
      ? 'https://www.tiktok.com/'
      : isInstagram
        ? 'https://www.instagram.com/'
        : isX
          ? 'https://x.com/'
          : isSnapchat
            ? 'https://www.snapchat.com/'
            : 'https://www.facebook.com/';
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': referer,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.error(`[TikSaveHub Proxy-Image] ${new Date().toISOString()} URL=${imageUrl} Upstream=${response.status}`);
      return new Response(TRANSPARENT_PNG, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=60, s-maxage=60',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    headers.set('Access-Control-Allow-Origin', '*');

    const cl = response.headers.get('content-length');
    if (cl) headers.set('Content-Length', cl);

    return new Response(response.body, {
      status: 200,
      headers,
    });
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    console.error(`[TikSaveHub Proxy-Image] ${new Date().toISOString()} URL=${imageUrl} Error=${err?.message ?? String(err)}`);
    // Return 1x1 transparent PNG so the <img> tag never shows a broken icon
    return new Response(TRANSPARENT_PNG, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=60, s-maxage=60',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
};
