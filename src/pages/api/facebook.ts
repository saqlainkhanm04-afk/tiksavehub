import type { APIRoute } from 'astro';
import { parseFacebookUrl } from '../../lib/facebook-url';
import { fetchFacebookMedia, fetchFacebookAudio, FB_ERR } from '../../lib/facebook';
import { streamFromUpstream } from '../../lib/stream';
import { cacheHit, cacheWrite } from '../../lib/media-cache';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { isFfmpegAvailable, reencodeMp3 } from '../../lib/audio';

export const prerender = false;

const FACEBOOK_REFERER = 'https://www.facebook.com/';

function json(body: unknown, status: number, cacheable = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(cacheable
        ? {
            'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
          }
        : { 'Cache-Control': 'no-store' }),
    },
  });
}

function cacheKeyOf(parsed: ReturnType<typeof parseFacebookUrl>): string {
  return parsed.videoId || parsed.shortCode || '';
}

function pickUrl(media: any, mode: string): string | null {
  if (mode === 'hd') return media.hdUrl || media.sdUrl || media.play || null;
  return media.sdUrl || media.hdUrl || media.play || null;
}

function userMessageFor(err: any, needsLoginHint = false): string {
  const msg = err?.message ?? String(err);
  const code = err?.code ?? '';

  if (code === FB_ERR.NOT_AVAILABLE) {
    return 'This video is private or was deleted. Please try another public Facebook video link.';
  }
  if (code === FB_ERR.LOGIN_REQUIRED || needsLoginHint) {
    return 'This video requires a Facebook login to view. Please try another public Facebook video link.';
  }
  if (code === FB_ERR.NO_MEDIA) {
    return 'This video does not contain any downloadable media. Please try another link.';
  }
  if (code === FB_ERR.TIMEOUT || err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return 'The server took too long to respond. Please try again in a moment.';
  }

  const isFetchFailed =
    msg.includes('fetch failed') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('EHOSTUNREACH') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('UND_ERR') ||
    msg.includes('returned 429') ||
    msg.includes('returned 403') ||
    msg.includes('returned 5');

  if (isFetchFailed) {
    return 'This video could not be fetched right now. Please try again later.';
  }
  if (msg.includes('yt-dlp is not installed') || msg.includes('yt-dlp is disabled')) {
    return 'This video could not be fetched right now. Please try again later.';
  }
  if (msg.startsWith('ERROR:')) {
    return 'This video may be unavailable or restricted. Please try another public Facebook link.';
  }

  return 'Failed to fetch this video. Please check the link and try again.';
}

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid request body. Send a JSON object with a "url" field.' }, 400);
  }

  const rawUrl = typeof body?.url === 'string' ? body.url : '';
  if (!rawUrl.trim()) {
    return json({ success: false, error: 'Missing "url" in the request body.' }, 400);
  }

  if (isRateLimited(clientIpFrom(request))) {
    return json({ success: false, error: 'Too many requests. Please try again in a minute.' }, 429);
  }

  const parsed = parseFacebookUrl(rawUrl);
  if (!parsed.isValid) {
    return json({ success: false, error: parsed.error || 'Invalid Facebook URL.' }, 422);
  }
  if (!parsed.isVideo) {
    return json(
      { success: false, error: 'This tool only downloads Facebook videos and Reels, not photos.' },
      422
    );
  }

  const id = cacheKeyOf(parsed);

  try {
    const cached = id ? cacheHit('facebook', 'fb', id, 'video') : null;
    const cachedData = cached?.data as Record<string, unknown> | undefined;
    if (cachedData) {
      return json({ success: true, type: 'facebook', video: cachedData, fromCache: true }, 200, true);
    }

    const media = await fetchFacebookMedia(parsed.sanitizedUrl);

    const hdUrl = media.hdUrl || media.sdUrl;
    if (!hdUrl) {
      return json({ success: false, error: 'This video does not contain any downloadable media.' }, 422);
    }

    const video = {
      play: hdUrl,
      hdplay: hdUrl,
      sdplay: media.sdUrl || media.hdUrl,
      cover: media.cover,
      duration: media.duration || 0,
      title: media.title || 'Facebook Video',
      author: {
        unique_id: media.author?.name || '',
        nickname: media.author?.name || '',
        avatar: media.author?.avatar || '',
      },
      like_count: media.like_count ?? 0,
      comment_count: media.comment_count ?? 0,
      share_count: media.share_count ?? 0,
      play_count: media.view_count ?? 0,
    };

    if (id) {
      cacheWrite('facebook', 'fb', id, 'video', {
        args: { type: parsed.linkType || 'watch' },
        mediaUrl: hdUrl,
        thumb: media.cover,
        title: media.title,
        data: video,
      });
    }

    return json({ success: true, type: 'facebook', video }, 200, true);
  } catch (err: any) {
    console.error('[Facebook API] Error:', err?.message ?? err);
    return json({ success: false, error: userMessageFor(err) }, 500);
  }
};

