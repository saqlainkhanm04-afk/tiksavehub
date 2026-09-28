export interface StreamOptions {
  filename: string;
  contentType: string;
  accept?: string;
  referer?: string;
  timeoutMs?: number;
  /** Stream audio instead of video: accepts audio/* content-types and
   * validates ID3 / MPEG-sync magic bytes instead of video containers. */
  audio?: boolean;
  image?: boolean;
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

import { isValidAudioBytes, isValidImageBytes, isValidVideoBytes } from './platforms/video-probe';

// CDNs sometimes answer HTTP 200 with a tiny error page (e.g. expired
// TikTok signed URLs) instead of a proper error status. Anything smaller
// than this is treated as a failed attempt so the next candidate is tried.
const MIN_VALID_CONTENT_LENGTH = 512;

// Magic-byte signatures need up to 12 bytes. Upstreams deliver the body in
// arbitrary chunks and a valid MP4 regularly arrives as a 1-byte first chunk
// (verified live 2026 on scontent-*.cdninstagram.com: a 6.4MB reel streamed
// `00` first, every time). Validating only the first chunk therefore rejected
// perfectly good media, so read until the probe window is full (or the stream
// ends) and validate the accumulated buffer.
const MAGIC_PROBE_BYTES = 12;
// Upper bound on bytes buffered purely for validation. A source that sends
// megabytes before yielding anything usable is broken, not slow.
const MAGIC_PROBE_MAX_BYTES = 64 * 1024;

/**
 * Read chunks until `wanted` bytes are buffered, the stream ends, or
 * `maxBytes` is exceeded. Returns the buffered head plus every chunk read
 * along the way (in order) so the caller can replay them into the response.
 */
async function readProbeHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wanted: number
): Promise<{ head: Uint8Array; buffered: Uint8Array[]; ended: boolean }> {
  const buffered: Uint8Array[] = [];
  let length = 0;
  let ended = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    if (value?.length) {
      buffered.push(value);
      length += value.length;
    }
    if (length >= wanted) break;
    if (length >= MAGIC_PROBE_MAX_BYTES) break;
  }

  let head: Uint8Array;
  if (buffered.length === 1) {
    head = buffered[0];
  } else {
    head = new Uint8Array(length);
    let offset = 0;
    for (const chunk of buffered) {
      head.set(chunk, offset);
      offset += chunk.length;
    }
  }

  return { head: head.slice(0, wanted), buffered, ended };
}

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
      const imageMode = opts.image === true;
      const expectedKind = imageMode ? 'image' : audioMode ? 'audio' : 'video';
      const upstreamCt = (upstream.headers.get('content-type') || '').toLowerCase();
      const ctOk = imageMode
        ? upstreamCt.includes('image/') || upstreamCt.includes('application/octet-stream')
        : audioMode
          ? upstreamCt.includes('audio/') || upstreamCt.includes('application/octet-stream')
          : upstreamCt.includes('video/') || upstreamCt.includes('application/octet-stream');
      if (upstreamCt && !ctOk) {
        await upstream.body?.cancel();
        throw new Error(`Upstream returned non-${expectedKind} content-type: ${upstreamCt}`);
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

      // Magic bytes validation: buffer the probe window, then confirm this is
      // actually media. Validating a single chunk is not safe — see
      // readProbeHead for the 1-byte-chunk case.
      const reader = upstream.body.getReader();
      const probe = await readProbeHead(reader, MAGIC_PROBE_BYTES);
      const headerBytes = probe.head;
      const bytesOk =
        headerBytes.length >= MAGIC_PROBE_BYTES &&
        (imageMode
          ? isValidImageBytes(headerBytes)
          : audioMode
            ? isValidAudioBytes(headerBytes)
            : isValidVideoBytes(headerBytes));
      if (!bytesOk) {
        const hex = Array.from(headerBytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(headerBytes)
          .map((b) => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.'))
          .join('');
        console.error(
          `[stream] REJECTING upstream — invalid magic bytes: got=${headerBytes.length}B hex=${hex} ascii=${ascii} ct=${upstreamCt} url=${sourceUrl.slice(0, 120)}`
        );
        await reader.cancel().catch(() => {});
        throw new Error(
          `Upstream returned non-${expectedKind} content (magic bytes: ${hex || '(empty)'}${ascii ? ' / ' + ascii : ''})`
        );
      }
      console.log(
        `[stream] ✓ Magic bytes OK for upstream — ct=${upstreamCt} probeBytes=${headerBytes.length}`
      );

      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          try {
            // Replay everything already buffered during the probe window
            for (const chunk of probe.buffered) c.enqueue(chunk);
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