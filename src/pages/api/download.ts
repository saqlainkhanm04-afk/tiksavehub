import type { APIRoute } from 'astro';
import { fetchTikTokMetaWithFallback, isValidTikTokUrl, type TikTokVideoMeta } from '../../lib/tiktok';
import { streamFromUpstream } from '../../lib/stream';
import { cacheHit, cacheWrite } from '../../lib/media-cache';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { resolveTikTokShortLink, normalizeTikTokUrl } from '../../lib/normalize';
import { getEnv, initRequestEnv } from '../../lib/init-env';

export const prerender = false;

const DEFAULT_STREAM_TIMEOUT_MS = 60_000;
const HD_ATTEMPT_TIMEOUT_MS = 8_000;

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
};

function refererForUrl(videoUrl: string): string {
  try {
    const host = new URL(videoUrl).hostname;
    if (host.includes('tiktok')) return 'https://www.tiktok.com/';
    if (host.includes('tikwm')) return 'https://tikwm.com/';
    if (host.includes('tikcdn')) return 'https://www.tiktok.com/';
    if (host.includes('cobalt')) return 'https://cobalt.tools/';
  } catch {}
  return 'https://www.tiktok.com/';
}

function pickStreamCandidates(meta: TikTokVideoMeta, isHd: boolean): string[] {
  const order = isHd
    ? [meta.hdplay, meta.play, meta.wmplay]
    : [meta.play, meta.wmplay, meta.hdplay];
  return [...new Set(order.filter((u): u is string => Boolean(u)))];
}

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
      console.log(`[TikDownload] ▶ Attempting stream from: ${url.substring(0, 120)}...`);
      try {
        const resp = await streamFromUpstream(url, {
          ...STREAM_CONFIG,
          referer: refererForUrl(url),
          timeoutMs: attempts === 0 && isHd ? HD_ATTEMPT_TIMEOUT_MS : DEFAULT_STREAM_TIMEOUT_MS,
        });
        console.log(`[TikDownload] ✓ Stream success from: ${url.substring(0, 120)} — status=${resp.status} ct=${resp.headers.get('content-type')} cl=${resp.headers.get('content-length')}`);
        return resp;
      } catch (err) {
        lastError = err;
        console.log(`[TikDownload] ✗ Stream failed from: ${url.substring(0, 120)} — error=${err instanceof Error ? err.message : err}`);
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

export const GET: APIRoute = async (ctx) => {
  const { url, request } = ctx;
  initRequestEnv(getEnv(ctx));
  const videoUrl = url.searchParams.get('url');
  const dl = url.searchParams.get('dl');
  const turnstileToken = url.searchParams.get('turnstileToken') || undefined;

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
    const cached = await cacheHit('tiktok', 'tt', canonical, 'tt');

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
            const fresh = await fetchTikTokMetaWithFallback(canonical, { turnstileToken });
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

    const meta = await fetchTikTokMetaWithFallback(canonical, { turnstileToken });
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

    // Log the full source chain for debugging
    if (msg.includes('All') && msg.includes('API sources failed')) {
      console.error('[TikSaveHub API] ALL SOURCES FAILED:', msg);
    }

    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';

    // Detect if ALL sources failed (api-fallback throws this pattern)
    const allFailedMatch = msg.match(/All \d+ API sources failed/);
    const allSourcesFailed = !!allFailedMatch;

    // Classify the dominant failure across all sources
    const hasRateLimit = /429|rate.?limit|too many/i.test(msg);
    const hasTimeout = /timeout|timed? ?out|abort/i.test(msg);
    const hasNetwork = /fetch failed|ECONNRESET|ENOTFOUND|getaddrinfo|network/i.test(msg);
    const hasBlocked = /403|blocked|forbidden|captcha|challenge/i.test(msg);
    const hasInvalid = /invalid|expired|not found|404|parse.*fail|no.*video.*id/i.test(msg);
    const noTurnstile = /no turnstile/i.test(msg);

    // Check if TikWM specifically failed (quota/rate limit)
    const tikwmFailed = /TikWM/i.test(msg);
    const tikwmQuota = /429|rate.?limit|too many|quota/i.test(msg) && tikwmFailed;

    let errorMsg: string;
    if (tikwmQuota) {
      errorMsg = 'This service is temporarily at high demand. Please try again in a few hours, or try a different video link.';
    } else if (isTimeout || hasTimeout) {
      errorMsg = 'The server took too long to respond. Please try again in a moment.';
    } else if (noTurnstile) {
      errorMsg = 'This content could not be fetched right now. Please try again in a few seconds or use another link.';
    } else if (hasRateLimit) {
      errorMsg = 'All extraction services are busy right now. Please try again in 30 seconds.';
    } else if (hasBlocked) {
      errorMsg = 'This content may be restricted. Please try another public link.';
    } else if (hasInvalid) {
      errorMsg = 'This link may be invalid or the content has been removed. Please try another link.';
    } else if (hasNetwork) {
      errorMsg = 'A network error occurred. Please check your connection and try again.';
    } else if (allSourcesFailed) {
      errorMsg = 'This content could not be fetched right now. All extraction services failed — please try again in a few seconds or use another link.';
    } else {
      errorMsg = 'Failed to fetch video. Please check the link and try again.';
    }

    console.error(`[TikSaveHub API] ${new Date().toISOString()} URL=${videoUrl} Error=${msg}`);
    return new Response(
      JSON.stringify({ success: false, error: errorMsg, errorType: isTimeout ? 'timeout' : 'api_error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
