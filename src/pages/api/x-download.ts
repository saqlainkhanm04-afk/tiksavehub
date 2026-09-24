import type { APIRoute } from 'astro';
import { parseXUrl } from '../../lib/x-url';
import { fetchTweetMeta, pickBestVariant } from '../../lib/x';
import { cobaltExtractAudio } from '../../lib/cobalt';
import { streamFromUpstream } from '../../lib/stream';
import { cacheHit, cacheWrite } from '../../lib/media-cache';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { getEnv, initRequestEnv } from '../../lib/init-env';

export const prerender = false;

const X_REFERER = 'https://x.com/';

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
    return 'This tweet is private or was deleted. Please try another public X video link.';
  }
  if (msg.includes('no video') || msg.includes('no downloadable')) {
    return 'This tweet does not contain any downloadable video. Please try another link.';
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
  if (!rawUrl.trim()) {
    return json({ success: false, error: 'Missing "url" in the request body.' }, 400);
  }

  if (isRateLimited(clientIpFrom(request))) {
    return json({ success: false, error: 'Too many requests. Please try again in a minute.' }, 429);
  }

  const parsed = parseXUrl(rawUrl);
  if (!parsed.isValid) {
    return json({ success: false, error: parsed.error || 'Invalid X/Twitter URL.' }, 422);
  }
  if (!parsed.tweetId) {
    return json({ success: false, error: 'Could not find a tweet ID in this URL.' }, 422);
  }

  const cached = await cacheHit('x', 'x', parsed.tweetId, 'video');
  const cachedData = cached?.data as Record<string, unknown> | undefined;
  if (cachedData && cachedData.variants) {
    return json({ success: true, type: 'x-video', video: cachedData, fromCache: true }, 200, true);
  }

  try {
    const meta = await fetchTweetMeta(parsed.sanitizedUrl, parsed.tweetId);
    const hd = pickBestVariant(meta.variants, true);
    const sd = pickBestVariant(meta.variants, false);

    const payload = {
      tweetId: meta.tweetId,
      username: meta.username,
      authorName: meta.authorName,
      authorAvatar: meta.authorAvatar,
      text: meta.text,
      thumbnail: meta.thumbnail,
      duration: meta.duration,
      isGif: meta.isGif,
      viewCount: meta.viewCount,
      likeCount: meta.likeCount,
      retweetCount: meta.retweetCount,
      createdAt: meta.createdAt,
      hdUrl: hd?.url || null,
      sdUrl: sd?.url || null,
      hdHeight: hd?.height || null,
      sdHeight: sd?.height || null,
      variants: meta.variants.map((v) => ({
        url: v.url,
        height: v.height,
        bitrate: v.bitrate,
      })),
    };

    cacheWrite('x', 'x', parsed.tweetId, 'video', {
      args: { type: 'video' },
      mediaUrl: payload.hdUrl || payload.sdUrl,
      thumb: payload.thumbnail,
      title: payload.text.slice(0, 200),
      data: payload,
    });

    return json({ success: true, type: 'x-video', video: payload }, 200, true);
  } catch (err: any) {
    console.error(`[X API] ${new Date().toISOString()} POST error: ${err?.message ?? err}`);
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

  if (isRateLimited(clientIpFrom(request))) {
    return json({ success: false, error: 'Too many requests.' }, 429);
  }

  const parsed = parseXUrl(rawUrl);
  if (!parsed.isValid || !parsed.tweetId) {
    return json({ success: false, error: parsed.error || 'Invalid X/Twitter URL.' }, 422);
  }

  try {
    if (mode === 'audio') {
      const audioFilename = `tiksavehub-x-audio-${parsed.tweetId}`;
      const audio = await cobaltExtractAudio(parsed.sanitizedUrl, turnstileToken);
      if (audio?.url) {
        return streamFromUpstream(audio.url, {
          filename: `${audioFilename}.mp3`,
          contentType: 'audio/mpeg',
          accept: 'audio/*,*/*',
        });
      }
      return json(
        { success: false, error: 'Audio extraction is not available for this X/Twitter link. Please try downloading the video instead and convert it locally.' },
        501
      );
    }

    const cached = await cacheHit('x', 'x', parsed.tweetId, 'video');
    const cachedData = cached?.data as Record<string, unknown> | undefined;

    let videoUrl: string | null = null;

    if (cachedData) {
      if (mode === 'hd') {
        videoUrl = (cachedData.hdUrl as string) || (cachedData.sdUrl as string) || null;
      } else {
        videoUrl = (cachedData.sdUrl as string) || (cachedData.hdUrl as string) || null;
      }
    }

    if (!videoUrl) {
      const meta = await fetchTweetMeta(parsed.sanitizedUrl, parsed.tweetId);
      const variant = mode === 'hd' ? pickBestVariant(meta.variants, true) : pickBestVariant(meta.variants, false);
      videoUrl = variant?.url || pickBestVariant(meta.variants, true)?.url || null;

      if (videoUrl) {
        await cacheWrite('x', 'x', parsed.tweetId, 'video', {
          args: { type: 'video' },
          mediaUrl: videoUrl,
          thumb: meta.thumbnail,
          title: meta.text.slice(0, 200),
          data: {
            tweetId: meta.tweetId,
            username: meta.username,
            authorName: meta.authorName,
            text: meta.text,
            thumbnail: meta.thumbnail,
            hdUrl: pickBestVariant(meta.variants, true)?.url || null,
            sdUrl: pickBestVariant(meta.variants, false)?.url || null,
          },
        });
      }
    }

    if (!videoUrl) {
      return json({ success: false, error: 'No downloadable video found.' }, 404);
    }

    const filename = `tiksavehub-x-video-${parsed.tweetId}.mp4`;

    return streamFromUpstream(videoUrl, {
      filename,
      contentType: 'video/mp4',
      accept: 'video/mp4,video/*,*/*',
      referer: X_REFERER,
    });
  } catch (err: any) {
    console.error(`[X API] ${new Date().toISOString()} GET error: ${err?.message ?? err}`);
    return json({ success: false, error: userMessageFor(err), errorType: 'api_error' }, 500);
  }
};
