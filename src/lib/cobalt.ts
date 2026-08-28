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
    if (!resp.ok) return null;
    const data = await resp.json() as { token?: string };
    return data.token || null;
  } catch {
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

    if (!resp.ok) return null;

    const data = await resp.json() as { status?: string; url?: string };
    if (data.status === 'error' || !data.url) return null;

    return { url: data.url, ext: 'mp3' };
  } catch {
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

    if (!resp.ok) return null;

    const data = await resp.json() as { status?: string; url?: string };
    if (data.status === 'error' || !data.url) return null;

    return { url: data.url };
  } catch {
    return null;
  }
}

/** Export the sitekey so client-side components can use it. */
export const COBALT_TURNSTILE_SITEKEY = COBALT_SITEKEY;
