export interface StreamOptions {
  filename: string;
  contentType: string;
  accept?: string;
  referer?: string;
  timeoutMs?: number;
}

export async function streamFromUpstream(
  sourceUrl: string,
  opts: StreamOptions
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);

  let upstream: Response;
  try {
    upstream = await fetch(sourceUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': opts.accept ?? '*/*',
        'Referer': opts.referer ?? 'https://tikwm.com/',
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw new Error(`Upstream returned ${upstream.status}`);
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || opts.contentType);
  headers.set('Content-Disposition', `attachment; filename="${opts.filename}"`);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Accel-Buffering', 'no');

  const cl = upstream.headers.get('content-length');
  if (cl) headers.set('Content-Length', cl);

  if (!upstream.body) {
    return new Response(null, { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  const reader = upstream.body.getReader();
  const body = new ReadableStream({
    async start(c) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            try {
              c.close();
            } catch {}
            return;
          }
          try {
            c.enqueue(value);
          } catch {
            await reader.cancel();
            return;
          }
        }
      } catch {
        try {
          c.error(new Error('Upstream connection interrupted'));
        } catch {}
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(body, { status: 200, headers });
}
