import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import { parseXUrl } from '../../lib/x-url';
import { fetchTweetMeta, pickBestVariant } from '../../lib/x';
import { streamFromUpstream } from '../../lib/stream';
import { cacheHit, cacheWrite } from '../../lib/media-cache';
import { isRateLimited, clientIpFrom } from '../../lib/rate-limit';
import { isFfmpegAvailable, reencodeMp3 } from '../../lib/audio';

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

  const parsed = parseXUrl(rawUrl);
  if (!parsed.isValid) {
    return json({ success: false, error: parsed.error || 'Invalid X/Twitter URL.' }, 422);
  }
  if (!parsed.tweetId) {
    return json({ success: false, error: 'Could not find a tweet ID in this URL.' }, 422);
  }

  const cached = cacheHit('x', 'x', parsed.tweetId, 'video');
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
    console.error('[X API] Error:', err?.message ?? err);
    return json({ success: false, error: userMessageFor(err) }, 500);
  }
};

/**
 * Use yt-dlp to download audio (HLS segments merged natively) and pipe
 * the result as a ReadableStream Response.  No ffmpeg required —
 * yt-dlp's m3u8_native protocol handles segment download+concat internally.
 */
function streamYtDlpAudio(tweetUrl: string, filename: string): Promise<Response> {
  const bin = process.env.YTDLP_PATH || 'yt-dlp';
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-color',
    '--no-check-certificates',
    '-f', 'bestaudio',
    '-o', '-',
    tweetUrl,
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

  const parsed = parseXUrl(rawUrl);
  if (!parsed.isValid || !parsed.tweetId) {
    return json({ success: false, error: parsed.error || 'Invalid X/Twitter URL.' }, 422);
  }

  try {
    const cached = cacheHit('x', 'x', parsed.tweetId, 'video');
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
        cacheWrite('x', 'x', parsed.tweetId, 'video', {
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

    if (mode === 'audio') {
      // X/Twitter audio is HLS-only (m3u8_native) — no direct stream URL exists.
      // We MUST use yt-dlp to download+merge segments, then pipe the result.
      // Two paths: (1) yt-dlp -x with ffmpeg → mp3, (2) yt-dlp bestaudio pipe → m4a
      const audioFilename = `tiksavehub-x-audio-${parsed.tweetId}`;

      // Path 1: ffmpeg available → yt-dlp extracts audio to mp3
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

      // Path 2: yt-dlp pipes bestaudio segments merged as m4a (no ffmpeg needed)
      try {
        return await streamYtDlpAudio(parsed.sanitizedUrl, `${audioFilename}.m4a`);
      } catch {
        // Fall through to video
      }

      // Last resort: stream the raw video
      return streamFromUpstream(videoUrl, {
        filename,
        contentType: 'video/mp4',
        accept: 'video/mp4,video/*,*/*',
        referer: X_REFERER,
      });
    }

    return streamFromUpstream(videoUrl, {
      filename,
      contentType: 'video/mp4',
      accept: 'video/mp4,video/*,*/*',
      referer: X_REFERER,
    });
  } catch (err: any) {
    console.error('[X API] Download error:', err?.message ?? err);
    return json({ success: false, error: userMessageFor(err) }, 500);
  }
};
