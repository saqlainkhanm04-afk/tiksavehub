import type { APIRoute } from 'astro';
import { fetchTikTokMetaWithFallback, isValidTikTokUrl, type TikTokVideoMeta } from '../../lib/tiktok';
import { streamFromUpstream } from '../../lib/stream';
import { cacheHit, cacheWrite } from '../../lib/media-cache';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { resolveTikTokShortLink, normalizeTikTokUrl } from '../../lib/normalize';
import {
  isFfmpegAvailable,
  probeAudioBitrate,
  availableBitrates,
  reencodeMp3,
} from '../../lib/audio';
import { getEnv, initRequestEnv } from '../../lib/init-env';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  initRequestEnv(getEnv(ctx));
  const { url, request } = ctx;
  const videoUrl = url.searchParams.get('url');
  const dl = url.searchParams.get('dl');
  const brParam = url.searchParams.get('br');
  const requestedKbps = brParam ? Number(brParam) : 0;

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
    const canonical = await resolveTikTokShortLink(normalizeTikTokUrl(videoUrl));
    const cached = await cacheHit('tiktok', 'tt', canonical, 'audio');

    const fresh = async () => {
      const meta = await fetchTikTokMetaWithFallback(canonical);
      cacheWrite('tiktok', 'tt', canonical, 'audio', {
        args: {},
        mediaUrl: meta.music?.play ?? null,
        thumb: meta.cover ?? null,
        title: meta.title,
        data: meta,
      });
      return meta;
    };

    const video = cached?.data ? (cached.data as TikTokVideoMeta) : await fresh();
    const music = video.music;
    const audioUrl = music?.play ?? null;

    if (dl && audioUrl) {
      const safeTitle = (music?.title || video.title || 'TikTok Audio')
        .replace(/[^a-zA-Z0-9\s_-]/g, '')
        .trim()
        .slice(0, 80);

      const ffmpegOk = await isFfmpegAvailable();

      if (requestedKbps > 0 && ffmpegOk) {
        // Genuine re-encode at the requested bitrate.
        return reencodeMp3(audioUrl, {
          bitrateKbps: requestedKbps,
          filename: `${safeTitle || 'tiksavehub-audio'}-${requestedKbps}kbps.mp3`,
        });
      }

      if (requestedKbps > 0 && !ffmpegOk) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Custom bitrate conversion requires ffmpeg on the server (FFMPEG_PATH). The original audio is served instead.',
          }),
          { status: 501, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return streamFromUpstream(audioUrl, {
        filename: `${safeTitle || 'tiksavehub-audio'}.mp3`,
        contentType: 'audio/mpeg',
        accept: 'audio/mpeg,audio/*,*/*',
        referer: 'https://tikwm.com/',
      });
    }

    const ffmpegAvailable = await isFfmpegAvailable();
    const sourceKbps = audioUrl && ffmpegAvailable ? await probeAudioBitrate(audioUrl) : null;

    return new Response(
      JSON.stringify({
        success: true,
        audio: {
          play_url: audioUrl,
          title: music?.title ?? video.title ?? 'TikTok Audio',
          author: music?.author ?? video.author?.nickname ?? 'Unknown',
          duration: video.duration ?? 0,
          cover: video.cover ?? null,
          album: music?.album ?? null,
        },
        video: {
          title: video.title ?? '',
          author: video.author ?? { unique_id: '', nickname: '' },
          cover: video.cover ?? null,
          digg_count: video.digg_count ?? 0,
          comment_count: video.comment_count ?? 0,
          share_count: video.share_count ?? 0,
        },
        bitrate: {
          sourceKbps,
          options: availableBitrates(sourceKbps),
          ffmpegAvailable,
        },
        fromCache: Boolean(cached?.data),
      }),
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
    console.error('[TikSaveHub MP3 API] Error:', msg);

    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const isBusy =
      msg.includes('All TikTok servers are busy') ||
      msg.includes('Upstream API returned') ||
      msg.includes('Upstream returned') ||
      msg.includes('yt-dlp');
    const isRestricted =
      msg.includes('invalid or expired') ||
      msg.includes('Url parsing is failed') ||
      msg.includes('no downloadable media') ||
      msg.includes('returned no media');

    const errorMsg = isTimeout
      ? 'The server took too long to respond. Please try again in a moment.'
      : isRestricted
        ? 'This content may be unavailable or restricted. Please try another public link.'
        : isBusy
          ? 'This content could not be fetched right now. Please try again in a few seconds or use another link.'
          : 'Failed to fetch audio. Please check the link and try again.';

    return new Response(
      JSON.stringify({ success: false, error: errorMsg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};