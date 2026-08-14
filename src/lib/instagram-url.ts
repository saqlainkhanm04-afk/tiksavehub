export type InstagramMediaType = 'reel' | 'post' | 'tv';

export interface InstagramUrlParseResult {
  isValid: boolean;
  type: InstagramMediaType | null;
  shortcode: string | null;
  cleanUrl: string;
}

const PATH_RE = /^\/(reel|p|tv)\/([A-Za-z0-9_-]{5,16})\/?$/;

export function parseInstagramUrl(rawUrl: string): InstagramUrlParseResult {
  const invalid: InstagramUrlParseResult = {
    isValid: false,
    type: null,
    shortcode: null,
    cleanUrl: '',
  };

  let input = rawUrl.trim();
  if (!input) return invalid;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = 'https://' + input;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return invalid;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return invalid;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'instagram.com') return invalid;

  const match = parsed.pathname.match(PATH_RE);
  if (!match) return invalid;

  const type: InstagramMediaType = match[1] === 'reel' ? 'reel' : match[1] === 'p' ? 'post' : 'tv';

  return {
    isValid: true,
    type,
    shortcode: match[2],
    cleanUrl: `https://www.instagram.com/${match[1]}/${match[2]}/`,
  };
}

export function backendTypeFor(type: InstagramMediaType | null): 'reels' | 'video' | null {
  if (type === 'reel') return 'reels';
  if (type === 'post' || type === 'tv') return 'video';
  return null;
}