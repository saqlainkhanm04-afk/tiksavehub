import type { APIRoute } from 'astro';
import { parseSnapchatUrl } from '../../lib/snapchat-url';
import { fetchSnapchatMedia, removeSnapchatWatermark } from '../../lib/snapchat';
import { cobaltExtractAudio } from '../../lib/cobalt';
import { streamFromUpstream } from '../../lib/stream';
import { cacheHit, cacheWrite } from '../../lib/media-cache';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { getEnv, initRequestEnv } from '../../lib/init-env';

export const prerender = false;

const SC_REFERER = 'https://www.snapchat.com/';

function json(body: unknown, status: number, cacheable = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(cacheable
        ? { 'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400' }
        : { 'Cache-Control': 'no-store' }),
    },
  });
}

function userMessageFor(err: any): string {
  const msg = err?.message ?? String(err);
  if (msg.includes('private') || msg.includes('deleted')) {
    return 'This Snapchat content is private or was deleted. Please try another public Snapchat link.';
  }
  if (msg.includes('no video') || msg.includes('no downloadable')) {
    return 'This Snapchat link does not contain any downloadable video. Please try another link.';
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return 'The server took too long to respond. Please try again in a moment.';
  }
  if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET')) {
    return 'This video could not be fetched right now. Please try again later.';
  }
  if (msg.includes('yt-dlp')) {
    return 'This video could not be fetched right now. Please try again later.';
  }
  return 'Failed to fetch this video. Please check the link and try again.';
}

const MAX_POST_BODY_BYTES = 8192;

export const POST: APIRoute = async (ctx) => {
  initRequestEnv(getEnv(ctx));
  const { request } = ctx;
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_POST_BODY_BYTES) {
    return json({ success: false, error: 'Request body too large.' }, 413);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid request body. Send JSON with a "url" field.' }, 400);
  }

  const rawUrl = typeof body?.url === 'string' ? body.url : '';
  const turnstileToken = typeof body?.turnstileToken === 'string' ? body.turnstileToken : undefined;
  if (!rawUrl.trim()) {
    return json({ success: false, error: 'Missing "url" in the request body.' }, 400);
  }

  if (isRateLimited(clientIpFrom(request))) {
    return json({ success: false, error: 'Too many requests. Please try again in a minute.' }, 429);
  }

  const parsed = parseSnapchatUrl(rawUrl);
  if (!parsed.isValid) {
    return json({ success: false, error: parsed.error || 'Invalid Snapchat URL.' }, 422);
  }

  const mediaId = parsed.mediaId || parsed.username || 'unknown';

    const cached = await cacheHit('snapchat', 'snapchat', mediaId, 'video');
  const cachedData = cached?.data as Record<string, unknown> | undefined;
  if (cachedData && cachedData.videoUrl) {
    return json({ success: true, type: 'snapchat-video', video: cachedData, fromCache: true }, 200, true);
  }

  try {
    const snapUrl = parsed.sanitizedUrl;
    const meta = await fetchSnapchatMedia(snapUrl, mediaId, turnstileToken);

    const payload = {
      mediaId: meta.mediaId,
      title: meta.title,
      thumbnail: meta.thumbnail,
      duration: meta.duration,
      videoUrl: meta.videoUrl,
      videoHd: meta.videoHd,
      videoSd: meta.videoSd,
      isStory: meta.isStory,
    };

    cacheWrite('snapchat', 'snapchat', mediaId, 'video', {
      args: { type: 'video' },
      mediaUrl: meta.videoHd || meta.videoUrl,
      thumb: meta.thumbnail,
      title: meta.title.slice(0, 200),
      data: payload,
    });

    return json({ success: true, type: 'snapchat-video', video: payload }, 200, true);
  } catch (err: any) {
    console.error('[Snapchat API] Error:', err?.message ?? err);
    return json({ success: false, error: userMessageFor(err) }, 500);
  }
};

export const GET: APIRoute = async (ctx) => {
  initRequestEnv(getEnv(ctx));
  const { url, request } = ctx;
  const rawUrl = url.searchParams.get('url') || '';
  const mode = url.searchParams.get('dl') || 'hd';
  const turnstileToken = url.searchParams.get('turnstileToken') || undefined;

  if (!rawUrl.trim()) {
    return json({ success: false, error: 'Missing "url" parameter.' }, 400);
  }

  if (isRateLimited(clientIpFrom(request))) {
    return json({ success: false, error: 'Too many requests.' }, 429);
  }

  const parsed = parseSnapchatUrl(rawUrl);
  if (!parsed.isValid) {
    return json({ success: false, error: parsed.error || 'Invalid Snapchat URL.' }, 422);
  }

  const mediaId = parsed.mediaId || parsed.username || 'unknown';

  try {
  const cached = await cacheHit('snapchat', 'snapchat', mediaId, 'video');
    const cachedData = cached?.data as Record<string, unknown> | undefined;

    let videoUrl: string | null = null;

    if (cachedData) {
      if (mode === 'hd') {
        videoUrl = (cachedData.videoHd as string) || (cachedData.videoSd as string) || (cachedData.videoUrl as string) || null;
      } else {
        videoUrl = (cachedData.videoSd as string) || (cachedData.videoHd as string) || (cachedData.videoUrl as string) || null;
      }
    }

    if (!videoUrl) {
      const meta = await fetchSnapchatMedia(parsed.sanitizedUrl, mediaId, turnstileToken);
      videoUrl = mode === 'hd' ? (meta.videoHd || meta.videoUrl) : (meta.videoSd || meta.videoHd || meta.videoUrl);

      if (videoUrl) {
        cacheWrite('snapchat', 'snapchat', mediaId, 'video', {
          args: { type: 'video' },
          mediaUrl: videoUrl,
          thumb: meta.thumbnail,
          title: meta.title.slice(0, 200),
          data: {
            mediaId: meta.mediaId,
            title: meta.title,
            thumbnail: meta.thumbnail,
            duration: meta.duration,
            videoUrl: meta.videoUrl,
            videoHd: meta.videoHd,
            videoSd: meta.videoSd,
          },
        });
      }
    }

    if (!videoUrl) {
      return json({ success: false, error: 'No downloadable video found.' }, 404);
    }

    const filename = `tiksavehub-snapchat-${mediaId}.mp4`;

    if (mode === 'audio') {
      const audioFilename = `tiksavehub-snapchat-audio-${mediaId}`;

      const audio = await cobaltExtractAudio(parsed.sanitizedUrl, turnstileToken);
      if (audio?.url) {
        return streamFromUpstream(audio.url, {
          filename: `${audioFilename}.mp3`,
          contentType: 'audio/mpeg',
          accept: 'audio/*,*/*',
        });
      }

      return json(
        { success: false, error: 'Audio extraction is not available for this Snapchat link. Please try downloading the video instead and convert it locally.' },
        501
      );
    }

    // Try ffmpeg delogo to remove Snapchat watermark; fall back to raw stream
    const delogoResponse = await removeSnapchatWatermark(videoUrl, filename);
    if (delogoResponse) return delogoResponse;

    return streamFromUpstream(videoUrl, {
      filename,
      contentType: 'video/mp4',
      accept: 'video/mp4,video/*,*/*',
      referer: SC_REFERER,
    });
  } catch (err: any) {
    console.error('[Snapchat API] Download error:', err?.message ?? err);
    return json({ success: false, error: userMessageFor(err) }, 500);
  }
};
