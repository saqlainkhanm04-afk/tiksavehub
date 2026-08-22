import type { APIRoute } from 'astro';
import { streamFromUpstream } from '../../lib/stream';
import {
  parseInstagramUrl,
  fetchMediaByShortcode,
  fetchStoryByMediaId,
  fetchAllStoriesForUser,
  getBestVideoUrl,
  getThumbnailUrl,
  getAudioUrl,
  isImageOnlyMedia,
  ERR_SESSION_REQUIRED,
  ERR_SESSION_MISSING,
  ERR_LOGIN_REQUIRED,
  ERR_STORY_EXPIRED,
  ERR_HIGHLIGHTS_UNSUPPORTED,
} from '../../lib/instagram';
import { cacheHit, cacheWrite } from '../../lib/media-cache';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { fetchInstagramAudioWithYtDlp, instagramUrlFor } from '../../lib/ytdlp';

export const prerender = false;

function contentId(parsed: ReturnType<typeof parseInstagramUrl>): string | null {
  if (!parsed) return null;
  if (parsed.shortcode) return parsed.shortcode;
  if (parsed.mediaId) return `story:${parsed.mediaId}`;
  if (parsed.type === 'story' && parsed.username) return `stories:${parsed.username.toLowerCase()}`;
  return null;
}

