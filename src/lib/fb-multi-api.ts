/**
 * Multi-API fallback network for Facebook video extraction.
 *
 * When the server's own IP is blocked by Facebook, this module tries
 * 3 free third-party downloader APIs in sequence. Each API returns
 * direct CDN download URLs — no page scraping needed.
 *
 * Edge/CF Workers compatible (standard fetch, AbortSignal.timeout).
 */

import type { FacebookMedia } from './facebook';

// ─── Constants ──────────────────────────────────────────────────────────────

const API_TIMEOUT_MS = 12_000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─── URL Resolver ───────────────────────────────────────────────────────────

/**
 * Expand mobile share links, fb.watch short links, and /share/r|v|p/ links
 * to the canonical Facebook URL. These links redirect server-side, but third-party
 * APIs can't follow Facebook redirects — we must resolve them first.
 */
const SHARE_SHORT_RE = /^\/share\/[rvp]\//i;

export async function resolveFacebookUrl(url: string): Promise<string> {
  const needsResolve =
    /fb\.watch\//i.test(url) ||
    SHARE_SHORT_RE.test(new URL(url).pathname) ||
    /m\.facebook\.com|touch\.facebook\.com|mobile\.facebook\.com/i.test(url);
  if (!needsResolve) return url;

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.ok && resp.url) {
      const resolved = new URL(resp.url);
      const host = resolved.hostname.toLowerCase().replace(/^(m|mobile|touch|web)\./, 'www.');
      resolved.hostname = host;
      let path = resolved.pathname.replace(/\/+$/, '');
      resolved.pathname = path + '/';
      return resolved.toString();
    }
  } catch {
    // fall through — use original URL
  }
  return url;
}

// ─── API Source 1: Dedicated Free Downloader Endpoints ──────────────────────

interface RawApiResponse {
  url?: string;
  hd?: string;
  sd?: string;
  data?: {
    url?: string;
    hd?: string;
    sd?: string;
    title?: string;
    thumbnail?: string;
    thumb?: string;
    duration?: number;
  };
  result?: {
    url?: string;
    hd?: string;
    sd?: string;
    title?: string;
    thumbnail?: string;
    thumb?: string;
    duration?: number;
  };
  status?: string;
  success?: boolean;
  error?: string;
}

/**
 * Try dedicated free downloader endpoints. These maintain their own
 * Facebook sessions and return direct download URLs.
 */
async function tryFreeDownloaderApis(url: string): Promise<Partial<FacebookMedia> | null> {
  const endpoints = [
    `https://api.ryzendesu.vip/api/downloader/fbdown?url=${encodeURIComponent(url)}`,
    `https://deliriussapi-oficial.vercel.app/download/facebook?url=${encodeURIComponent(url)}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(endpoint, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!resp.ok) continue;

      const json = (await resp.json()) as RawApiResponse;
      const inner = json.data || json.result;
      const hd = inner?.hd || json.hd || '';
      const sd = inner?.sd || json.sd || '';
      const videoUrl = hd || sd || inner?.url || json.url || '';

      if (!videoUrl) continue;

      return {
        title: inner?.title || json.data?.title || 'Facebook Video',
        cover: inner?.thumbnail || inner?.thumb || json.data?.thumbnail || '',
        duration: inner?.duration || json.data?.duration || 0,
        hdUrl: hd || videoUrl,
        sdUrl: sd || null,
        author: { name: '', avatar: '' },
        like_count: 0,
        comment_count: 0,
        share_count: 0,
        view_count: 0,
      };
    } catch {
      // try next endpoint
    }
  }
  return null;
}

// ─── API Source 2: Cobalt Instance Mirrors ──────────────────────────────────

interface CobaltResponse {
  status?: string;
  url?: string;
  tunnel?: string[];
  picker?: Array<{ type?: string; url?: string }>;
  error?: { code?: string };
}

const COBALT_INSTANCES = [
  'https://api.cobalt.tools',
  'https://cobalt-api.kwiatekmiki.com',
  'https://cobalt.canine.tools',
];

/**
 * Try Cobalt API instances for video extraction.
 * Uses the auto-download mode with 1080p quality.
 */
async function tryCobaltInstances(url: string): Promise<Partial<FacebookMedia> | null> {
  for (const base of COBALT_INSTANCES) {
    try {
      const resp = await fetch(`${base}/`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          downloadMode: 'auto',
          videoQuality: '1080',
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (!resp.ok) continue;

      const data = (await resp.json()) as CobaltResponse;
      if (data.status === 'error') continue;

      let videoUrl: string | null = null;
      if (data.url) {
        videoUrl = data.url;
      } else if (data.status === 'local-processing' && Array.isArray(data.tunnel) && data.tunnel.length > 0) {
        videoUrl = data.tunnel[0];
      } else if (data.status === 'picker' && Array.isArray(data.picker) && data.picker.length > 0) {
        videoUrl = data.picker[0]?.url || null;
      }

      if (!videoUrl) continue;

      return {
        title: 'Facebook Video',
        cover: '',
        duration: 0,
        hdUrl: videoUrl,
        sdUrl: null,
        author: { name: '', avatar: '' },
        like_count: 0,
        comment_count: 0,
        share_count: 0,
        view_count: 0,
      };
    } catch {
      // try next instance
    }
  }
  return null;
}

// ─── API Source 3: Secondary Free Scraper ───────────────────────────────────

interface FdownResponse {
  url?: string;
  title?: string;
  thumbnail?: string;
  sd_url?: string;
  hd_url?: string;
  success?: boolean;
}

/**
 * Try secondary free scraper endpoints.
 */
async function trySecondaryScrapers(url: string): Promise<Partial<FacebookMedia> | null> {
  const endpoints = [
    `https://api.v2.fdown.net/download.php?url=${encodeURIComponent(url)}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(endpoint, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!resp.ok) continue;

      const json = (await resp.json()) as FdownResponse;
      const hd = json.hd_url || '';
      const sd = json.sd_url || '';
      const videoUrl = hd || sd || json.url || '';

      if (!videoUrl) continue;

      return {
        title: json.title || 'Facebook Video',
        cover: json.thumbnail || '',
        duration: 0,
        hdUrl: hd || videoUrl,
        sdUrl: sd || null,
        author: { name: '', avatar: '' },
        like_count: 0,
        comment_count: 0,
        share_count: 0,
        view_count: 0,
      };
    } catch {
      // try next endpoint
    }
  }
  return null;
}

// ─── Main Export ────────────────────────────────────────────────────────────

/**
 * Attempt to extract Facebook video metadata via 3 free API sources.
 * Returns normalized media object on success, null if all sources fail.
 * Never throws — caller falls back to native page scraping.
 */
export async function fetchFacebookMediaViaMultiApi(url: string): Promise<Partial<FacebookMedia> | null> {
  // Source 1: Dedicated free downloader endpoints
  const s1 = await tryFreeDownloaderApis(url);
  if (s1?.hdUrl || s1?.sdUrl) return s1;

  // Source 2: Cobalt instance mirrors
  const s2 = await tryCobaltInstances(url);
  if (s2?.hdUrl || s2?.sdUrl) return s2;

  // Source 3: Secondary free scrapers
  const s3 = await trySecondaryScrapers(url);
  if (s3?.hdUrl || s3?.sdUrl) return s3;

  return null;
}
