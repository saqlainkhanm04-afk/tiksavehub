/**
 * Audio helpers — CF Workers compatible.
 * Uses shared cobalt.ts for extraction; no ffmpeg, no child_process.
 */

import { cobaltExtractAudio } from './cobalt';

export interface AudioResult {
  url: string;
  contentType: string;
}

/** Extract audio from a video URL via cobalt.tools. Returns direct download URL or null. */
export async function extractAudio(sourceUrl: string): Promise<AudioResult | null> {
  const result = await cobaltExtractAudio(sourceUrl);
  if (!result) return null;
  return { url: result.url, contentType: 'audio/mpeg' };
}

/** Stream audio download — returns a Response for the caller to pipe to client. */
export async function streamAudioDownload(
  sourceUrl: string,
  filename: string
): Promise<Response> {
  const audio = await extractAudio(sourceUrl);
  if (!audio) {
    return new Response(
      JSON.stringify({ error: 'Audio extraction failed. The video may be private or unsupported.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const upstream = await fetch(audio.url, {
      headers: { 'Accept': '*/*' },
      signal: AbortSignal.timeout(60_000),
    });

    if (!upstream.ok || !upstream.body) {
      return new Response(
        JSON.stringify({ error: 'Failed to download audio from upstream.' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const headers = new Headers();
    headers.set('Content-Type', audio.contentType);
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('Cache-Control', 'no-store');
    const cl = upstream.headers.get('content-length');
    if (cl) headers.set('Content-Length', cl);

    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return new Response(
      JSON.stringify({ error: 'Audio download failed.' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/** Stub — ffmpeg not available on CF Workers */
export async function isFfmpegAvailable(): Promise<boolean> {
  return false;
}

/** Stub — bitrate probing requires ffprobe */
export async function probeAudioBitrate(_sourceUrl: string): Promise<number | null> {
  return null;
}

export function availableBitrates(_sourceKbps: number | null): number[] {
  return [128];
}

/** Stub — ffmpeg not available; uses cobalt.tools API instead */
export async function reencodeMp3(
  _sourceUrl: string,
  _opts: { bitrateKbps?: number; filename?: string } = {}
): Promise<Response> {
  const audio = await extractAudio(_sourceUrl);
  if (!audio) {
    return new Response(
      JSON.stringify({ error: 'Audio extraction failed.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const filename = _opts.filename || 'tiksavehub-audio.mp3';
  const upstream = await fetch(audio.url, { signal: AbortSignal.timeout(60_000) });
  if (!upstream.ok || !upstream.body) {
    return new Response(
      JSON.stringify({ error: 'Failed to download audio.' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const headers = new Headers();
  headers.set('Content-Type', 'audio/mpeg');
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  headers.set('Cache-Control', 'no-store');
  const cl = upstream.headers.get('content-length');
  if (cl) headers.set('Content-Length', cl);
  return new Response(upstream.body, { status: 200, headers });
}
