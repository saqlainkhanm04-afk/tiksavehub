/**
 * Multi-API fallback network for Instagram video/reel extraction.
 *
 * When the server's own IP is blocked by Instagram (GraphQL fails,
 * embed returns no video, __a=1 returns login wall), this module
 * tries third-party downloader APIs that maintain their own sessions.
 *
 * Edge/CF Workers compatible (standard fetch, AbortSignal.timeout).
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const API_TIMEOUT_MS = 15_000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// SaveFromIns is the only extraction source that survives Instagram's anonymous
// blocks (its backend holds its own logged-in session). It fronts HikerAPI, and
// the shared key below is the weakest link in the whole Reels pipeline: when it
// is revoked every source fails at once. Override it with IG_SAVEFROMINS_AUTH so
// the site owner can rotate the key without a code change.
const DEFAULT_AUTH = '20250901majwlqo';
let _authOverride = '';

export function setMultiApiAuth(value: string): void {
  _authOverride = (value || '').trim();
}

function authKey(): string {
  return _authOverride || DEFAULT_AUTH;
}

// ─── API Source 1: SaveFromIns ──────────────────────────────────────────────

interface SaveFromInsResource {
  type?: string;
  quality?: string;
  format?: string;
  download_url?: string;
  resource_content?: string;
  download_mode?: string;
  preview_url?: string;
}

interface SaveFromInsResponse {
  status?: number;
  status_code?: string;
  msg?: string;
  data?: {
    title?: string;
    thumbnail?: string;
    duration?: number;
    resources?: SaveFromInsResource[];
  };
}

/**
 * Try SaveFromIns API — their backend fetches Instagram with its own
 * session and returns direct CDN download URLs.
 */
async function trySaveFromIns(url: string): Promise<Partial<{ videoUrl: string; cover: string; title: string; duration: number }> | null> {
  try {
    const body = new URLSearchParams({
      auth: authKey(),
      domain: 'api-ak.savefromins.com',
      origin: 'source',
      link: url,
    });

    const resp = await fetch('https://api.savefromins.com/api/contentsite_api/media/parse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Origin: 'https://savefromins.com',
        Referer: 'https://savefromins.com/',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!resp.ok) {
      console.warn(`[IG-MultiAPI] SaveFromIns HTTP ${resp.status}`);
      return null;
    }

    const json = (await resp.json()) as SaveFromInsResponse;
    if (json.status !== 1 || !json.data?.resources?.length) {
      // SaveFromIns answers HTTP 200 with status:0 when its own Instagram
      // session is blocked, which is what Cloudflare egress IP gets. Log the
      // real reason instead of failing silently (cost us hours of blind spots).
      console.warn(
        `[IG-MultiAPI] SaveFromIns refused: status=${json.status} code=${json.status_code || 'n/a'} msg=${json.msg || 'n/a'}`
      );
      return null;
    }

    // Find the best video resource.
    const videoResource = json.data.resources.find((r) => r.type === 'video' && r.download_url);
    if (!videoResource?.download_url) return null;

    return {
      videoUrl: videoResource.download_url,
      cover: json.data.thumbnail || '',
      title: json.data.title || 'Instagram Video',
      duration: json.data.duration || 0,
    };
  } catch (err) {
    console.warn(`[IG-MultiAPI] SaveFromIns request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Main Export ────────────────────────────────────────────────────────────

export interface IgMultiApiResult {
  videoUrl: string;
  cover: string;
  title: string;
  duration: number;
}

/**
 * Attempt to extract Instagram video via third-party downloader APIs.
 * Returns video metadata on success, null if all sources fail.
 * Never throws — caller falls back to native IG extraction.
 */
export async function fetchInstagramViaMultiApi(url: string): Promise<IgMultiApiResult | null> {
  const s1 = await trySaveFromIns(url);
  if (s1?.videoUrl) {
    return {
      videoUrl: s1.videoUrl,
      cover: s1.cover || '',
      title: s1.title || 'Instagram Video',
      duration: s1.duration || 0,
    };
  }

  return null;
}
