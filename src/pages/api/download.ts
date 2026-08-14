import type { APIRoute } from 'astro';
import { fetchTikTokMetaWithFallback, isValidTikTokUrl, type TikTokVideoMeta } from '../../lib/tiktok';
import { streamFromUpstream } from '../../lib/stream';
import { cacheHit, cacheWrite } from '../../lib/media-cache';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { resolveTikTokShortLink, normalizeTikTokUrl } from '../../lib/normalize';

export const prerender = false;

function pickStreamUrl(meta: TikTokVideoMeta, isHd: boolean): string | null {
  if (isHd) return meta.hdplay ?? meta.play ?? meta.wmplay;
  return meta.play ?? meta.wmplay ?? meta.hdplay;
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
        const streamUrl = pickStreamUrl(meta, isHd);
        if (!streamUrl) {
          return new Response(
            JSON.stringify({ success: false, error: 'No video URL available.' }),
            { status: 422, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return streamFromUpstream(streamUrl, {
          filename: 'tiksavehub-video.mp4',
          contentType: 'video/mp4',
          accept: 'video/mp4,video/*,*/*',
          referer: 'https://tikwm.com/',
        });
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

    const meta = await fetchTikTokMetaWithFallback(canonical, { hd: isHd });
    cacheWrite('tiktok', 'tt', canonical, 'tt', {
      args: { hd: String(isHd) },
      mediaUrl: pickStreamUrl(meta, isHd),
      thumb: meta.cover ?? null,
      title: meta.title,
      data: meta,
    });

    if (dl) {
      const streamUrl = pickStreamUrl(meta, isHd);
      if (!streamUrl) {
        return new Response(
          JSON.stringify({ success: false, error: 'No video URL available.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return streamFromUpstream(streamUrl, {
        filename: 'tiksavehub-video.mp4',
        contentType: 'video/mp4',
        accept: 'video/mp4,video/*,*/*',
        referer: 'https://tikwm.com/',
      });
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
      msg.includes('yt-dlp');
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