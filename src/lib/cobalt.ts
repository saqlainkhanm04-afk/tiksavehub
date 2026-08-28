/**
 * Shared cobalt.tools API helper — CF Workers compatible.
 *
 * Auth flow (public api.cobalt.tools requires JWT Bearer token):
 *   1. Client solves invisible Cloudflare Turnstile widget → gets turnstile response
 *   2. Client sends turnstile response to our API route
 *   3. Server calls cobalt POST /session with turnstile response → gets JWT Bearer token
 *   4. Server uses JWT for audio/video extraction via POST /
 *
 * Env vars (Cloudflare .dev.vars / dashboard):
 *   COBALT_API_URL  — base URL (default: https://api.cobalt.tools)
 *   COBALT_API_KEY  — optional Api-Key (if instance owner gives you one)
 */

const DEFAULT_API = 'https://api.cobalt.tools';
const COBALT_SITEKEY = '0x4AAAAAAAhUvTuTxLs2HYH4';

function cobaltApiBase(): string {
  try {
    const v = (import.meta as any).env?.COBALT_API_URL
      || (typeof process !== 'undefined' && process.env?.COBALT_API_URL);
    if (v && typeof v === 'string') return v.replace(/\/+$/, '');
  } catch {}
  return DEFAULT_API;
}

function cobaltApiKey(): string | null {
  try {
    const v = (import.meta as any).env?.COBALT_API_KEY
      || (typeof process !== 'undefined' && process.env?.COBALT_API_KEY);
    if (v && typeof v === 'string' && v.trim()) return v.trim();
  } catch {}
  return null;
}

/** Exchange a Turnstile solution for a short-lived JWT Bearer token from cobalt. */
async function cobaltGetBearerToken(turnstileToken: string): Promise<string | null> {
  try {
    const resp = await fetch(`${cobaltApiBase()}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-turnstile-response': turnstileToken,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`[cobalt] session exchange failed: ${resp.status} ${errText}`);
      return null;
    }
    const data = await resp.json() as { token?: string };
    if (!data.token) {
      console.error('[cobalt] session exchange returned no token');
      return null;
    }
    return data.token;
  } catch (err: any) {
    console.error(`[cobalt] session exchange error: ${err?.message ?? err}`);
    return null;
  }
}

/** Build auth headers — uses API key if set, otherwise expects a Bearer token. */
function cobaltHeaders(bearerToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
  const apiKey = cobaltApiKey();
  if (apiKey) {
    h['Authorization'] = `Api-Key ${apiKey}`;
  } else if (bearerToken) {
    h['Authorization'] = bearerToken; // already includes "Bearer ..."
  }
  return h;
}

export interface CobaltAudioResult {
  url: string;
  ext: string;
}

interface CobaltResponse {
  status?: string;
  url?: string;
  filename?: string;
  tunnel?: string[];
  picker?: Array<{ type?: string; url?: string }>;
  audio?: string;
  error?: { code?: string };
}

function extractCobaltUrl(data: CobaltResponse): string | null {
  if (data.url) return data.url;
  if (data.status === 'local-processing' && Array.isArray(data.tunnel) && data.tunnel.length > 0) {
    return data.tunnel[0];
  }
  if (data.status === 'picker') {
    if (data.audio) return data.audio;
    if (Array.isArray(data.picker) && data.picker.length > 0) {
      return data.picker[0]?.url || null;
    }
  }
  return null;
}

/**
 * Extract audio from any video URL via cobalt.tools.
 * @param sourceUrl - video URL to extract audio from
 * @param turnstileToken - turnstile solution from client (required if no COBALT_API_KEY)
 */
export async function cobaltExtractAudio(
  sourceUrl: string,
  turnstileToken?: string,
): Promise<CobaltAudioResult | null> {
  const apiKey = cobaltApiKey();

  // If no API key, we need a turnstile token to get a Bearer token
  let bearerToken: string | undefined;
  if (!apiKey) {
    if (!turnstileToken) return null;
    const token = await cobaltGetBearerToken(turnstileToken);
    if (!token) return null;
    bearerToken = token;
  }

  try {
    const resp = await fetch(`${cobaltApiBase()}/`, {
      method: 'POST',
      headers: cobaltHeaders(bearerToken),
      body: JSON.stringify({
        url: sourceUrl,
        downloadMode: 'audio',
        audioFormat: 'mp3',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`[cobalt] audio request failed: ${resp.status} ${errText}`);
      return null;
    }

    const data = await resp.json() as CobaltResponse;
    if (data.status === 'error') {
      console.error(`[cobalt] audio error: ${data.error?.code ?? 'unknown'}`);
      return null;
    }

    const url = extractCobaltUrl(data);
    if (!url) {
      console.error(`[cobalt] audio: no downloadable URL in response (status=${data.status})`);
      return null;
    }

    return { url, ext: 'mp3' };
  } catch (err: any) {
    console.error(`[cobalt] audio exception: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Extract video via cobalt.tools (used as fallback for some platforms).
 * @param sourceUrl - video URL
 * @param turnstileToken - turnstile solution from client (required if no COBALT_API_KEY)
 */
export async function cobaltExtractVideo(
  sourceUrl: string,
  turnstileToken?: string,
): Promise<{ url: string } | null> {
  const apiKey = cobaltApiKey();

  let bearerToken: string | undefined;
  if (!apiKey) {
    if (!turnstileToken) return null;
    const token = await cobaltGetBearerToken(turnstileToken);
    if (!token) return null;
    bearerToken = token;
  }

  try {
    const resp = await fetch(`${cobaltApiBase()}/`, {
      method: 'POST',
      headers: cobaltHeaders(bearerToken),
      body: JSON.stringify({
        url: sourceUrl,
        downloadMode: 'auto',
        videoQuality: '1080',
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`[cobalt] video request failed: ${resp.status} ${errText}`);
      return null;
    }

    const data = await resp.json() as CobaltResponse;
    if (data.status === 'error') {
      console.error(`[cobalt] video error: ${data.error?.code ?? 'unknown'}`);
      return null;
    }

    const url = extractCobaltUrl(data);
    if (!url) {
      console.error(`[cobalt] video: no downloadable URL in response (status=${data.status})`);
      return null;
    }

    return { url };
  } catch (err: any) {
    console.error(`[cobalt] video exception: ${err?.message ?? err}`);
    return null;
  }
}

/** Export the sitekey so client-side components can use it. */
export const COBALT_TURNSTILE_SITEKEY = COBALT_SITEKEY;
