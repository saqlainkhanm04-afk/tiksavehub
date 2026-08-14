export type FacebookLinkType =
  | 'reel'
  | 'watch'
  | 'watch_live'
  | 'profile_video'
  | 'video_page'
  | 'short'
  | 'photo'
  | 'unknown';

export interface FacebookUrlParseResult {
  isValid: boolean;
  isVideo: boolean;
  linkType: FacebookLinkType | null;
  videoId: string | null;
  shortCode: string | null;
  sanitizedUrl: string;
  error: string | null;
}

// Tracking / share parameters that add no value to the media itself.
// These are stripped so the canonical URL stays clean and cache-friendly.
const TRACKING_PARAMS = new Set([
  'mibextid',
  'ref',
  's',
  '_rdr',
  'wtsid',
  'eid',
  'ft',
  'ftid',
  'fref',
  'extid',
  'tn',
  '__tn__',
  '__cft__[0]',
  '__xts__',
  'qid',
  'epa',
  'n',
  'sfnsn',
  'sfnsmo',
  'source',
]);

const FB_HOSTS = new Set([
  'facebook.com',
  'fb.com',
  'm.facebook.com',
  'mbasic.facebook.com',
  'web.facebook.com',
  'touch.facebook.com',
]);

const SHORT_HOSTS = new Set(['fb.watch']);

const REEL_RE = /^\/reel(s)?\/(\d+)(?:\/([^/]+))?\/?$/;
const PROFILE_VIDEO_RE = /^\/([A-Za-z0-9._-]+)\/videos\/(\d+)(?:\/([^/]+))?\/?$/;
const WATCH_PATH_RE = /^\/watch\/?$/;
const WATCH_LIVE_PATH_RE = /^\/watch\/live\/?$/;
const VIDEO_PAGE_PATH_RE = /^\/(video\.php|permalink\.php|story\.php)\/?$/;
const PHOTO_PAGE_PATH_RE = /^\/(photo\.php|photo)|\/photos\//;

function invalid(error: string): FacebookUrlParseResult {
  return {
    isValid: false,
    isVideo: false,
    linkType: null,
    videoId: null,
    shortCode: null,
    sanitizedUrl: '',
    error,
  };
}

function stripTrackingParams(parsed: URL): URL {
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed;
}

/**
 * Parse, validate and sanitize a Facebook video link.
 *
 * Supports Reels, Watch links, video posts (/user/videos/…), legacy video
 * pages (video.php / permalink.php), fb.watch short links, and mobile hosts
 * (m.facebook.com). Tracking query parameters are stripped automatically and
 * the returned `sanitizedUrl` is a canonical, cache-friendly URL.
 */
export function parseFacebookUrl(rawUrl: string): FacebookUrlParseResult {
  let input = (rawUrl || '').trim();
  if (!input) {
    return invalid('Please paste a Facebook video link.');
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    input = 'https://' + input;
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return invalid('That does not look like a valid link. Please check it and try again.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalid('That does not look like a valid link. Please check it and try again.');
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  parsed.hostname = host;

  // --- Short links (fb.watch/…) -------------------------------
  if (SHORT_HOSTS.has(host)) {
    const code = (parsed.pathname || '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!/^[A-Za-z0-9_-]{4,16}$/.test(code)) {
      return invalid('That Facebook short link is not valid. Please check it and try again.');
    }
    parsed.search = '';
    return {
      isValid: true,
      isVideo: true,
      linkType: 'short',
      videoId: null,
      shortCode: code,
      sanitizedUrl: `https://fb.watch/${code}/`,
      error: null,
    };
  }

  // --- Facebook hosts -----------------------------------------
  if (!FB_HOSTS.has(host)) {
    return invalid('Please enter a valid Facebook video link (facebook.com/reel/…, facebook.com/watch/?v=…).');
  }

  stripTrackingParams(parsed);
  const pathname = parsed.pathname.replace(/\/+$/, '');

  // Reels — facebook.com/reel/{id}[/{slug}]
  const reelMatch = pathname.match(REEL_RE);
  if (reelMatch) {
    const id = reelMatch[2];
    return {
      isValid: true,
      isVideo: true,
      linkType: 'reel',
      videoId: id,
      shortCode: null,
      sanitizedUrl: `https://www.facebook.com/reel/${id}/`,
      error: null,
    };
  }

  // Profile video posts — facebook.com/{user}/videos/{id}[/{slug}]
  const profileMatch = pathname.match(PROFILE_VIDEO_RE);
  if (profileMatch) {
    const id = profileMatch[2];
    return {
      isValid: true,
      isVideo: true,
      linkType: 'profile_video',
      videoId: id,
      shortCode: null,
      sanitizedUrl: `https://www.facebook.com/${profileMatch[1]}/videos/${id}/`,
      error: null,
    };
  }

  // Watch — facebook.com/watch/?v={id}
  if (WATCH_PATH_RE.test(pathname)) {
    const v = parsed.searchParams.get('v');
    if (v && /^\d{5,20}$/.test(v)) {
      return {
        isValid: true,
        isVideo: true,
        linkType: 'watch',
        videoId: v,
        shortCode: null,
        sanitizedUrl: `https://www.facebook.com/watch/?v=${v}`,
        error: null,
      };
    }
    return invalid('Please include the video ID (…watch/?v=123456789) in the Facebook link.');
  }

  // Live — facebook.com/watch/live/?ref=…&v={id}
  if (WATCH_LIVE_PATH_RE.test(pathname)) {
    const v = parsed.searchParams.get('v');
    if (v && /^\d{5,20}$/.test(v)) {
      return {
        isValid: true,
        isVideo: true,
        linkType: 'watch_live',
        videoId: v,
        shortCode: null,
        sanitizedUrl: `https://www.facebook.com/watch/live/?v=${v}`,
        error: null,
      };
    }
    return invalid('Please include the video ID (…watch/live/?v=123456789) in the Facebook link.');
  }

  // Legacy video pages — video.php / permalink.php / story.php
  if (VIDEO_PAGE_PATH_RE.test(pathname)) {
    const id =
      parsed.searchParams.get('v') ||
      parsed.searchParams.get('id') ||
      parsed.searchParams.get('story_fbid');
    if (id && /^\d{5,20}$/.test(id)) {
      return {
        isValid: true,
        isVideo: true,
        linkType: 'video_page',
        videoId: id,
        shortCode: null,
        sanitizedUrl: `https://www.facebook.com/video.php?v=${id}`,
        error: null,
      };
    }
    return invalid('Could not find a video ID in that Facebook link.');
  }

  // Photo pages are valid Facebook content but not downloadable videos.
  if (PHOTO_PAGE_PATH_RE.test(pathname)) {
    return {
      isValid: true,
      isVideo: false,
      linkType: 'photo',
      videoId: null,
      shortCode: null,
      sanitizedUrl: parsed.toString(),
      error: 'That link points to a photo. This tool only downloads Facebook videos and Reels.',
    };
  }

  return invalid(
    'Please enter a valid Facebook video link (facebook.com/reel/…, facebook.com/watch/?v=…, fb.watch/…).'
  );
}

export function isValidFacebookVideoUrl(rawUrl: string): boolean {
  const parsed = parseFacebookUrl(rawUrl);
  return parsed.isValid && parsed.isVideo;
}
