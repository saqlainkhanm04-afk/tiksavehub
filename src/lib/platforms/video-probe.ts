/**
 * Shared video URL Content-Type + magic-bytes validation.
 *
 * Every extraction source MUST call `probeVideoUrl()` on the URLs it returns
 * before handing them to the caller. This prevents error pages, login walls,
 * and placeholder images from being streamed as "video" downloads.
 *
 * Flow:
 *  1. HEAD request with short timeout
 *  2. If HEAD returns 403/405 → GET with Range: bytes=0-0
 *  3. Content-Type must include "video/" or "application/octet-stream"
 *  4. Content-Length must be >= 1024 (tiny responses are error stubs)
 *  5. Magic bytes validated (MP4 ftyp, WebM EBML, MOV ftyp/moov)
 */

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface ProbeResult {
  ok: boolean;
  contentType: string;
  contentLength: number;
  error?: string;
}

/**
 * Check if the first bytes match an MP3 audio signature.
 * Valid MP3s start with an ID3 tag ("ID3" = 0x49 0x44 0x33) or a
 * raw MPEG audio frame sync (0xFF followed by a frame header byte
 * whose top three bits are set, e.g. 0xFB).
 */
export function isValidAudioBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;

  // ID3v2 tag: 49 44 33 ("ID3") — most MP3s carry this header.
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;

  // Raw MPEG audio frame sync: 0xFF Ex — the classic "FF FB..." MP3 signature.
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true;

  return false;
}

/**
 * Check if the first 12 bytes match a known video container signature.
 * This catches CDN error pages that lie about Content-Type.
 */
export function isValidVideoBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;

  // MP4 / MOV / 3GP: bytes 4-7 = "ftyp" (0x66 0x74 0x79 0x70)
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return true;

  // MOV: bytes 4-7 = "moov" (0x6D 0x6F 0x6F 0x76)
  if (bytes[4] === 0x6D && bytes[5] === 0x6F && bytes[6] === 0x6F && bytes[7] === 0x76) return true;

  // WebM / MKV: starts with 0x1A 0x45 0xDF 0xA3 (EBML header)
  if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) return true;

  // FLV: starts with "FLV" (0x46 0x4C 0x56)
  if (bytes[0] === 0x46 && bytes[1] === 0x4C && bytes[2] === 0x56) return true;

  // MPEG-TS: sync byte 0x47 at offset 0, 188, or 196
  if (bytes[0] === 0x47) return true;

  return false;
}

/**
 * Probe a URL to verify it returns video content.
 * Returns `{ ok: true }` only if Content-Type is video/* or application/octet-stream
 * AND the first bytes match a known video container signature.
 */
export async function probeVideoUrl(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  // HEAD first (cheapest)
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': PROBE_UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    return { ok: false, contentType: '', contentLength: 0, error: `HEAD failed: ${err?.message ?? err}` };
  }

  const ct = resp.headers.get('content-type') || '';
  const cl = Number(resp.headers.get('content-length') || '0');

  // Happy path: HEAD returned video content — still need to verify magic bytes
  if (resp.ok && isVideoContentType(ct) && cl >= 1024) {
    // Verify magic bytes with a Range GET (defense-in-depth against lying CDN error pages)
    const magic = await fetchMagicBytes(url, timeoutMs);
    if (!magic.ok) {
      return { ok: false, contentType: ct, contentLength: cl, error: `Magic bytes invalid: ${magic.error}` };
    }
    return { ok: true, contentType: ct, contentLength: cl };
  }

  // HEAD returned non-2xx — CDN may require Range or GET (covers 403, 405, 503, etc.)
  // Many CDNs return error stubs for HEAD but serve the actual content on GET.
  if (!resp.ok && isVideoContentType(ct)) {
    try {
      const getResp = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': PROBE_UA, 'Range': 'bytes=0-11' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const getCt = getResp.headers.get('content-type') || '';
      const getCl = Number(getResp.headers.get('content-length') || '0');
      const contentRange = getResp.headers.get('content-range') || '';
      const totalMatch = /\/(\d+)$/.exec(contentRange);
      const total = totalMatch ? Number(totalMatch[1]) : getCl;

      // Read actual bytes for magic-byte validation
      const bodyBuf = await getResp.arrayBuffer().catch(() => null);
      const bytes = bodyBuf ? new Uint8Array(bodyBuf) : null;

      if ((getResp.ok || getResp.status === 206) && isVideoContentType(getCt) && total >= 1024) {
        if (!bytes || !isValidVideoBytes(bytes)) {
          return { ok: false, contentType: getCt, contentLength: total, error: `Magic bytes invalid after GET: ct=${getCt} total=${total}` };
        }
        return { ok: true, contentType: getCt, contentLength: total };
      }

      // 206 without confirmed content-type — check magic bytes
      if (getResp.status === 206 && total >= 1024) {
        if (bytes && !isValidVideoBytes(bytes)) {
          return { ok: false, contentType: getCt || 'application/octet-stream', contentLength: total, error: `Magic bytes invalid on 206: total=${total}` };
        }
        return { ok: true, contentType: getCt || 'application/octet-stream', contentLength: total };
      }

      return { ok: false, contentType: getCt, contentLength: getCl, error: `GET returned ${getResp.status}` };
    } catch (err: any) {
      return { ok: false, contentType: ct, contentLength: cl, error: `GET fallback failed: ${err?.message ?? err}` };
    }
  }

  // Non-video content-type (image, HTML error page, etc.)
  if (!isVideoContentType(ct)) {
    return { ok: false, contentType: ct, contentLength: cl, error: `Non-video content-type: ${ct || '(empty)'}` };
  }

  // Too small — likely an error stub
  if (cl > 0 && cl < 1024) {
    return { ok: false, contentType: ct, contentLength: cl, error: `Response too small: ${cl} bytes` };
  }

  // HEAD ok with video ct but no content-length — verify magic bytes
  if (resp.ok && isVideoContentType(ct)) {
    const magic = await fetchMagicBytes(url, timeoutMs);
    if (!magic.ok) {
      return { ok: false, contentType: ct, contentLength: cl, error: `Magic bytes invalid: ${magic.error}` };
    }
    return { ok: true, contentType: ct, contentLength: cl };
  }

  return { ok: false, contentType: ct, contentLength: cl, error: `HEAD returned ${resp.status}` };
}

