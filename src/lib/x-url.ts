export type XLinkType = 'video' | 'photo' | 'unknown';

export interface XUrlParseResult {
  isValid: boolean;
  linkType: XLinkType | null;
  tweetId: string | null;
  username: string | null;
  sanitizedUrl: string;
  error: string | null;
}

const X_HOSTS = new Set([
  'x.com',
  'twitter.com',
  'mobile.twitter.com',
  'touch.twitter.com',
  'nitter.net',
]);

const TCO_HOST = 't.co';

// /{username}/status/{id} optionally followed by /photo/{n} or /video/{n}
const STATUS_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/;

// /i/status/{id} (no username)
const I_STATUS_RE = /^\/i\/status\/(\d+)\/?$/;

function invalid(error: string): XUrlParseResult {
  return { isValid: false, linkType: null, tweetId: null, username: null, sanitizedUrl: '', error };
}

export function parseXUrl(raw: string): XUrlParseResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return invalid('Invalid URL');
  }

  const host = url.hostname.toLowerCase();

  // t.co short links — follow the redirect to get the real URL
  if (host === TCO_HOST || host === `www.${TCO_HOST}`) {
    // We can't follow redirects synchronously; return the t.co URL as-is
    // and let the caller resolve it.
    return {
      isValid: true,
      linkType: 'video',
      tweetId: null,
      username: null,
      sanitizedUrl: url.href,
      error: null,
    };
  }

  if (!X_HOSTS.has(host) && !X_HOSTS.has(host.replace(/^www\./, ''))) {
    return invalid('Not an X/Twitter URL');
  }

  const pathname = url.pathname;

  // /{username}/status/{id}
  const statusMatch = pathname.match(STATUS_RE);
  if (statusMatch) {
    const username = statusMatch[1];
    const tweetId = statusMatch[2];
    return {
      isValid: true,
      linkType: 'video',
      tweetId,
      username,
      sanitizedUrl: `https://x.com/${username}/status/${tweetId}`,
      error: null,
    };
  }

  // /i/status/{id}
  const iStatusMatch = pathname.match(I_STATUS_RE);
  if (iStatusMatch) {
    const tweetId = iStatusMatch[1];
    return {
      isValid: true,
      linkType: 'video',
      tweetId,
      username: null,
      sanitizedUrl: `https://x.com/i/status/${tweetId}`,
      error: null,
    };
  }

  return invalid('Could not find a tweet ID in this URL');
}
