import type { APIRoute } from 'astro';
import { fetchInstagramProfile, setInstagramEnv } from '../../lib/instagram';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { getEnv, initRequestEnv } from '../../lib/init-env';

export const prerender = false;

const RESERVED_PATHS = new Set([
  'about',
  'accounts',
  'api',
  'challenge',
  'developer',
  'direct',
  'directory',
  'emails',
  'explore',
  'legal',
  'p',
  'reel',
  'reels',
  'stories',
  'tv',
  'web',
]);

function usernameFromInput(raw: string): string | null {
  const value = raw.trim().replace(/^@+/, '');
  if (!value) return null;

  if (/^https?:\/\//i.test(value) || /(?:^|\.)instagram\.com(?:\/|$)/i.test(value)) {
    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
      const segment = url.pathname.split('/').filter(Boolean)[0] || '';
      const candidate = decodeURIComponent(segment).replace(/^@+/, '');
      if (!candidate || RESERVED_PATHS.has(candidate.toLowerCase())) return null;
      return /^[a-z0-9._]{1,30}$/i.test(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  return /^[a-z0-9._]{1,30}$/i.test(value) ? value : null;
}

export const GET: APIRoute = async ({ url, request }) => {
  initRequestEnv(getEnv({ request }));

  if (isRateLimited(clientIpFrom(request))) {
    return new Response(
      JSON.stringify({ success: false, error: 'Too many requests. Try again in a minute.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const raw = url.searchParams.get('username') || url.searchParams.get('url') || '';
  const username = usernameFromInput(raw);
  if (!username) {
    return new Response(
      JSON.stringify({ success: false, error: 'Enter a valid Instagram username or profile link.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
  }

  setInstagramEnv(getEnv({ request }));

  try {
    const profile = await fetchInstagramProfile(username);
    return new Response(JSON.stringify({ success: true, profile }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=1800, s-maxage=21600, stale-while-revalidate=86400',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[TikSaveHub IG Profile] username=${username} error=${message}`);
    const notFound = /not found|does not expose|valid Instagram username/i.test(message);
    return new Response(
      JSON.stringify({
        success: false,
        error: notFound
          ? message
          : 'Could not load this Instagram profile right now. Check the username or try again in a minute.',
      }),
      { status: notFound ? 404 : 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
