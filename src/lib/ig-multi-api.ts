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
      auth: '20250901majwlqo',
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

    if (!resp.ok) return null;

    const json = (await resp.json()) as SaveFromInsResponse;
    if (json.status !== 1 || !json.data?.resources?.length) return null;

    // Find the best video resource.
    const videoResource = json.data.resources.find((r) => r.type === 'video' && r.download_url);
    if (!videoResource?.download_url) return null;

    return {
      videoUrl: videoResource.download_url,
      cover: json.data.thumbnail || '',
      title: json.data.title || 'Instagram Video',
      duration: json.data.duration || 0,
    };
  } catch {
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
