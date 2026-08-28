import type { APIRoute } from 'astro';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { getEnv, initRequestEnv } from '../../lib/init-env';

export const prerender = false;

// Only proxy images from known Facebook/Instagram CDNs — never arbitrary URLs.
const ALLOWED_HOST_PATTERNS = [
  /(^|\.)fbcdn\.net$/,
  /(^|\.)fna\.fbcdn\.net$/,
  /(^|\.)scontent-.*\.(fbcdn\.net|cdninstagram\.com)$/,
  /(^|\.)cdninstagram\.com$/,
  /(^|\.)external\.cdn-instagram\.com$/,
];

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
      JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const imageUrl = url.searchParams.get('url');

  if (!imageUrl) {
    return new Response(
      JSON.stringify({ error: 'Missing "url" query parameter.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!isAllowedUrl(imageUrl)) {
    return new Response(
      JSON.stringify({ error: 'URL host is not allowed.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.facebook.com/',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Upstream returned ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    headers.set('Access-Control-Allow-Origin', '*');

    const cl = response.headers.get('content-length');
    if (cl) headers.set('Content-Length', cl);

    return new Response(response.body, {
      status: 200,
      headers,
    });
  } catch (err: any) {
    console.error('[TikSaveHub Proxy-Image] Error:', err?.message ?? String(err));
    return new Response(
      JSON.stringify({ error: 'Failed to fetch image.' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
