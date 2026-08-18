import type { APIRoute } from 'astro';
import { parseFacebookUrl } from '../../lib/facebook-url';
import {
  fetchFacebookMedia,
  fetchFacebookAudio,
  fetchFacebookPhoto,
  fetchFacebookPhotoSet,
  fetchFacebookPhotosAsFiles,
  fetchFacebookStory,
  FB_ERR,
} from '../../lib/facebook';
import { buildZip } from '../../lib/zip';
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
  return parsed.videoId || parsed.shortCode || parsed.photoId || '';
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

function photoMessageFor(err: any): string {
  const code = err?.code ?? '';
  if (code === FB_ERR.NOT_AVAILABLE) {
    return 'This photo is private or was deleted. Please try another public Facebook photo link.';
  }
  if (code === FB_ERR.NO_MEDIA) {
    return 'Could not load this Facebook photo. Check the link or try another public photo.';
  }
  return userMessageFor(err);
}

function storyMessageFor(err: any): string {
  const code = err?.code ?? '';
  if (code === FB_ERR.NO_MEDIA) {
    return 'This story could not be downloaded. Facebook stories expire after 24 hours or may be private — please copy a fresh story link and try again.';
  }
  if (code === FB_ERR.NOT_AVAILABLE) {
    return 'This story is private or has expired. Facebook stories disappear after 24 hours — try a fresh public story link.';
  }
  return userMessageFor(err);
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

  const id = cacheKeyOf(parsed);
  const toolMode = typeof body?.mode === 'string' ? body.mode : '';

  // Story mode accepts ONLY story links.
  if (toolMode === 'story') {
    if (parsed.linkType !== 'story') {
      return json(
        { success: false, error: 'That link is not a Facebook story. Please paste a story link — e.g. facebook.com/stories/… — the Story Downloader only downloads stories.' },
        422
      );
    }
  } else if (parsed.linkType === 'story') {
    return json(
      { success: false, error: 'That link is a Facebook story, not a video. Use the Facebook Story Downloader tool.' },
      422
    );
  }

  // Photo links route to the photo extractor.
  if (parsed.linkType === 'photo') {
    if (toolMode && toolMode !== 'photo') {
      return json(
        { success: false, error: 'That link is a Facebook photo, not a video. Use the Facebook Photo Downloader tool.' },
        422
      );
    }
    try {
      const cached = id ? cacheHit('facebook', 'fb', id, 'photo') : null;
      const cachedData = cached?.data as Record<string, unknown> | undefined;
      if (cachedData && Array.isArray(cachedData.photos) && (cachedData.photos as any[]).length) {
        return json({ success: true, type: 'facebook-photo', photo: cachedData, fromCache: true }, 200, true);
      }

      const set = await fetchFacebookPhotoSet(parsed.sanitizedUrl);

      const payload = {
        photoUrl: set.photos[0]?.photoUrl || '',
        cover: set.photos[0]?.cover || set.cover || '',
        title: set.title || 'Facebook Photo',
        photos: set.photos.map((p) => ({
          photoUrl: p.photoUrl,
          altUrl: p.altUrl,
          cover: p.cover || p.photoUrl,
          title: p.title || set.title,
        })),
        photoCount: set.photos.length,
        author: {
          unique_id: set.author?.name || '',
          nickname: set.author?.name || '',
          avatar: set.author?.avatar || set.cover || '',
        },
      };

      if (id) {
        cacheWrite('facebook', 'fb', id, 'photo', {
          args: { type: 'photo' },
          mediaUrl: payload.photoUrl,
          thumb: payload.cover,
          title: payload.title,
          data: payload,
        });
      }

      return json({ success: true, type: 'facebook-photo', photo: payload }, 200, true);
    } catch (err: any) {
      console.error('[Facebook API] Photo error:', err?.message ?? err);
      return json({ success: false, error: photoMessageFor(err) }, 500);
    }
  }

  if (toolMode === 'photo') {
    return json(
      { success: false, error: 'That link is a Facebook video, not a photo. Please paste a photo link (photo.php?fbid=…, facebook.com/{profile}/photos/… or facebook.com/share/p/…).' },
      422
    );
  }

  if (!parsed.isVideo) {
    return json(
      { success: false, error: 'This tool only downloads Facebook videos and Reels, not photos.' },
      422
    );
  }

  const isStory = parsed.linkType === 'story';

  try {
    const cached = isStory ? null : id ? cacheHit('facebook', 'fb', id, 'video') : null;
    const cachedData = cached?.data as Record<string, unknown> | undefined;
    if (cachedData) {
      return json({ success: true, type: 'facebook', video: cachedData, fromCache: true }, 200, true);
    }

    const media = isStory ? await fetchFacebookStory(parsed.sanitizedUrl) : await fetchFacebookMedia(parsed.sanitizedUrl);

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

    if (id && !isStory) {
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
    return json({ success: false, error: isStory ? storyMessageFor(err) : userMessageFor(err) }, 500);
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
  if (!parsed.isValid) {
    return json(
      { success: false, error: 'Invalid URL. Please provide a valid public Facebook link.' },
      422
    );
  }

  const id = cacheKeyOf(parsed);
  const isStory = parsed.linkType === 'story';

  // Photo download mode.
  if (parsed.linkType === 'photo') {
    try {
      const cached = id ? cacheHit('facebook', 'fb', id, 'photo') : null;
      const cachedData = cached?.data as Record<string, unknown> | undefined;

      // Bundle mode: download every photo of the post into one ZIP.
      if (mode === 'zip') {
        let photoUrls: Array<{ url: string; alt?: string }> = [];
        if (Array.isArray(cachedData?.photos)) {
          for (const p of cachedData.photos as Array<{ photoUrl?: string; cover?: string; altUrl?: string }>) {
            const url = p?.photoUrl || p?.cover;
            if (!url) continue;
            const entry: { url: string; alt?: string } = { url };
            if (typeof p?.altUrl === 'string') entry.alt = p.altUrl;
            photoUrls.push(entry);
          }
        }
        if (photoUrls.length < 2) {
          const set = await fetchFacebookPhotoSet(parsed.sanitizedUrl);
          photoUrls = [];
          for (const p of set.photos) {
            const entry: { url: string; alt?: string } = { url: p.photoUrl };
            if (p.altUrl) entry.alt = p.altUrl;
            photoUrls.push(entry);
          }
          const payload = {
            photoUrl: set.photos[0]?.photoUrl || '',
            cover: set.photos[0]?.cover || set.cover || '',
            title: set.title || 'Facebook Photo',
            photos: set.photos.map((p) => ({
              photoUrl: p.photoUrl,
              altUrl: p.altUrl,
              cover: p.cover || p.photoUrl,
              title: p.title || set.title,
            })),
            photoCount: set.photos.length,
            author: {
              unique_id: set.author?.name || '',
              nickname: set.author?.name || '',
              avatar: set.author?.avatar || set.cover || '',
            },
          };
          if (id) {
            cacheWrite('facebook', 'fb', id, 'photo', {
              args: { type: 'photo' },
              mediaUrl: payload.photoUrl,
              thumb: payload.cover,
              title: payload.title,
              data: payload,
            });
          }
        }

        if (!photoUrls.length) {
          return json({ success: false, error: 'Could not load this Facebook photo.' }, 500);
        }

        const files = await fetchFacebookPhotosAsFiles(photoUrls);
        if (!files.length) {
          return json(
            { success: false, error: 'The photos could not be downloaded right now. Please try again later.' },
            500
          );
        }

        const zip = buildZip(files);
        return new Response(zip, {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="tiksavehub-facebook-photos.zip"',
            'Content-Length': String(zip.byteLength),
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
          },
        });
      }

      const photoUrl: string | null = (cachedData?.photoUrl as string) || null;
      const altUrl: string | null = (cachedData?.photos as any[])?.[0]?.altUrl || null;

      const streamPhoto = async (primary: string, alt: string | null) => {
        const opts = {
          filename: 'tiksavehub-facebook-photo.jpg',
          contentType: 'image/jpeg',
          accept: 'image/jpeg,image/png,image/webp,image/*,*/*',
          referer: FACEBOOK_REFERER,
        };
        try {
          return await streamFromUpstream(primary, opts);
        } catch (err) {
          // Promoted rendition may be signed/locked → fall back to the raw original.
          if (alt && alt !== primary) {
            return streamFromUpstream(alt, opts);
          }
          throw err;
        }
      };

      if (!photoUrl) {
        const photo = await fetchFacebookPhoto(parsed.sanitizedUrl);
        return streamPhoto(photo.photoUrl, photo.altUrl || null);
      }

      return streamPhoto(photoUrl, altUrl);
    } catch (err: any) {
      console.error('[Facebook API] Photo error:', err?.message ?? err);
      return json({ success: false, error: photoMessageFor(err) }, 500);
    }
  }

  if (!parsed.isVideo) {
    return json(
      { success: false, error: 'Invalid URL. Please provide a valid public Facebook video link.' },
      422
    );
  }

  try {
    const cached = isStory ? null : id ? cacheHit('facebook', 'fb', id, 'video') : null;
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
        if (id && !isStory) {
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