export const GET: APIRoute = async ({ url, request }) => {
  const videoUrl = url.searchParams.get('url');
  const dl = url.searchParams.get('dl');
  const typeParam = url.searchParams.get('type');
  const streamUrl = url.searchParams.get('stream');

  // Fast path: stream directly from a pre-resolved CDN URL (used by multi-story downloads).
  if (dl && streamUrl) {
    const isPhoto = streamUrl.includes('.jpg') || streamUrl.includes('image');
    return streamFromUpstream(streamUrl, {
      filename: isPhoto ? 'tiksavehub-story.jpg' : 'tiksavehub-story.mp4',
      contentType: isPhoto ? 'image/jpeg' : 'video/mp4',
      accept: isPhoto
        ? 'image/jpeg,image/webp,image/*,*/*'
        : 'video/mp4,video/*,*/*',
      referer: 'https://www.instagram.com/',
    });
  }

  if (!videoUrl) {
    return new Response(
      JSON.stringify({ success: false, error: 'Missing "url" query parameter.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const parsed = parseInstagramUrl(videoUrl);
  if (!parsed) {
    return new Response(
      JSON.stringify({ success: false, error: 'Invalid URL. Please provide a valid Instagram post/reel/story link.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (typeParam) {
    // video and reels tools accept both link kinds (reels are posts);
    // audio accepts video/reels; story stays strict.
    const allowedTypes =
      typeParam === 'story' ? ['story'] : ['video', 'reels'];
    if (!allowedTypes.includes(parsed.type)) {
      const typeLabels: Record<string, string> = {
        video: 'video post or Reels (instagram.com/p/… or /reel/…)',
        reels: 'Reels or video post (instagram.com/reel/… or /p/…)',
        story: 'story (instagram.com/stories/…)',
        audio: 'video or Reels',
      };
      const expected = typeLabels[typeParam] || 'Instagram content';
      return new Response(
        JSON.stringify({ success: false, error: `This tool only accepts a ${expected} link.` }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  if (isRateLimited(clientIpFrom(request))) {
    return new Response(
      JSON.stringify({ success: false, error: 'Too many requests. Please try again in a minute.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const id = contentId(parsed);
  const mode = typeParam === 'audio' || dl === 'audio' ? 'audio' : 'video';

  try {
    if (id) {
      const cached = cacheHit('instagram', 'ig', id, mode);
      const cachedData = cached?.data as Record<string, unknown> | undefined;
      // Audio entries are only reusable once they carry the audio_format marker
      // (older cache rows stored the video stream under audio mode by mistake).
      const cacheUsable =
        cachedData &&
        (mode !== 'audio' || typeof cachedData.audio_format === 'string');
      if (cacheUsable) {
        const video = cachedData!;
        if (dl) {
          const streamUrl = (video.play as string) || (video.hdplay as string) || cached!.mediaUrl!;
          if (!streamUrl) {
            return new Response(
              JSON.stringify({ success: false, error: 'No media URL available.' }),
              { status: 422, headers: { 'Content-Type': 'application/json' } }
            );
          }
          const audioExt = (video.audio_format as string) || null;
          const isAudio = mode === 'audio' && Boolean(audioExt);
          const isImage = !isAudio && (video.isPhoto as boolean) === true;
          return streamFromUpstream(streamUrl, {
            filename: isAudio ? `tiksavehub-audio.${audioExt}` : isImage ? 'tiksavehub-story.jpg' : 'tiksavehub-video.mp4',
            contentType: isAudio ? 'audio/mp4' : isImage ? 'image/jpeg' : 'video/mp4',
            accept: isAudio
              ? 'audio/mp4,audio/mpeg,audio/*,*/*'
              : isImage
                ? 'image/jpeg,image/webp,image/*,*/*'
                : 'video/mp4,video/*,*/*',
            referer: 'https://www.instagram.com/',
          });
        }

        return new Response(
          JSON.stringify({ success: true, type: parsed.type, video, fromCache: true }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
            },
          }
        );
      }
    }

    let media: any;
    let contentType = 'video';

    // When fetching story metadata (no dl param), return ALL active stories for the user.
    // When downloading (dl param present), fetch the specific story for streaming.
    if (parsed.type === 'story' && !dl && parsed.username) {
      const allStories = await fetchAllStoriesForUser(parsed.username);
      const stories = allStories.map((item: any) => {
        const isPhoto = isImageOnlyMedia(item);
        const coverUrl = getThumbnailUrl(item);
        const downloadUrl = isPhoto ? coverUrl : getBestVideoUrl(item);
        return {
          mediaId: String(item.media_id || item.pk || item.id),
          cover: coverUrl,
          duration: item.video_duration || 0,
          title: `Instagram story by ${item.user?.username || 'unknown'}`,
          isPhoto,
          downloadUrl,
          author: {
            unique_id: item.user?.username || '',
            nickname: item.user?.full_name || '',
            avatar: item.user?.profile_pic_url || '',
          },
        };
      }).filter((s: any) => s.downloadUrl);

      return new Response(
        JSON.stringify({ success: true, type: 'story', stories, storyCount: stories.length }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
          },
        }
      );
    }

    if (parsed.type === 'story' && parsed.mediaId) {
      media = await fetchStoryByMediaId(parsed.mediaId, parsed.username);
    } else if (parsed.shortcode) {
      media = await fetchMediaByShortcode(parsed.shortcode, parsed.type);
    } else {
      return new Response(
        JSON.stringify({ success: false, error: 'Could not extract content ID from the URL.' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const cover = getThumbnailUrl(media);
    const duration = media.video_duration || 0;
    const title = `Instagram ${parsed.type} by ${media.user?.username || 'unknown'}`;

    let downloadUrl: string | null = null;
    let audioExt: string | null = null;

    // Story items can be photos (media_type 1) — serve them as images with the
    // right container instead of failing with "no video media".
    const imageOnlyStory = parsed.type === 'story' && isImageOnlyMedia(media);

    if (mode === 'audio') {
      contentType = 'audio';
      const realAudio = getAudioUrl(media);
      if (realAudio) {
        downloadUrl = realAudio;
        audioExt = /\.mp3(?:\?|$)/i.test(realAudio) ? 'mp3' : 'm4a';
      } else if (parsed.shortcode) {
        const audio = await fetchInstagramAudioWithYtDlp(
          instagramUrlFor(parsed.shortcode, parsed.type)
        );
        if (audio?.url) {
          downloadUrl = audio.url;
          audioExt = audio.ext && audio.ext !== 'unknown' ? audio.ext : 'm4a';
        }
      }

      if (!downloadUrl) {
        // No real audio track detectable — fall back to the video source,
        // but keep the honest video container (never a mislabeled audio file).
        contentType = 'video';
        downloadUrl = getBestVideoUrl(media);
      }
    } else if (imageOnlyStory) {
      contentType = 'image';
      downloadUrl = getThumbnailUrl(media) || null;
    } else {
      downloadUrl = getBestVideoUrl(media);
    }

    if (!downloadUrl) {
      return new Response(
        JSON.stringify({ success: false, error: 'This content does not contain any downloadable media.' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const video = {
      play: downloadUrl,
      hdplay: downloadUrl,
      cover,
      duration,
      title,
      isPhoto: imageOnlyStory || undefined,
      author: {
        unique_id: media.user?.username || '',
        nickname: media.user?.full_name || '',
        avatar: media.user?.profile_pic_url || '',
      },
      digg_count: media.like_count ?? 0,
      comment_count: media.comment_count ?? 0,
      share_count: 0,
      play_count: media.view_count ?? 0,
      ...(contentType === 'audio' ? { audio_format: audioExt || 'm4a' } : {}),
    };

    if (id) {
      cacheWrite('instagram', 'ig', id, mode, {
        args: { type: parsed.type },
        mediaUrl: downloadUrl,
        thumb: cover,
        title,
        data: video,
      });
    }

    if (dl) {
      const isAudio = contentType === 'audio';
      const isImage = contentType === 'image';
      const fileExt = isAudio ? audioExt || 'm4a' : isImage ? 'jpg' : 'mp4';
      return streamFromUpstream(downloadUrl, {
        filename: isAudio
          ? `tiksavehub-audio.${fileExt}`
          : isImage
            ? 'tiksavehub-story.jpg'
            : 'tiksavehub-video.mp4',
        contentType: isAudio ? 'audio/mp4' : isImage ? 'image/jpeg' : 'video/mp4',
        accept: isAudio
          ? 'audio/mp4,audio/mpeg,audio/*,*/*'
          : isImage
            ? 'image/jpeg,image/webp,image/*,*/*'
            : 'video/mp4,video/*,*/*',
        referer: 'https://www.instagram.com/',
      });
    }

    return new Response(
      JSON.stringify({ success: true, type: parsed.type, video }),
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
    console.error('[Instagram Download API] Error:', msg);

    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';

    const isYtDlpMissing = msg.includes('yt-dlp is not installed') || msg.includes('yt-dlp is disabled');
    const isYtDlpMediaErr = msg.startsWith('ERROR:') && !isYtDlpMissing;

    const isFetchFailed =
      msg.includes('fetch failed') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ECONNRESET') ||
      msg.includes('EHOSTUNREACH') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('UND_ERR') ||
      msg.includes('returned 429') ||
      msg.includes('returned 403');
    const noMedia =
      msg.includes('No media found') ||
      msg.includes('No items') ||
      msg.includes('returned no media') ||
      msg.includes('No downloadable media') ||
      msg.includes('yt-dlp returned no');

    let errorMsg: string;

    if (msg === ERR_STORY_EXPIRED) {
      errorMsg =
        'This story has already expired — Instagram stories disappear 24 hours after they are posted.';
    } else if (msg === ERR_HIGHLIGHTS_UNSUPPORTED) {
      errorMsg =
        'This looks like an Instagram Highlight link. Highlight downloads are not supported — please paste a regular story link instead.';
    } else if (msg === ERR_SESSION_REQUIRED) {
      errorMsg =
        'Instagram stories are protected content that can only be fetched by the server right now. Please try again shortly, or use a public Reels/post link instead.';
      console.error(
        '[Instagram Download API] Story fetch skipped: no Instagram session on this server. ' +
          'Instagram blocks anonymous story access (verified 2026), so story downloads require ' +
          'IG_COOKIES (full cookie jar from DevTools -> Copy as cURL) — or at minimum ' +
          'IG_SESSIONID + IG_DS_USER_ID + IG_CSRF_TOKEN — in the server env (see .env.example).'
      );
    } else if (msg === ERR_LOGIN_REQUIRED || msg === ERR_SESSION_MISSING) {
      errorMsg =
        'This content could not be fetched right now. Please try again in a few minutes, or use another public link.';
      console.error(
        '[Instagram Download API] Instagram rejected the server session (login/challenge). ' +
          'Refresh the IG_COOKIES jar (or IG_SESSIONID/IG_CSRF_TOKEN) — the story retried once with a fresh session already.'
      );
    } else if (isTimeout) {
      errorMsg = 'The server took too long to respond. Please try again in a moment.';
    } else if (isYtDlpMissing) {
      errorMsg = 'This content could not be fetched right now. Please try again later.';
    } else if (isYtDlpMediaErr || noMedia) {
      errorMsg = 'This content may be unavailable or restricted. Please try another public link.';
    } else if (isFetchFailed) {
      errorMsg = 'This content could not be fetched right now. Please try again later.';
    } else {
      errorMsg = 'Failed to fetch this content. Please check the link and try again.';
    }

    return new Response(
      JSON.stringify({ success: false, error: errorMsg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};