export const GET: APIRoute = async ({ url, request }) => {
  const rawUrl = url.searchParams.get('url') || '';
  const mode = url.searchParams.get('dl') || url.searchParams.get('mode') || '';

  if (!rawUrl) {
    return json({ success: false, error: 'Missing "url" query parameter.' }, 400);
  }

  if (isRateLimited(clientIpFrom(request))) {
    return json({ success: false, error: 'Too many requests. Please try again in a minute.' }, 429);
  }

  const parsed = parseFacebookUrl(rawUrl);
  if (!parsed.isValid || !parsed.isVideo) {
    return json(
      { success: false, error: 'Invalid URL. Please provide a valid public Facebook video link.' },
      422
    );
  }

  const id = cacheKeyOf(parsed);

  try {
    const cached = id ? cacheHit('facebook', 'fb', id, 'video') : null;
    const cachedData = cached?.data as Record<string, unknown> | undefined;
    const media = cachedData || null;

    let mediaUrl: string | null = null;
    let isAudio = false;
    let audioExt: string | null = null;

    if (mode === 'audio') {
      const audio = await fetchFacebookAudio(parsed.sanitizedUrl);
      if (audio?.url) {
        isAudio = true;
        audioExt = audio.ext || 'm4a';
        mediaUrl = audio.url;
      }
    }

    if (!mediaUrl) {
      if (media) {
        mediaUrl = pickUrl(media, mode) as string | null;
      } else {
        const fresh = await fetchFacebookMedia(parsed.sanitizedUrl);
        mediaUrl = mode === 'hd' ? fresh.hdUrl || fresh.sdUrl : fresh.sdUrl || fresh.hdUrl;
        const hdUrl = fresh.hdUrl || fresh.sdUrl;
        if (id) {
          cacheWrite('facebook', 'fb', id, 'video', {
            args: { type: parsed.linkType || 'watch' },
            mediaUrl: hdUrl,
            thumb: fresh.cover,
            title: fresh.title,
            data: {
              play: hdUrl,
              hdplay: hdUrl,
              sdplay: fresh.sdUrl || fresh.hdUrl,
              cover: fresh.cover,
              duration: fresh.duration || 0,
              title: fresh.title || 'Facebook Video',
              author: {
                unique_id: fresh.author?.name || '',
                nickname: fresh.author?.name || '',
                avatar: fresh.author?.avatar || '',
              },
            },
          });
        }
      }
    }

    if (!mediaUrl) {
      return json({ success: false, error: 'No media URL available for this video.' }, 422);
    }

    // MP3: re-encode the native audio with ffmpeg when available; otherwise
    // stream the original audio file with its real container extension.
    if (isAudio) {
      if (await isFfmpegAvailable()) {
        return reencodeMp3(mediaUrl, {
          bitrateKbps: 128,
          filename: 'tiksavehub-facebook-audio.mp3',
        });
      }
      return streamFromUpstream(mediaUrl, {
        filename: `tiksavehub-facebook-audio.${audioExt || 'm4a'}`,
        contentType: 'audio/mp4',
        accept: 'audio/mp4,audio/mpeg,audio/*,*/*',
        referer: FACEBOOK_REFERER,
      });
    }

    return streamFromUpstream(mediaUrl, {
      filename: 'tiksavehub-facebook-video.mp4',
      contentType: 'video/mp4',
      accept: 'video/mp4,video/*,*/*',
      referer: FACEBOOK_REFERER,
    });
  } catch (err: any) {
    console.error('[Facebook API] Error:', err?.message ?? err);
    return json({ success: false, error: userMessageFor(err) }, 500);
  }
};