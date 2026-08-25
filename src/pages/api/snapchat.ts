import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import { parseSnapchatUrl } from '../../lib/snapchat-url';
import { fetchSnapchatMedia, removeSnapchatWatermark } from '../../lib/snapchat';
import { streamFromUpstream } from '../../lib/stream';
import { cacheHit, cacheWrite } from '../../lib/media-cache';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { isFfmpegAvailable, reencodeMp3 } from '../../lib/audio';

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

export const POST: APIRoute = async ({ request }) => {
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

  const parsed = parseSnapchatUrl(rawUrl);
  if (!parsed.isValid) {
    return json({ success: false, error: parsed.error || 'Invalid Snapchat URL.' }, 422);
  }
  if (parsed.linkType === 'profile') {
    return json({ success: false, error: 'Profile links cannot be downloaded. Please use a Spotlight, Story, or Post link.' }, 422);
  }

  const mediaId = parsed.mediaId || parsed.username || 'unknown';

  const cached = cacheHit('snapchat', 'snapchat', mediaId, 'video');
  const cachedData = cached?.data as Record<string, unknown> | undefined;
  if (cachedData && cachedData.videoUrl) {
    return json({ success: true, type: 'snapchat-video', video: cachedData, fromCache: true }, 200, true);
  }

  try {
    const snapUrl = parsed.sanitizedUrl;
    const meta = await fetchSnapchatMedia(snapUrl, mediaId);

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

/**
 * Use yt-dlp to download audio from Snapchat and pipe the result.
 */
function streamYtDlpAudio(snapUrl: string, filename: string): Promise<Response> {
  const bin = process.env.YTDLP_PATH || 'yt-dlp';
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-color',
    '--no-check-certificates',
    '-f', 'bestaudio',
    '-o', '-',
    snapUrl,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('yt-dlp audio download timed out'));
    }, 120_000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp not available: ${err.message}`));
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        const detail = stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
        reject(new Error(`yt-dlp audio failed (exit ${code}): ${detail}`));
      }
    });

    const headers = new Headers();
    headers.set('Content-Type', 'audio/mp4');
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Accel-Buffering', 'no');

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try { c.close(); } catch {}
        };
        const fail = (msg: string) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try { child.kill(); } catch {}
          try { c.error(new Error(msg)); } catch {}
        };

        child.stdout.on('data', (chunk: Uint8Array) => {
          try { c.enqueue(chunk); } catch {}
        });
        child.stdout.on('end', () => {
          if (child.exitCode !== null && child.exitCode !== 0) {
            fail(`yt-dlp audio extraction failed (exit ${child.exitCode})`);
          } else {
            finish();
          }
        });
        child.stdout.on('error', () => fail('stdout error during audio download'));
        child.on('exit', (code) => {
          if (!finished && code !== 0) fail(`yt-dlp exited with code ${code}`);
          else if (!finished) finish();
        });
      },
      cancel() {
        clearTimeout(timer);
        try { child.kill(); } catch {}
      },
    });

    resolve(new Response(body, { status: 200, headers }));
  });
}

export const GET: APIRoute = async ({ url, request }) => {
  const rawUrl = url.searchParams.get('url') || '';
  const mode = url.searchParams.get('dl') || 'hd';

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
    const cached = cacheHit('snapchat', 'snapchat', mediaId, 'video');
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
      const meta = await fetchSnapchatMedia(parsed.sanitizedUrl, mediaId);
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

      const ffmpegOk = await isFfmpegAvailable();
      if (ffmpegOk) {
        try {
          return reencodeMp3(videoUrl, {
            bitrateKbps: 128,
            filename: `${audioFilename}.mp3`,
          });
        } catch {
          // Fall through to pipe approach
        }
      }

      try {
        return await streamYtDlpAudio(parsed.sanitizedUrl, `${audioFilename}.m4a`);
      } catch {
        // Fall through to video
      }

      return streamFromUpstream(videoUrl, {
        filename,
        contentType: 'video/mp4',
        accept: 'video/mp4,video/*,*/*',
        referer: SC_REFERER,
      });
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
