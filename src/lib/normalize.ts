import { memo } from './cache';

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'is_from_webapp',
  'is_web',
  'web_layout',
  'sender_device',
  'share_created_at',
  'share_iid',
  'share_type',
  'share_language',
  'from_webapp',
  'igsh',
  'igshid',
  'fbclid',
  'gclid',
  'to',
  'sub',
]);

function stripTracking(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
}

function ensureScheme(raw: string): string {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

export function normalizeTikTokUrl(raw: string): string {
  try {
    const url = new URL(ensureScheme(raw));
    url.hash = '';
    url.search = '';
    if (
    url.hostname.endsWith('tiktok.com') &&
    url.hostname !== 'vm.tiktok.com' &&
    url.hostname !== 'vt.tiktok.com' &&
    !url.hostname.endsWith('.vm.tiktok.com') &&
    !url.hostname.endsWith('.vt.tiktok.com')
  ) {
    url.hostname = 'www.tiktok.com';
  }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return ensureScheme(raw).split('#')[0].split('?')[0];
  }
}

export function normalizeInstagramUrl(raw: string): string {
  try {
    const url = new URL(ensureScheme(raw));
    url.hash = '';
    stripTracking(url);
    if (url.hostname.endsWith('instagram.com') || url.hostname === 'instagram.com') {
      url.hostname = 'www.instagram.com';
    }

    const match = url.pathname.match(/^\/(?:reel|p|tv|reels|stories)\/([^/]+)/);
    if (match) {
      const seg = match[0];
      return `https://www.instagram.com${seg.replace(/\/+$/, '')}`;
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return raw.split('#')[0].split('?')[0];
  }
}

export async function resolveTikTokShortLink(raw: string): Promise<string> {
  const normalized = normalizeTikTokUrl(raw);
  try {
    const host = new URL(normalized).hostname;
    const isShort =
      host === 'vm.tiktok.com' ||
      host === 'vt.tiktok.com' ||
      host.endsWith('.vm.tiktok.com') ||
      host.endsWith('.vt.tiktok.com');
    if (!isShort) return normalized;

    return memo(`tt:resolve:${normalized}`, 24 * 60 * 60 * 1000, async () => {
      const resp = await fetch(normalized, {
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
        signal: AbortSignal.timeout(15_000),
      });
      return normalizeTikTokUrl(resp.url);
    });
  } catch {
    return normalized;
  }
}

export function parseShortcode(raw: string): string | null {
  const m = raw.match(/\/(?:reel|p|reels|tv)\/([^/?#]+)/);
  return m ? m[1] : null;
}