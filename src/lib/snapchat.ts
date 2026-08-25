import { memoSWR } from './cache';
import { spawn } from 'node:child_process';
import { isFfmpegAvailable } from './audio';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlink, stat, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';
const DELOGO_TIMEOUT_MS = 60_000;

// Snapchat CDN requires Referer + User-Agent or it silently hangs / 403s.
const SC_CDN_HEADERS = `Referer: https://www.snapchat.com/\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36\r\n`;

const FETCH_TIMEOUT_MS = 15_000;
const META_TTL_MS = 6 * 60 * 60 * 1000;
const META_STALE_MS = 6 * 60 * 60 * 1000;

export interface SnapchatMediaMeta {
  mediaId: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  videoUrl: string | null;
  videoHd: string | null;
  videoSd: string | null;
  isStory: boolean;
}

function abortFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchFromYtDlp(snapUrl: string): Promise<SnapchatMediaMeta | null> {
  try {
    const { isYtDlpAvailable } = await import('./ytdlp');
    if (!(await isYtDlpAvailable())) return null;

    const { execFile } = await import('node:child_process');
    const bin = process.env.YTDLP_PATH || 'yt-dlp';
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--no-color',
      '--no-check-certificates',
      snapUrl,
    ];

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        args,
        {
          timeout: 40_000,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        },
        (error, stdout, stderr) => {
          if (error) {
            const raw = (stderr || '').toString().trim();
            const detail = raw.split(/\r?\n/).filter(Boolean).pop() || raw || error.message;
            reject(new Error(detail));
            return;
          }
          resolve(stdout.toString());
        }
      );
    });

    const json = JSON.parse(stdout);
    if (!json) return null;

    const videoUrl = json.url || null;
    const formats: any[] = Array.isArray(json.formats) ? json.formats : [];

    // Separate progressive (combined A+V) from DASH (video-only)
    const progressive = formats.filter(
      (f: any) =>
        f.ext === 'mp4' &&
        f.url &&
        f.protocol !== 'm3u8_native' &&
        f.protocol !== 'm3u8' &&
        (f.vcodec || '') !== 'none' &&
        (f.acodec || '') !== 'none'
    );

    // Pick best HD and SD from progressive
    const sorted = [...progressive].sort((a: any, b: any) => {
      const aScore = (a.height || 0) * 1000 + (a.tbr || 0);
      const bScore = (b.height || 0) * 1000 + (b.tbr || 0);
      return bScore - aScore;
    });

    const hdUrl = sorted[0]?.url || videoUrl;
    const sdUrl = sorted.length > 1 ? sorted[sorted.length - 1]?.url : hdUrl;

    return {
      mediaId: json.id || '',
      title: json.title || json.description || 'Snapchat Video',
      thumbnail: json.thumbnail || json.thumbnails?.[0]?.url || null,
      duration: json.duration ?? null,
      videoUrl,
      videoHd: hdUrl,
      videoSd: sdUrl || hdUrl,
      isStory: snapUrl.includes('story.snapchat.com'),
    };
  } catch {
    return null;
  }
}

async function fetchFromPageData(snapUrl: string): Promise<SnapchatMediaMeta | null> {
  try {
    const resp = await abortFetch(
      snapUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      FETCH_TIMEOUT_MS
    );
    // Snapchat sometimes returns 404 for valid spotlight pages but still
    // embeds __NEXT_DATA__ with the video feed — don't bail on status alone.
    const html = await resp.text();

    // Extract __NEXT_DATA__ JSON (contains clean CDN URLs without watermark overlay)
    const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nextDataMatch) return null;

    const data = JSON.parse(nextDataMatch[1]);
    const spotlightStories = data?.props?.pageProps?.spotlightFeed?.spotlightStories;
    if (!Array.isArray(spotlightStories) || spotlightStories.length === 0) return null;

    // First story (index 0) is often a placeholder (storyType 0, empty snapList).
    // Find the first story with actual video content in snapList.
    let videoUrl: string | null = null;
    let thumbnail: string | null = null;
    let title = 'Snapchat Video';
    let durationMs: number | null = null;

    for (const entry of spotlightStories) {
      const story = entry?.story;
      const snapList = story?.snapList;
      if (!Array.isArray(snapList) || snapList.length === 0) continue;

      const snap = snapList[0];
      const url = snap?.snapUrls?.mediaUrl || entry?.metadata?.videoMetadata?.contentUrl || null;
      if (!url) continue;

      // Found a story with real content — use it
      videoUrl = url;
      thumbnail =
        story?.thumbnailUrl?.value ||
        snap?.snapUrls?.mediaPreviewUrl?.value ||
        entry?.metadata?.videoMetadata?.thumbnailUrl ||
        null;
      title =
        entry?.metadata?.videoMetadata?.name ||
        story?.storyTitle ||
        'Snapchat Video';
      const rawDur = entry?.metadata?.videoMetadata?.durationMs;
      durationMs = rawDur ? Number(rawDur) || null : null;
      break;
    }

    if (!videoUrl) return null;

    // Get media ID from URL
    const idMatch = snapUrl.match(/\/([A-Za-z0-9_-]{4,80})(?:\/|$)/);
    const mediaId = idMatch ? idMatch[1] : '';

    return {
      mediaId,
      title,
      thumbnail,
      duration: durationMs ? durationMs / 1000 : null,
      videoUrl,
      videoHd: videoUrl,
      videoSd: videoUrl,
      isStory: snapUrl.includes('story.snapchat.com'),
    };
  } catch {
    return null;
  }
}

