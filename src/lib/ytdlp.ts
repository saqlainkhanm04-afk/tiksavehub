import { execFile } from 'node:child_process';

const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp';
const YTDLP_ENABLED = process.env.YTDLP_ENABLED !== 'false';
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 40_000);
const YTDLP_MAX_BUFFER = 64 * 1024 * 1024;

let availabilityChecked = false;
let available = false;

function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_BIN,
      args,
      {
        timeout: YTDLP_TIMEOUT_MS,
        maxBuffer: YTDLP_MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const raw = (stderr || '').toString().trim();
          const detail = raw.split(/\r?\n/).filter(Boolean).pop() || raw || error.message || 'yt-dlp failed';
          const err = new Error(detail);
          (err as any).code = (error as any).code;
          reject(err);
          return;
        }
        resolve(stdout.toString());
      }
    );
  });
}

export async function isYtDlpAvailable(): Promise<boolean> {
  if (availabilityChecked) return available;
  if (!YTDLP_ENABLED) {
    availabilityChecked = true;
    return false;
  }
  try {
    await runYtDlp(['--version']);
    available = true;
  } catch {
    available = false;
  }
  availabilityChecked = true;
  return available;
}

function sessionCookieHeader(): string {
  const parts: string[] = [];
  const session = process.env.IG_SESSIONID || '';
  if (session) parts.push(`sessionid=${session}`);
  if (process.env.IG_DS_USER_ID) parts.push(`ds_user_id=${process.env.IG_DS_USER_ID}`);
  if (process.env.IG_CSRF_TOKEN) parts.push(`csrftoken=${process.env.IG_CSRF_TOKEN}`);
  return parts.join('; ');
}

function toInstagramMedia(json: any): any {
  const videoFormat =
    json.url ||
    (Array.isArray(json.requested_formats) ? json.requested_formats[0]?.url : null) ||
    null;
  const audioFormat = Array.isArray(json.requested_formats)
    ? json.requested_formats.find((f: any) => f && f.vcodec === 'none' && f.url)
    : null;

  if (!videoFormat) {
    throw new Error('yt-dlp returned no downloadable media for this link.');
  }

  const username = json.channel || json.uploader_id || '';

  const media: any = {
    video_versions: [
      { url: videoFormat, width: json.width || 1080, height: json.height || 1920 },
    ],
    video_duration: json.duration || 0,
    display_title: json.title || '',
    user: {
      username,
      full_name: json.uploader || '',
      profile_pic_url: json.thumbnail || '',
    },
    like_count: json.like_count ?? 0,
    comment_count: json.comment_count ?? 0,
    view_count: json.view_count ?? 0,
  };

  if (json.thumbnail) {
    media.image_versions_2 = { candidates: [{ url: json.thumbnail }] };
    media.image_versions2 = { candidates: [{ url: json.thumbnail }] };
    media.display_url = json.thumbnail;
  }
  if (audioFormat) {
    media.audio_versions = [{ url: audioFormat.url, bitrate: audioFormat.abr || 128_000 }];
  }

  return media;
}

async function dumpSingleJson(url: string): Promise<any> {
  if (!YTDLP_ENABLED) {
    throw new Error('yt-dlp is disabled on this server (YTDLP_ENABLED=false).');
  }
  if (!(await isYtDlpAvailable())) {
    throw new Error('yt-dlp is not installed on this server (install it or set YTDLP_PATH).');
  }

  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    '--no-color',
    '--no-check-certificates',
    '--format',
    'best[protocol!=m3u8][acodec!=none]/best[protocol!=m3u8]/best',
  ];

  const cookie = sessionCookieHeader();
  if (cookie) {
    args.push('--add-header', `Cookie: ${cookie}`);
  }

  args.push(url);

  const stdout = await runYtDlp(args);
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error('yt-dlp returned an unreadable response.');
  }

  if (!json) {
    throw new Error('yt-dlp returned no media for this link.');
  }

  return json;
}

export interface YtDlpAudioResult {
  url: string;
  ext: string;
  bitrate?: number;
}

async function fetchBestAudioWithYtDlp(url: string): Promise<YtDlpAudioResult | null> {
  if (!YTDLP_ENABLED) {
    throw new Error('yt-dlp is disabled on this server (YTDLP_ENABLED=false).');
  }
  if (!(await isYtDlpAvailable())) {
    throw new Error('yt-dlp is not installed on this server (install it or set YTDLP_PATH).');
  }

  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    '--no-color',
    '--no-check-certificates',
    '--format',
    'bestaudio',
  ];

  const cookie = sessionCookieHeader();
  if (cookie) {
    args.push('--add-header', `Cookie: ${cookie}`);
  }

  args.push(url);

  let stdout: string;
  try {
    stdout = await runYtDlp(args);
  } catch {
    return null;
  }

  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }

  const audioUrl =
    json.url ||
    (Array.isArray(json.requested_formats)
      ? json.requested_formats.find((f: any) => f && f.vcodec === 'none' && f.url)?.url
      : null) ||
    null;
  if (!audioUrl) return null;

  return {
    url: audioUrl,
    ext: json.ext || 'm4a',
    bitrate: json.abr || json.audio_bitrate || undefined,
  };
}