/**
 * Fetch first 12 bytes of a URL via Range GET to validate magic bytes.
 */
async function fetchMagicBytes(url: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': PROBE_UA, 'Range': 'bytes=0-11' },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 3_000)),
    });
    if (resp.status !== 200 && resp.status !== 206) {
      return { ok: false, error: `Range GET returned ${resp.status}` };
    }
    const buf = await resp.arrayBuffer().catch(() => null);
    if (!buf || buf.byteLength < 8) {
      return { ok: false, error: `Too few bytes: ${buf?.byteLength ?? 0}` };
    }
    const bytes = new Uint8Array(buf);
    if (!isValidVideoBytes(bytes)) {
      // Log what we actually got for debugging
      const hex = Array.from(bytes.slice(0, 12)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const ascii = Array.from(bytes.slice(0, 12)).map((b) => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.')).join('');
      return { ok: false, error: `Not a video file (hex: ${hex}; ascii: ${ascii})` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: `Magic bytes fetch failed: ${err?.message ?? err}` };
  }
}

function isVideoContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return lower.includes('video/') || lower.includes('application/octet-stream');
}

function isAudioContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return (
    lower.includes('audio/mpeg') ||
    lower.includes('audio/mp3') ||
    lower.startsWith('audio/') ||
    lower.includes('application/octet-stream')
  );
}

/**
 * Probe a URL to verify it returns real MP3 audio.
 * Accepts only audio content-types (audio/mpeg, audio/mp3, any audio/*,
 * application/octet-stream) AND ID3 / MPEG-sync magic bytes — never a
 * JSON/HTML error page or a video stream masquerading as audio.
 */
export async function probeAudioUrl(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': PROBE_UA, 'Range': 'bytes=0-15' },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 3_000)),
    });
    if (resp.status !== 200 && resp.status !== 206) {
      return { ok: false, contentType: '', contentLength: 0, error: `Range GET returned ${resp.status}` };
    }
    const ct = resp.headers.get('content-type') || '';
    const contentRange = resp.headers.get('content-range') || '';
    const totalMatch = /\/(\d+)$/.exec(contentRange);
    const cl = totalMatch ? Number(totalMatch[1]) : Number(resp.headers.get('content-length') || '0');

    // Read only the head chunk — never buffer the whole file during a probe.
    if (!resp.body) return { ok: false, contentType: ct, contentLength: cl, error: 'Empty response body' };
    const reader = resp.body.getReader();
    const head = await reader.read();
    await reader.cancel().catch(() => {});
    const buf = head.value ?? new Uint8Array(0);
    if (buf.byteLength < 4) {
      return { ok: false, contentType: ct, contentLength: cl, error: `Too few bytes: ${buf.byteLength}` };
    }

    if (!isAudioContentType(ct)) {
      return { ok: false, contentType: ct, contentLength: cl, error: `Non-audio content-type: ${ct || '(empty)'}` };
    }
    if (!isValidAudioBytes(buf)) {
      const hex = Array.from(buf.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return { ok: false, contentType: ct, contentLength: cl, error: `Not MP3 audio (magic bytes: ${hex})` };
    }
    return { ok: true, contentType: ct, contentLength: cl };
  } catch (err: any) {
    return { ok: false, contentType: '', contentLength: 0, error: `Audio probe failed: ${err?.message ?? err}` };
  }
}
