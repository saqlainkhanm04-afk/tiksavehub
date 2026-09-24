export interface StreamOptions {
  filename: string;
  contentType: string;
  accept?: string;
  referer?: string;
  timeoutMs?: number;
  /** Stream audio instead of video: accepts audio/* content-types and
   * validates ID3 / MPEG-sync magic bytes instead of video containers. */
  audio?: boolean;
}

const CONNECT_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;

function buildHeaders(opts: StreamOptions): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': opts.accept ?? '*/*',
    'Referer': opts.referer ?? 'https://tikwm.com/',
  };
}

async function fetchWithConnectTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

import { isValidAudioBytes, isValidVideoBytes } from './platforms/video-probe';

// CDNs sometimes answer HTTP 200 with a tiny error page (e.g. expired
// TikTok signed URLs) instead of a proper error status. Anything smaller
// than this is treated as a failed attempt so the next candidate is tried.
const MIN_VALID_CONTENT_LENGTH = 512;

// Read loop with an inactivity watchdog: aborts if no data arrives for
// `idleMs`. The watchdog resets on every chunk, so slow-but-flowing
// transfers are never killed.
async function pumpReaderInto(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  enqueue: (value: Uint8Array) => void,
  idleMs: number
): Promise<void> {
  let lastData = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastData > idleMs) {
      reader.cancel().catch(() => {});
    }
  }, idleMs / 2);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastData = Date.now();
      if (value?.length) enqueue(value);
    }
  } finally {
    clearInterval(watchdog);
  }
}

export async function streamFromUpstream(
  sourceUrl: string,
  opts: StreamOptions
): Promise<Response> {
  const connectTimeout = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const headers = buildHeaders(opts);

  // Sequential path: full request, connect timeout only — the transfer
  // itself is protected by the inactivity watchdog, so slow-but-flowing
  // downloads of large files are never killed mid-stream.
  const sequential = (): Promise<Response> =>
    (async () => {
      const upstream = await fetchWithConnectTimeout(sourceUrl, { headers }, connectTimeout);
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw new Error(`Upstream returned ${upstream.status}`);
      }

      // Defense-in-depth: reject non-media content-types (error pages, login walls, placeholder images)
      const audioMode = opts.audio === true;
      const upstreamCt = (upstream.headers.get('content-type') || '').toLowerCase();
      const ctOk = audioMode
        ? upstreamCt.includes('audio/') || upstreamCt.includes('application/octet-stream')
        : upstreamCt.includes('video/') || upstreamCt.includes('application/octet-stream');
      if (upstreamCt && !ctOk) {
        await upstream.body?.cancel();
        throw new Error(`Upstream returned non-${audioMode ? 'audio' : 'video'} content-type: ${upstreamCt}`);
      }

      const responseHeaders = new Headers();
      responseHeaders.set(
        'Content-Type',
        opts.contentType || upstream.headers.get('content-type') || 'application/octet-stream'
      );
      responseHeaders.set('Content-Disposition', `attachment; filename="${opts.filename}"`);
      responseHeaders.set('Cache-Control', 'no-store');
      responseHeaders.set('X-Accel-Buffering', 'no');

      const cl = upstream.headers.get('content-length');
      if (cl && Number(cl) < MIN_VALID_CONTENT_LENGTH) {
        await upstream.body?.cancel();
        throw new Error(`Upstream returned undersized body (${cl} bytes)`);
      }
      if (cl) responseHeaders.set('Content-Length', cl);

      if (!upstream.body) {
        return new Response(null, { status: 502, headers: { 'Content-Type': 'application/json' } });
      }

      // Magic bytes validation: read first 12 bytes to confirm this is actually media
      const reader = upstream.body.getReader();
      const firstChunk = await reader.read();
      if (!firstChunk.done && firstChunk.value) {
        const headerBytes = firstChunk.value.slice(0, 12);
        const bytesOk = audioMode ? isValidAudioBytes(headerBytes) : isValidVideoBytes(headerBytes);
        if (!bytesOk) {
          const hex = Array.from(headerBytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
          const ascii = Array.from(headerBytes).map((b) => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.')).join('');
          console.error(`[stream] REJECTING upstream — invalid magic bytes: hex=${hex} ascii=${ascii} ct=${upstreamCt}`);
          await reader.cancel();
          throw new Error(`Upstream returned non-${audioMode ? 'audio' : 'video'} content (magic bytes: ${hex} / ${ascii})`);
        }
        console.log(`[stream] ✓ Magic bytes OK for upstream — ct=${upstreamCt}`);
      }

      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          try {
            // Enqueue the first chunk we already read
            if (firstChunk.value?.length) c.enqueue(firstChunk.value);
            await pumpReaderInto(reader, (v) => c.enqueue(v), IDLE_TIMEOUT_MS);
            try {
              c.close();
            } catch {}
          } catch {
            try {
              c.error(new Error('Upstream connection interrupted'));
            } catch {}
          }
        },
      });
      return new Response(body, { status: 200, headers: responseHeaders });
    })();

  return sequential();
}