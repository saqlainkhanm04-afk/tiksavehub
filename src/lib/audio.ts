import { spawn } from 'node:child_process';

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG_ENABLED = process.env.FFMPEG_ENABLED !== 'false';
const PROBE_TIMEOUT_MS = Number(process.env.FFPROBE_TIMEOUT_MS || 20_000);

let availabilityChecked = false;
let available = false;

export async function isFfmpegAvailable(): Promise<boolean> {
  if (availabilityChecked) return available;
  if (!FFMPEG_ENABLED) {
    availabilityChecked = true;
    available = false;
    return false;
  }
  available = await runProbe(['-version']);
  availabilityChecked = true;
  return available;
}

function runProbe(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(FFPROBE_BIN, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

// Simple in-memory bitrate cache keyed by source URL (10 min TTL).
const bitrateCache = new Map<string, { kbps: number | null; at: number }>();
const BITRATE_TTL_MS = 10 * 60 * 1000;

export async function probeAudioBitrate(sourceUrl: string): Promise<number | null> {
  const cached = bitrateCache.get(sourceUrl);
  if (cached && Date.now() - cached.at < BITRATE_TTL_MS) return cached.kbps;

  const value = await new Promise<number | null>((resolve) => {
    const child = spawn(
      FFPROBE_BIN,
      [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=bit_rate',
        '-of', 'csv=p=0',
        sourceUrl,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, PROBE_TIMEOUT_MS);

    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const kbps = Math.round(Number(out.trim()) / 1000);
        resolve(Number.isFinite(kbps) && kbps > 0 ? kbps : null);
      } else {
        resolve(null);
      }
    });
  });

  bitrateCache.set(sourceUrl, { kbps: value, at: Date.now() });
  return value;
}

const DEFAULT_BITRATES = [96, 128, 160, 320];

// Honest options: never advertise a bitrate higher than the source supports.
export function availableBitrates(sourceKbps: number | null): number[] {
  if (!sourceKbps) return [96, 128];
  return DEFAULT_BITRATES.filter((b) => b <= sourceKbps);
}

export interface ReencodeOptions {
  bitrateKbps: number;
  filename: string;
  timeoutMs?: number;
}

export function reencodeMp3(sourceUrl: string, opts: ReencodeOptions): Response {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000);

  const child = spawn(
    FFMPEG_BIN,
    [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', sourceUrl,
      '-vn',
      '-codec:a', 'libmp3lame',
      '-b:a', `${opts.bitrateKbps}k`,
      '-f', 'mp3',
      'pipe:1',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  const headers = new Headers();
  headers.set('Content-Type', 'audio/mpeg');
  headers.set('Content-Disposition', `attachment; filename="${opts.filename}"`);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Accel-Buffering', 'no');

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      let finished = false;

      const fail = (msg: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        controller.abort();
        try { child.kill(); } catch {}
        try { c.error(new Error(msg)); } catch {}
      };

      const end = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { c.close(); } catch {}
      };

      child.stdout.on('data', (chunk: Uint8Array) => {
        try { c.enqueue(chunk); } catch {}
      });
      child.stdout.on('end', () => {
        if (finished) return;
        if (child.exitCode !== null && child.exitCode !== 0) {
          const detail = stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
          fail(`Audio conversion failed${detail ? `: ${detail}` : ''}.`);
        } else {
          end();
        }
      });
      child.stdout.on('error', () => fail('Audio conversion failed.'));
      child.on('error', () => fail('ffmpeg is not available on this server.'));
      child.on('exit', (code) => {
        if (code !== 0) fail(`Audio conversion failed (exit ${code}).`);
      });
    },
    cancel() {
      clearTimeout(timer);
      controller.abort();
      try { child.kill(); } catch {}
    },
  });

  return new Response(body, { status: 200, headers });
}
