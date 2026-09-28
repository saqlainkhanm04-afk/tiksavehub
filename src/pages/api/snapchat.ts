import type { APIRoute } from 'astro';
import { parseSnapchatUrl } from '../../lib/snapchat-url';
import {
  fetchSnapchatMedia,
  removeSnapchatWatermark,
  type SnapchatMediaMeta,
} from '../../lib/snapchat';
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
  if (msg.includes('no downloadable') || msg.includes('no media') || msg.includes('extract media')) {
    return 'This Snapchat link does not contain any downloadable media. Please try another link.';
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return 'The server took too long to respond. Please try again in a moment.';
  }
  if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET')) {
    return 'This media could not be fetched right now. Please try again later.';
  }
  if (msg.includes('yt-dlp')) {
    return 'This media could not be fetched right now. Please try again later.';
  }
  return 'Failed to fetch this Snapchat media. Please check the link and try again.';
}

function safeMediaId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'media';
}

function cachedMediaType(data: Record<string, any>): 'image' | 'video' {
  return data.mediaType === 'image' || data.isImage === true || data.isPhoto === true ? 'image' : 'video';
}

function metaFromCachedData(data: Record<string, any>, fallbackId: string): SnapchatMediaMeta | null {
  const mediaType = cachedMediaType(data);
  const mediaUrl = mediaType === 'image'
    ? (typeof data.mediaUrl === 'string' ? data.mediaUrl : null)
    : (data.videoHd || data.videoSd || data.videoUrl || data.mediaUrl || null);
  if (typeof mediaUrl !== 'string' || !mediaUrl) return null;
  const duration = Number(data.duration);
  return {
    mediaId: String(data.mediaId || fallbackId || ''),
    title: String(data.title || 'Snapchat Video'),
    thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    mediaType,
    mediaUrl,
    contentType: data.contentType || (mediaType === 'image' ? 'image/jpeg' : 'video/mp4'),
    videoUrl: mediaType === 'video' ? mediaUrl : null,
    videoHd: mediaType === 'video' ? mediaUrl : null,
    videoSd: mediaType === 'video' ? mediaUrl : null,
    isStory: data.isStory === true,
  };
}

function payloadFromMeta(meta: SnapchatMediaMeta): Record<string, any> {
  const isImage = meta.mediaType === 'image';
  return {
    mediaId: meta.mediaId,
    title: meta.title,
    thumbnail: meta.thumbnail,
    duration: meta.duration,
    mediaType: meta.mediaType,
    mediaUrl: meta.mediaUrl,
    contentType: meta.contentType,
    isImage,
    videoUrl: meta.videoUrl,
    videoHd: meta.videoHd,
    videoSd: meta.videoSd,
    isStory: meta.isStory,
  };
}

async function readSnapchatCache(mediaId: string) {
  const current = await cacheHit('snapchat', 'snapchat', mediaId, 'media');
  if (current) return current;
  return cacheHit('snapchat', 'snapchat', mediaId, 'video');
}

async function cacheMeta(mediaId: string, meta: SnapchatMediaMeta): Promise<Record<string, any>> {
  const payload = payloadFromMeta(meta);
  await cacheWrite('snapchat', 'snapchat', mediaId, 'media', {
    args: { type: meta.mediaType },
    mediaUrl: meta.mediaUrl,
    thumb: meta.thumbnail,
    title: meta.title.slice(0, 200),
    data: payload,
    mediaType: meta.mediaType,
  });
  return payload;
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
  const cached = await readSnapchatCache(mediaId);
  const cachedData = cached?.data as Record<string, any> | undefined;
  const cachedMeta = cachedData ? metaFromCachedData(cachedData, mediaId) : null;
  if (cachedMeta) {
    const payload = payloadFromMeta(cachedMeta);
    return json({ success: true, type: payload.mediaType === 'image' ? 'snapchat-image' : 'snapchat-video', media: payload, video: payload, fromCache: true }, 200, true);
  }

  try {
    const meta = await fetchSnapchatMedia(parsed.sanitizedUrl, mediaId, turnstileToken);
    const payload = await cacheMeta(mediaId, meta);
    return json({ success: true, type: payload.mediaType === 'image' ? 'snapchat-image' : 'snapchat-video', media: payload, video: payload }, 200, true);
  } catch (err: any) {
    console.error(`[Snapchat API] ${new Date().toISOString()} POST error: ${err?.message ?? err}`);
    return json({ success: false, error: userMessageFor(err), errorType: 'api_error' }, 200);
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
  if (!['hd', 'sd', 'audio', 'image'].includes(mode)) {
    return json({ success: false, error: 'Invalid download mode.' }, 422);
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
    const cached = await readSnapchatCache(mediaId);
    const cachedData = cached?.data as Record<string, any> | undefined;
    let meta = cachedData ? metaFromCachedData(cachedData, mediaId) : null;
    if (!meta) {
      meta = await fetchSnapchatMedia(parsed.sanitizedUrl, mediaId, turnstileToken);
      await cacheMeta(mediaId, meta);
    }

    const isImage = meta.mediaType === 'image';
    if (mode === 'audio' && isImage) {
      return json(
        { success: false, error: 'Audio extraction is not available for a Snapchat story photo. Please download the photo or choose a video link.' },
        501
      );
    }
    if (mode === 'image' && !isImage) {
      return json({ success: false, error: 'This Snapchat link does not contain a downloadable photo.' }, 422);
    }

    if (mode === 'audio') {
      const audioFilename = `tiksavehub-snapchat-audio-${safeMediaId(mediaId)}.mp3`;
      const audio = await cobaltExtractAudio(parsed.sanitizedUrl, turnstileToken);
      if (audio?.url) {
        return await streamFromUpstream(audio.url, {
          filename: audioFilename,
          contentType: 'audio/mpeg',
          accept: 'audio/*,*/*',
          referer: SC_REFERER,
          audio: true,
        });
      }
      return json(
        { success: false, error: 'Audio extraction is not available for this Snapchat link. Please try downloading the video instead and convert it locally.' },
        501
      );
    }

    const sourceUrl = isImage
      ? meta.mediaUrl
      : mode === 'sd'
        ? (meta.videoSd || meta.videoHd || meta.mediaUrl)
        : (meta.videoHd || meta.videoUrl || meta.mediaUrl);
    if (!sourceUrl) {
      return json({ success: false, error: 'No downloadable media found.' }, 404);
    }

    const filename = isImage
      ? `tiksavehub-snapchat-story-${safeMediaId(mediaId)}.jpg`
      : `tiksavehub-snapchat-${safeMediaId(mediaId)}.mp4`;

    if (isImage) {
      return await streamFromUpstream(sourceUrl, {
        filename,
        contentType: meta.contentType || 'image/jpeg',
        accept: 'image/jpeg,image/png,image/webp,image/*,*/*',
        referer: SC_REFERER,
        image: true,
      });
    }

    const delogoResponse = await removeSnapchatWatermark(sourceUrl, filename);
    if (delogoResponse) return delogoResponse;

    return await streamFromUpstream(sourceUrl, {
      filename,
      contentType: meta.contentType || 'video/mp4',
      accept: 'video/mp4,video/*,*/*',
      referer: SC_REFERER,
    });
  } catch (err: any) {
    console.error(`[Snapchat API] ${new Date().toISOString()} GET error: ${err?.message ?? err}`);
    return json({ success: false, error: userMessageFor(err), errorType: 'api_error' }, 500);
  }
};
