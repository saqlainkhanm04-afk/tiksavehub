export interface StreamOptions {
  filename: string;
  contentType: string;
  accept?: string;
  referer?: string;
  timeoutMs?: number;
}

const CONNECT_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;

// Parallel chunked mode (multiplies throughput vs a single throttled CDN
// connection):
const PARALLEL_MIN_SIZE = 1024 * 1024; // 1 MB
const PARALLEL_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB per range request
const PARALLEL_WINDOW = 4; // concurrent in-flight chunks
const CHUNK_RETRIES = 2; // re-request a failed range before giving up

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

function parseContentRange(value: string | null): number | null {
  if (!value) return null;
  const m = /bytes\s+\d+-\d+\/(\d+)/.exec(value);
  if (!m) return null;
  const total = Number(m[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

// Streaming body that downloads `total` bytes in ordered parallel chunks.
// Each chunk is pumped sequentially (so bytes stay ordered), but multiple
// chunks are open in flight at once. If a chunk's connection dies, the
// range is re-requested from the resume offset instead of killing the
// whole download.
async function parallelBody(
  sourceUrl: string,
  headers: Record<string, string>,
  total: number
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null }> {
  const n = Math.max(2, Math.min(PARALLEL_WINDOW, Math.ceil(total / PARALLEL_CHUNK_SIZE)));
  const chunkSize = Math.ceil(total / n);
  const window = Math.min(PARALLEL_WINDOW, n);

  let contentType: string | null = null;
  const readers: Array<Promise<ReadableStreamDefaultReader<Uint8Array> | null>> = new Array(n);
  // Bytes already enqueued to the client for each chunk. Retries must
  // resume from this offset or the client would receive duplicated bytes.
  const chunkProgress: number[] = new Array(n).fill(0);
  let failed = false;

  const openChunk = (i: number): Promise<ReadableStreamDefaultReader<Uint8Array> | null> =>
    (async () => {
      const start = i * chunkSize;
      const end = i === n - 1 ? total - 1 : start + chunkSize - 1;
      let res: Response;
      try {
        res = await fetchWithConnectTimeout(
          sourceUrl,
          { headers: { ...headers, Range: `bytes=${start}-${end}` } },
          CONNECT_TIMEOUT_MS
        );
      } catch {
        return null;
      }
      if (res.status !== 206 || !res.body) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      if (!contentType) contentType = res.headers.get('content-type');
      return res.body.getReader();
    })();

  // Pump chunk `i` from its current progress to the end, retrying the
  // range request up to CHUNK_RETRIES times. Returns false if it gave up.
  const pumpChunkWithRetry = async (
    i: number,
    c: ReadableStreamDefaultController<Uint8Array>
  ): Promise<boolean> => {
    const start = i * chunkSize;
    const end = i === n - 1 ? total - 1 : start + chunkSize - 1;
    for (let attempt = 0; ; attempt++) {
      const from = start + chunkProgress[i];
      try {
        const res = await fetchWithConnectTimeout(
          sourceUrl,
          { headers: { ...headers, Range: `bytes=${from}-${end}` } },
          CONNECT_TIMEOUT_MS
        );
        if (res.status !== 206 || !res.body) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`bad chunk response (${res.status})`);
        }
        if (!contentType) contentType = res.headers.get('content-type');
        await pumpReaderInto(
          res.body.getReader(),
          (v) => {
            chunkProgress[i] += v.length;
            c.enqueue(v);
          },
          IDLE_TIMEOUT_MS
        );
        return true;
      } catch (err) {
        if (attempt >= CHUNK_RETRIES) {
          console.error(`[stream] chunk ${i} (${start}-${end}) gave up after ${attempt} retries`);
          return false;
        }
        console.error(
          `[stream] chunk ${i} interrupted at byte ${start + chunkProgress[i]}, retry ${attempt + 1} (${err instanceof Error ? err.message : err})`
        );
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  };

  const startChunk = (i: number) => {
    readers[i] = openChunk(i);
  };
  for (let i = 0; i < window && i < n; i++) startChunk(i);

  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      for (let i = 0; i < n; i++) {
        if (i + window < n) startChunk(i + window);
        if (failed) return;
        const reader = await readers[i];
        const ok = await (async () => {
          if (!reader) return pumpChunkWithRetry(i, c);
          try {
            await pumpReaderInto(
              reader,
              (v) => {
                chunkProgress[i] += v.length;
                c.enqueue(v);
              },
              IDLE_TIMEOUT_MS
            );
            return true;
          } catch {
            // Reader died mid-chunk: resume this chunk from its progress.
            return pumpChunkWithRetry(i, c);
          }
        })();
        if (!ok) {
          failed = true;
          try {
            c.error(new Error('Upstream connection interrupted'));
          } catch {}
          return;
        }
      }
      try {
        c.close();
      } catch {}
    },
  });

  return { body, contentType };
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

      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          try {
            await pumpReaderInto(upstream.body!.getReader(), (v) => c.enqueue(v), IDLE_TIMEOUT_MS);
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

  // Probe range support. If the CDN answers 206 with a total size, we can
  // download it in parallel chunks (much faster on throttled connections).
  let probe: Response | null = null;
  try {
    probe = await fetchWithConnectTimeout(
      sourceUrl,
      { headers: { ...headers, Range: 'bytes=0-1' } },
      connectTimeout
    );
  } catch {
    probe = null;
  }

  if (probe) {
    const total = probe.status === 206 ? parseContentRange(probe.headers.get('content-range')) : null;
    probe.body?.cancel().catch(() => {});
    if (total && total >= PARALLEL_MIN_SIZE) {
      const t0 = Date.now();
      console.error(`[stream] PARALLEL mode: total=${total}`);
      try {
        const { body, contentType } = await parallelBody(sourceUrl, headers, total);
        const responseHeaders = new Headers();
        responseHeaders.set('Content-Type', opts.contentType || contentType || 'application/octet-stream');
        responseHeaders.set('Content-Disposition', `attachment; filename="${opts.filename}"`);
        responseHeaders.set('Cache-Control', 'no-store');
        responseHeaders.set('X-Accel-Buffering', 'no');
        responseHeaders.set('Content-Length', String(total));
        return new Response(body, { status: 200, headers: responseHeaders });
      } catch {
        console.error(`[stream] parallel FAILED after ${Date.now() - t0}ms, falling back to sequential`);
        // fall back to the sequential download
      }
    } else {
      console.error(`[stream] SEQUENTIAL mode (probe=${probe.status}, total=${total})`);
    }
  } else {
    console.error('[stream] SEQUENTIAL mode (probe request failed)');
  }

  return sequential();
}