async function fetchFromPage(snapUrl: string): Promise<SnapchatMediaMeta | null> {
  try {
    const resp = await abortFetch(
      snapUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      FETCH_TIMEOUT_MS
    );
    if (!resp.ok) return null;
    const html = await resp.text();

    // Try to extract video URL from page source
    const videoPatterns = [
      /"videoUrl"\s*:\s*"([^"]+)"/,
      /"video_url"\s*:\s*"([^"]+)"/,
      /property="og:video"\s+content="([^"]+)"/,
      /src="(https?:\/\/[^"]*\.mp4[^"]*)"/,
    ];

    let videoUrl: string | null = null;
    for (const re of videoPatterns) {
      const m = html.match(re);
      if (m) {
        videoUrl = m[1].replace(/\\u003F/g, '?').replace(/\//g, '/');
        break;
      }
    }

    // Extract thumbnail
    const thumbPatterns = [
      /"thumbnailUrl"\s*:\s*"([^"]+)"/,
      /property="og:image"\s+content="([^"]+)"/,
      /"image"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/,
    ];

    let thumbnail: string | null = null;
    for (const re of thumbPatterns) {
      const m = html.match(re);
      if (m) {
        thumbnail = m[1].replace(/\\u003F/g, '?').replace(/\//g, '/');
        break;
      }
    }

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'Snapchat Video';

    if (!videoUrl) return null;

    // Extract media ID from URL
    const idMatch = snapUrl.match(/\/([A-Za-z0-9_-]{4,40})(?:\/|$)/);
    const mediaId = idMatch ? idMatch[1] : '';

    return {
      mediaId,
      title,
      thumbnail,
      duration: null,
      videoUrl,
      videoHd: videoUrl,
      videoSd: videoUrl,
      isStory: snapUrl.includes('story.snapchat.com'),
    };
  } catch {
    return null;
  }
}

export async function fetchSnapchatMedia(snapUrl: string, mediaId: string): Promise<SnapchatMediaMeta> {
  const cacheKey = `sc:media:${mediaId}`;
  return memoSWR<SnapchatMediaMeta>(cacheKey, META_TTL_MS, META_STALE_MS, async () => {
    // Try __NEXT_DATA__ first (clean CDN URL, no watermark overlay)
    const pageDataResult = await fetchFromPageData(snapUrl);
    if (pageDataResult && pageDataResult.videoUrl) return pageDataResult;

    // Fallback: yt-dlp (may have watermark from web player)
    const ytdlpResult = await fetchFromYtDlp(snapUrl);
    if (ytdlpResult && ytdlpResult.videoUrl) return ytdlpResult;

    // Fallback: page scraping (regex-based)
    const pageResult = await fetchFromPage(snapUrl);
    if (pageResult && pageResult.videoUrl) return pageResult;

    throw new Error(
      'Could not extract video from this Snapchat link. The content may be private, deleted, or geo-restricted.'
    );
  });
}

// ─── Watermark removal (ffmpeg delogo) ──────────────────────────────────────

interface VideoDimensions {
  width: number;
  height: number;
}

async function probeVideoDimensions(sourceUrl: string): Promise<VideoDimensions | null> {
  return new Promise((resolve) => {
    const child = spawn(
      FFPROBE_BIN,
      [
        '-v', 'error',
        '-headers', SC_CDN_HEADERS,
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0',
        sourceUrl,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve(null);
    }, 10_000);

    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const parts = out.trim().split(',');
        const w = Number(parts[0]);
        const h = Number(parts[1]);
        if (w > 0 && h > 0) {
          resolve({ width: w, height: h });
          return;
        }
      }
      resolve(null);
    });
  });
}

/**
 * Remove the Snapchat watermark/overlay from the video using ffmpeg's delogo filter.
 * The watermark is typically a small ghost/logo icon in the bottom-right corner.
 *
 * Returns a Response streaming the cleaned MP4, or null if ffmpeg is unavailable.
 */
export async function removeSnapchatWatermark(sourceUrl: string, filename: string): Promise<Response | null> {
  if (!(await isFfmpegAvailable())) return null;

  const dims = await probeVideoDimensions(sourceUrl);

  // Write to temp file first, then stream — piping MP4 through stdout is
  // unreliable on Windows (MP4 muxer needs seeking, pipe:1 is non-seekable).
  const tmpPath = join(tmpdir(), `sc-${randomBytes(8).toString('hex')}.mp4`);

  const ffmpegArgs = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-headers', SC_CDN_HEADERS,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', sourceUrl,
  ];

  if (dims) {
    const wmW = Math.round(dims.width * 0.15);
    const wmH = Math.round(dims.height * 0.06);
    const wmX = dims.width - wmW - Math.round(dims.width * 0.03);
    const wmY = dims.height - wmH - Math.round(dims.height * 0.04);
    ffmpegArgs.push('-vf', `delogo=x=${wmX}:y=${wmY}:width=${wmW}:height=${wmH}`);
    ffmpegArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23');
    ffmpegArgs.push('-c:a', 'copy');
  } else {
    ffmpegArgs.push('-c', 'copy');
  }

  ffmpegArgs.push('-movflags', 'faststart', tmpPath);

  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(FFMPEG_BIN, ffmpegArgs, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });

  if (!ok) {
    try { await unlink(tmpPath); } catch {}
    return null;
  }

  // Read the temp file into memory and return as a Response.
  const fileStat = await stat(tmpPath).catch(() => null);
  if (!fileStat || fileStat.size === 0) {
    try { await unlink(tmpPath); } catch {}
    return null;
  }

  const fileBytes = await readFile(tmpPath);

  // Clean up temp file.
  await unlink(tmpPath).catch(() => {});

  const headers = new Headers();
  headers.set('Content-Type', 'video/mp4');
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  headers.set('Content-Length', String(fileBytes.length));
  headers.set('Cache-Control', 'no-store');

  return new Response(fileBytes, { status: 200, headers });
}
