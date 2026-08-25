export type SnapchatLinkType = 'spotlight' | 'story' | 'post' | 'profile' | 'unknown';

export interface SnapchatUrlParseResult {
  isValid: boolean;
  linkType: SnapchatLinkType | null;
  mediaId: string | null;
  username: string | null;
  sanitizedUrl: string;
  error: string | null;
}

const SC_HOSTS = new Set([
  'snapchat.com',
  'www.snapchat.com',
  'm.snapchat.com',
  'story.snapchat.com',
]);

// /spotlight/{id} or /@user/spotlight/{id}
const SPOTLIGHT_RE = /^\/(?:@[\w.-]+\/)?spotlight\/([A-Za-z0-9_-]{4,80})\/?$/;

// /p/{id} or /@user/p/{id} (public posts)
const POST_RE = /^\/(?:@[\w.-]+\/)?p\/([A-Za-z0-9_-]{4,80})\/?$/;

// story.snapchat.com/s/{username}/{id}
const STORY_RE = /^\/s\/([A-Za-z0-9_.-]{1,30})\/([A-Za-z0-9_-]{4,80})\/?$/;

// /add/{username} (profile)
const ADD_RE = /^\/add\/([A-Za-z0-9_.-]{1,30})\/?$/;

function invalid(error: string): SnapchatUrlParseResult {
  return { isValid: false, linkType: null, mediaId: null, username: null, sanitizedUrl: '', error };
}

export function parseSnapchatUrl(raw: string): SnapchatUrlParseResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return invalid('Invalid URL');
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  // story.snapchat.com is a separate host
  if (host === 'story.snapchat.com') {
    const m = url.pathname.match(STORY_RE);
    if (m) {
      return {
        isValid: true,
        linkType: 'story',
        mediaId: m[2],
        username: m[1],
        sanitizedUrl: `https://story.snapchat.com/s/${m[1]}/${m[2]}`,
        error: null,
      };
    }
    return invalid('Invalid Snapchat story URL');
  }

  if (host !== 'snapchat.com') {
    return invalid('Not a Snapchat URL');
  }

  const pathname = url.pathname;

  // /spotlight/{id}
  const spotlightMatch = pathname.match(SPOTLIGHT_RE);
  if (spotlightMatch) {
    return {
      isValid: true,
      linkType: 'spotlight',
      mediaId: spotlightMatch[1],
      username: null,
      sanitizedUrl: `https://www.snapchat.com/spotlight/${spotlightMatch[1]}`,
      error: null,
    };
  }

  // /p/{id}
  const postMatch = pathname.match(POST_RE);
  if (postMatch) {
    return {
      isValid: true,
      linkType: 'post',
      mediaId: postMatch[1],
      username: null,
      sanitizedUrl: `https://www.snapchat.com/p/${postMatch[1]}`,
      error: null,
    };
  }

  // /add/{username}
  const addMatch = pathname.match(ADD_RE);
  if (addMatch) {
    return {
      isValid: true,
      linkType: 'profile',
      mediaId: null,
      username: addMatch[1],
      sanitizedUrl: `https://www.snapchat.com/add/${addMatch[1]}`,
      error: null,
    };
  }

  return invalid('Could not find a valid Snapchat video link. Supported: snapchat.com/spotlight/..., story.snapchat.com/s/..., snapchat.com/p/...');
}
