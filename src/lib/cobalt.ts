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
const COBALT_SITEKEY = '0x4AAAAAAEl-ZmiorHhgs7jw';

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
    h['Authorization'] = bearerToken.startsWith('Bearer ')
      ? bearerToken
      : `Bearer ${bearerToken}`;
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
  console.log(`[cobalt-audio] ▶ cobaltExtractAudio called: url=${sourceUrl} hasApiKey=${!!cobaltApiKey()} hasTurnstile=${!!turnstileToken}`);

  // Try main cobalt instance first (needs API key or turnstile token).
  const apiKey = cobaltApiKey();
  let bearerToken: string | undefined;
  if (!apiKey && turnstileToken) {
    console.log('[cobalt-audio] Exchanging turnstile for bearer token...');
    const token = await cobaltGetBearerToken(turnstileToken);
    if (token) {
      bearerToken = token;
      console.log('[cobalt-audio] Got bearer token:', token.substring(0, 30) + '...');
    } else {
      console.warn('[cobalt-audio] Turnstile exchange FAILED');
    }
  }

  if (apiKey || bearerToken) {
    const fetchUrl = `${cobaltApiBase()}/`;
    console.log(`[cobalt-audio] → POST ${fetchUrl} (main instance)`);
    try {
      const resp = await fetch(fetchUrl, {
        method: 'POST',
        headers: cobaltHeaders(bearerToken),
        body: JSON.stringify({
          url: sourceUrl,
          downloadMode: 'audio',
          audioFormat: 'mp3',
        }),
        signal: AbortSignal.timeout(30_000),
      });

      const bodyText = await resp.text().catch(() => '<unreadable>');
      console.log(`[cobalt-audio] ← status=${resp.status} body(2000)=${bodyText.substring(0, 2000)}`);

      if (resp.ok) {
        const data = JSON.parse(bodyText) as CobaltResponse;
        if (data.status !== 'error') {
          const url = extractCobaltUrl(data);
          if (url) {
            console.log(`[cobalt-audio] ✓ Main instance SUCCESS — url=${url.substring(0, 100)}...`);
            return { url, ext: 'mp3' };
          }
          console.warn('[cobalt-audio] Main instance returned no URL. status:', data.status, 'picker:', JSON.stringify(data.picker).substring(0, 300));
        } else {
          console.warn('[cobalt-audio] Main instance error status:', data.error?.code ?? 'unknown');
        }
      } else {
        console.warn(`[cobalt-audio] Main instance HTTP ${resp.status}`);
      }
    } catch (err: any) {
      console.log(`[cobalt-audio] ✗ Main instance failed: ${err?.message ?? err}`);
    }
  } else {
    console.warn('[cobalt-audio] No API key AND no bearer token — skipping main instance');
  }

  // Fallback: community cobalt instances. These rotate frequently — some
  // require turnstile, some are intermittently down. Try each with one
  // retry + exponential backoff; log failures for debugging.
  const FREE_INSTANCES = [
    'https://cobaltapi.cjs.nz',
    'https://cobaltapi.squair.xyz',
    'https://cobaltapi.kittycat.boo',
    'https://cobalt-api.lain.wtf',
    'https://cobalt-api.kwiatekmiki.com',
    'https://api.cobalt.best',
    'https://cobalt-api.hyper.lol',
  ];

  console.log(`[cobalt-audio] Trying ${FREE_INSTANCES.length} free community instances...`);
  for (const base of FREE_INSTANCES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        console.log(`[cobalt-audio] → POST ${base}/ (attempt ${attempt + 1})`);
        const resp = await fetch(`${base}/`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: sourceUrl,
            downloadMode: 'audio',
            audioFormat: 'mp3',
            audioBitrate: '320',
          }),
          signal: AbortSignal.timeout(20_000),
        });

        const bodyText = await resp.text().catch(() => '<unreadable>');
        console.log(`[cobalt-audio] ← ${base} status=${resp.status} body(1000)=${bodyText.substring(0, 1000)}`);

        if (!resp.ok) {
          if (attempt === 0) await new Promise((r) => setTimeout(r, 1_500));
          continue;
        }

        const data = JSON.parse(bodyText) as CobaltResponse;
        if (data.status === 'error') {
          console.warn(`[cobalt-audio] ${base} error: ${data.error?.code ?? 'unknown'}`);
          if (attempt === 0) await new Promise((r) => setTimeout(r, 1_500));
          continue;
        }

        const url = extractCobaltUrl(data);
        if (url) {
          console.log(`[cobalt-audio] ✓ audio extracted via ${base} — url=${url.substring(0, 120)}...`);
          return { url, ext: 'mp3' };
        }
        console.warn(`[cobalt-audio] ${base} returned no URL (status=${data.status})`);
      } catch (err: any) {
        console.warn(`[cobalt-audio] ${base} failed: ${err?.message ?? err} (attempt ${attempt + 1})`);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1_500));
      }
    }
  }

  console.error('[cobalt-audio] ALL instances failed for audio extraction');
  return null;
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
  console.log(`[Cobalt] ▶ Video extraction for: ${sourceUrl} (hasApiKey=${!!apiKey} hasTurnstile=${!!turnstileToken})`);

  let bearerToken: string | undefined;
  if (!apiKey && turnstileToken) {
    console.log(`[Cobalt]   Exchanging turnstile for bearer token...`);
    const token = await cobaltGetBearerToken(turnstileToken);
    if (token) {
      bearerToken = token;
      console.log(`[Cobalt]   Got bearer token: ${token.substring(0, 30)}...`);
    }
  }

  // Try main cobalt instance first (needs API key or turnstile token).
  if (apiKey || bearerToken) {
    const fetchUrl = `${cobaltApiBase()}/`;
    console.log(`[Cobalt] → POST ${fetchUrl}`);
    try {
      const resp = await fetch(fetchUrl, {
        method: 'POST',
        headers: cobaltHeaders(bearerToken),
        body: JSON.stringify({
          url: sourceUrl,
          downloadMode: 'auto',
          videoQuality: '1080',
        }),
        signal: AbortSignal.timeout(20_000),
      });

      const bodyText = await resp.text().catch(() => '<unreadable>');
      console.log(`[Cobalt] ← status=${resp.status} body(2000)=${bodyText.substring(0, 2000)}`);

      if (resp.ok) {
        const data = JSON.parse(bodyText) as CobaltResponse;
        if (data.status !== 'error') {
          const url = extractCobaltUrl(data);
          if (url) {
            console.log(`[Cobalt] ✓ Success via main instance — url=${url.substring(0, 100)}...`);
            return { url };
          }
        }
      }
    } catch (err: any) {
      console.log(`[Cobalt] ✗ Main instance failed: ${err?.message ?? err}`);
    }
  }

  // Fallback: community cobalt instances (no auth required)
  const FREE_INSTANCES = [
    'https://cobaltapi.cjs.nz',
    'https://cobaltapi.squair.xyz',
    'https://cobaltapi.kittycat.boo',
    'https://cobalt-api.lain.wtf',
    'https://cobalt-api.kwiatekmiki.com',
    'https://api.cobalt.best',
    'https://cobalt-api.hyper.lol',
  ];

  for (const base of FREE_INSTANCES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(`${base}/`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: sourceUrl,
            downloadMode: 'auto',
            videoQuality: '1080',
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!resp.ok) {
          console.warn(`[Cobalt] ${base} returned ${resp.status} (attempt ${attempt + 1})`);
          if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        const data = await resp.json() as CobaltResponse;
        if (data.status === 'error') {
          console.warn(`[Cobalt] ${base} error: ${data.error?.code ?? 'unknown'} (attempt ${attempt + 1})`);
          if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        const url = extractCobaltUrl(data);
        if (url) {
          console.log(`[Cobalt] ✓ Video extracted via community instance ${base}`);
          return { url };
        }
      } catch (err: any) {
        console.warn(`[Cobalt] ${base} failed: ${err?.message ?? err} (attempt ${attempt + 1})`);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  console.error('[Cobalt] all instances failed for video extraction');
  return null;
}

/** Export the sitekey so client-side components can use it. */
export const COBALT_TURNSTILE_SITEKEY = COBALT_SITEKEY;
