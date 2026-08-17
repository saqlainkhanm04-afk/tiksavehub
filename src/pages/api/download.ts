import type { APIRoute } from 'astro';
import { fetchTikTokMetaWithFallback, isValidTikTokUrl, type TikTokVideoMeta } from '../../lib/tiktok';
import { streamFromUpstream } from '../../lib/stream';
import { cacheHit, cacheWrite } from '../../lib/media-cache';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { resolveTikTokShortLink, normalizeTikTokUrl } from '../../lib/normalize';

export const prerender = false;

const DEFAULT_STREAM_TIMEOUT_MS = 60_000;
const HD_ATTEMPT_TIMEOUT_MS = 20_000;

interface StreamConfig {
  filename: string;
  contentType: string;
  accept?: string;
  referer?: string;
}

const STREAM_CONFIG: StreamConfig = {
  filename: 'tiksavehub-video.mp4',
  contentType: 'video/mp4',
  accept: 'video/mp4,video/*,*/*',
  referer: 'https://tikwm.com/',
};

// HD first, then fall back down the quality ladder (some ISPs/CDN edges
// block the HD host — e.g. v16-notes.tiktokcdn-us.com — while the SD host
// stays reachable, so we retry with the next best URL instead of failing).
function pickStreamCandidates(meta: TikTokVideoMeta, isHd: boolean): string[] {
  const order = isHd
    ? [meta.hdplay, meta.play, meta.wmplay]
    : [meta.play, meta.wmplay, meta.hdplay];
  return [...new Set(order.filter((u): u is string => Boolean(u)))];
}

// Tries each candidate in order, cycling for a bounded number of attempts:
// the HD host gets one quick shot (it may be blocked), and the normally
// reachable URLs get a retry to ride out transient CDN resets. When the
// cache has held the stream URLs too long (TikTok signs them with an
// expiry), a metadata refresh re-signs them before the final attempts.
async function streamFirstReachable(
  candidates: string[],
  isHd: boolean,
  refreshCandidates: () => Promise<string[]>
): Promise<Response> {
  const maxRounds = 2;
  let lastError: unknown = null;
  for (let round = 0; round < maxRounds; round++) {
    let attempts = 0;
    while (attempts < Math.max(2, candidates.length)) {
      const url = candidates[attempts % candidates.length];
      try {
        return await streamFromUpstream(url, {
          ...STREAM_CONFIG,
          timeoutMs: attempts === 0 && isHd ? HD_ATTEMPT_TIMEOUT_MS : DEFAULT_STREAM_TIMEOUT_MS,
        });
      } catch (err) {
        lastError = err;
        attempts++;
      }
    }
    if (round === 0) {
      const fresh = await refreshCandidates();
      if (fresh.length > 0) {
        candidates = fresh;
        continue;
      }
    }
    break;
  }
  throw lastError ?? new Error('No video URL available.');
}

export const GET: APIRoute = async ({ url, request }) => {
  const videoUrl = url.searchParams.get('url');
  const dl = url.searchParams.get('dl');

  if (!videoUrl) {
    return new Response(
      JSON.stringify({ success: false, error: 'Missing "url" query parameter.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!isValidTikTokUrl(videoUrl)) {
    return new Response(
      JSON.stringify({ success: false, error: 'Invalid URL. Please provide a valid TikTok video link.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (isRateLimited(clientIpFrom(request))) {
    return new Response(
      JSON.stringify({ success: false, error: 'Too many requests. Please try again in a minute.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const isHd = dl === 'hd';
    const canonical = await resolveTikTokShortLink(normalizeTikTokUrl(videoUrl));
    const cached = cacheHit('tiktok', 'tt', canonical, 'tt');

    if (cached?.data) {
      const meta = cached.data as TikTokVideoMeta;
      if (dl) {
        const candidates = pickStreamCandidates(meta, isHd);
        if (candidates.length === 0) {
          return new Response(
            JSON.stringify({ success: false, error: 'No video URL available.' }),
            { status: 422, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const refreshCandidates = async (): Promise<string[]> => {
          try {
            const fresh = await fetchTikTokMetaWithFallback(canonical);
            const freshCandidates = pickStreamCandidates(fresh, isHd);
            if (freshCandidates.length > 0) {
              cacheWrite('tiktok', 'tt', canonical, 'tt', {
                args: { hd: String(isHd) },
                mediaUrl: freshCandidates[0] ?? null,
                thumb: fresh.cover ?? null,
                title: fresh.title,
                data: fresh,
              });
              return freshCandidates;
            }
          } catch {}
          return [];
        };
        return streamFirstReachable(candidates, isHd, refreshCandidates);
      }

      return new Response(
        JSON.stringify({ success: true, video: meta, fromCache: true }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
          },
        }
      );
    }

    const meta = await fetchTikTokMetaWithFallback(canonical);
    const candidates = pickStreamCandidates(meta, isHd);
    cacheWrite('tiktok', 'tt', canonical, 'tt', {
      args: { hd: String(isHd) },
      mediaUrl: candidates[0] ?? null,
      thumb: meta.cover ?? null,
      title: meta.title,
      data: meta,
    });

    if (dl) {
      if (candidates.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'No video URL available.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const refreshCandidates = (): Promise<string[]> => Promise.resolve(candidates);
      return streamFirstReachable(candidates, isHd, refreshCandidates);
    }

    return new Response(
      JSON.stringify({ success: true, video: meta }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
        },
      }
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error('[TikSaveHub API] Error:', msg);

    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const isBusy =
      msg.includes('All TikTok servers are busy') ||
      msg.includes('Upstream API returned') ||
      msg.includes('Upstream returned') ||
      msg.includes('yt-dlp') ||
      msg.includes('fetch failed');
    const isInvalid = msg.includes('invalid or expired') || msg.includes('Url parsing is failed');
    const isRestricted =
      isInvalid || msg.includes('no downloadable media') || msg.includes('returned no media');

    const errorMsg = isTimeout
      ? 'The server took too long to respond. Please try again in a moment.'
      : isRestricted
        ? 'This content may be unavailable or restricted. Please try another public link.'
        : isBusy
          ? 'This content could not be fetched right now. Please try again in a few seconds or use another link.'
          : 'Failed to fetch video. Please check the link and try again.';

    return new Response(
      JSON.stringify({ success: false, error: errorMsg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};