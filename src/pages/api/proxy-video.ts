import type { APIRoute } from 'astro';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { getEnv, initRequestEnv } from '../../lib/init-env';

export const prerender = false;

// Only proxy media from known TikTok/Instagram CDNs — never arbitrary URLs.
const ALLOWED_HOST_PATTERNS = [
  /(^|\.)tikwm\.com$/,
  /(^|\.)tiktokcdn\.com$/,
  /(^|\.)tik-tok\.cdn\.com$/,
  /(^|\.)cdninstagram\.com$/,
  /(^|\.)fna\.fbcdn\.net$/,
  /(^|\.)fbcdn\.net$/,
  /(^|\.)z-m\.scontent\.tiktokcdn\.com$/,
  /scontent-.*\.(cdninstagram\.com|fbcdn\.net)$/,
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
      JSON.stringify({ success: false, error: 'Rate limit exceeded. Try again later.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const videoUrl = url.searchParams.get('url');

  if (!videoUrl) {
    return new Response(
      JSON.stringify({ success: false, error: 'Missing "url" query parameter.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!isAllowedUrl(videoUrl)) {
    return new Response(
      JSON.stringify({ success: false, error: 'URL host is not allowed.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'video/mp4,video/*,*/*',
        'Referer': 'https://tikwm.com/',
      },
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`Upstream returned ${response.status}`);
    }

    const headers = new Headers();
    headers.set('Content-Type', response.headers.get('content-type') || 'video/mp4');
    headers.set('Content-Disposition', 'attachment; filename="tiksavehub-video.mp4"');
    headers.set('Cache-Control', 'no-store');

    const cl = response.headers.get('content-length');
    if (cl) headers.set('Content-Length', cl);

    return new Response(response.body, {
      status: 200,
      headers,
    });
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    console.error(`[TikSaveHub Proxy-Video] ${new Date().toISOString()} URL=${videoUrl} Error=${err?.message ?? String(err)}`);
    return new Response(
      JSON.stringify({ success: false, error: isTimeout ? 'Request timed out.' : 'Failed to fetch video.', errorType: isTimeout ? 'timeout' : 'api_error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