export async function fetchInstagramAudioWithYtDlp(url: string): Promise<YtDlpAudioResult | null> {
  return fetchBestAudioWithYtDlp(url);
}

export async function fetchFacebookAudioWithYtDlp(url: string): Promise<YtDlpAudioResult | null> {
  return fetchBestAudioWithYtDlp(url);
}

export async function fetchInstagramWithYtDlp(url: string): Promise<any> {
  return toInstagramMedia(await dumpSingleJson(url));
}

function toFacebookMedia(json: any): any {
  const formats = Array.isArray(json.formats) ? json.formats : [];
  const pick = (pred: (f: any) => boolean): string | null => {
    const hit = formats.find(pred) || null;
    return hit?.url || null;
  };
  const hasAudio = (f: any) => (f.acodec || '') !== 'none';
  const hasVideo = (f: any) => (f.vcodec || '') !== 'none';
  const progressive = (f: any) => f.protocol !== 'm3u8' && hasAudio(f) && hasVideo(f);
  const directUrl: string | null = json.url || null;
  const progressiveHd = pick((f: any) => f.format_id === 'hd' && f.protocol !== 'm3u8');
  const progressiveSd = pick((f: any) => f.format_id === 'sd' && f.protocol !== 'm3u8');
  const hdUrl =
    progressiveHd ||
    pick((f: any) => (f.height || 0) >= 720 && progressive(f)) ||
    pick((f: any) => (f.height || 0) >= 720 && f.protocol !== 'm3u8') ||
    pick((f: any) => (f.height || 0) >= 720) ||
    directUrl;
  const sdUrl =
    progressiveSd ||
    progressiveHd ||
    pick(progressive) ||
    pick((f: any) => f.protocol !== 'm3u8') ||
    directUrl;

  if (!hdUrl && !sdUrl) {
    throw new Error('yt-dlp returned no downloadable media for this link.');
  }

  const thumbnail =
    json.thumbnail ||
    (Array.isArray(json.thumbnails)
      ? [...json.thumbnails].reverse().find((t: any) => t && t.url)?.url
      : null) ||
    null;

  return {
    title: json.title || 'Facebook Video',
    cover: thumbnail,
    thumbnail,
    duration: json.duration || 0,
    hdUrl,
    sdUrl,
    author: {
      name: json.uploader || json.channel || '',
      avatar: thumbnail,
    },
    like_count: json.like_count ?? 0,
    comment_count: json.comment_count ?? 0,
    share_count: json.repost_count ?? 0,
    view_count: json.view_count ?? 0,
  };
}

export async function fetchFacebookWithYtDlp(url: string): Promise<any> {
  return toFacebookMedia(await dumpSingleJson(url));
}

function toTikTokData(json: any): any {
  const videoUrl = json.url || null;
  if (!videoUrl) {
    throw new Error('yt-dlp returned no downloadable media for this link.');
  }

  const musicFormat = Array.isArray(json.requested_formats)
    ? json.requested_formats.find((f: any) => f && f.vcodec === 'none' && f.url) ||
      json.requested_formats.find((f: any) => f && f.acodec !== 'none' && f.url)
    : null;

  const authorName = json.creator || json.uploader || '';
  const username = json.uploader_id || '';

  return {
    play: videoUrl,
    hdplay: videoUrl,
    cover: json.thumbnail || null,
    title: (json.title || '').replace(/^Video by @?/, '').trim(),
    duration: json.duration || 0,
    author: {
      unique_id: username,
      nickname: authorName,
      avatar: null,
    },
    digg_count: json.like_count ?? 0,
    comment_count: json.comment_count ?? 0,
    share_count: 0,
    play_count: json.view_count ?? 0,
    ...(musicFormat?.url
      ? {
          music_info: {
            play: musicFormat.url,
            title: json.title || '',
            author: authorName,
            album: null,
          },
        }
      : {}),
  };
}

export async function fetchTikTokWithYtDlp(url: string): Promise<any> {
  return toTikTokData(await dumpSingleJson(url));
}

export function instagramUrlFor(shortcode: string, type: string): string {
  const path = type === 'reels' ? 'reel' : 'p';
  return `https://www.instagram.com/${path}/${shortcode}/`;
}

export function tiktokUrlFor(canonical: string): string {
  return canonical;
}
