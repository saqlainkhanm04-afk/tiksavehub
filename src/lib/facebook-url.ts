export type FacebookLinkType =
  | 'reel'
  | 'watch'
  | 'watch_live'
  | 'profile_video'
  | 'video_page'
  | 'short'
  | 'story'
  | 'photo'
  | 'unknown';

export interface FacebookUrlParseResult {
  isValid: boolean;
  isVideo: boolean;
  linkType: FacebookLinkType | null;
  videoId: string | null;
  photoId: string | null;
  albumId: string | null;
  shortCode: string | null;
  sanitizedUrl: string;
  /** The /stories/{id}/{token} URL, available for story links. */
  storiesUrl?: string;
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
const PHOTO_PAGE_PATH_RE = /^\/(photo\.php|photo)\/?$/;
const PHOTO_PROFILE_BASE_RE = /^\/([A-Za-z0-9._-]+)\/photos\/?$/;
const PHOTO_PROFILE_ITEM_RE = /^\/([A-Za-z0-9._-]+)\/photos\/(.+)$/;
const PHOTO_VIEW_FULL_RE = /^\/photo\/view_full_size\/?$/;
const ALBUM_PAGE_RE = /^\/([A-Za-z0-9._-]+)\/albums\/(\d+)(?:\/[^/]+)?\/?$/;
// Direct album link without user prefix — facebook.com/albums/{albumId}
const ALBUM_DIRECT_RE = /^\/albums\/(\d+)(?:\/[^/]+)?\/?$/;
const STORY_PATH_RE = /^\/(stories)\/(\d{5,20})(?:\/([A-Za-z0-9_=%\-+\/]{4,96}))?\/?$/;
const STORIES_PHP_PROFILE_RE = /^\/stories\.php\/?$/;
const SHARE_REEL_RE = /^\/share\/r\/([A-Za-z0-9_-]{4,20})\/?$/;
const SHARE_VIDEO_RE = /^\/share\/v\/([A-Za-z0-9_-]{4,20})\/?$/;
const SHARE_PHOTO_RE = /^\/share\/p\/([A-Za-z0-9_-]{4,20})\/?$/;

function invalid(error: string): FacebookUrlParseResult {
  return {
    isValid: false,
    isVideo: false,
    linkType: null,
    videoId: null,
    photoId: null,
    albumId: null,
    shortCode: null,
    sanitizedUrl: '',
    error,
  };
}

/**
 * Decode a Facebook story share token. The token looks like
 * "UzpfSVNDOjE3NjAzNDYxMjg0OTg5MjU=" which is base64 of "S:_ISC:{story_id}".
 * Returns the trailing numeric story id, or '' when the token isn't the
 * expected shape.
 */
function decodeStoryToken(token: string): string {
  try {
    const un = decodeURIComponent(token);
    const cleaned = un.replace(/-/g, '+').replace(/_/g, '/');
    const b64 = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
    const decoded = decodeURIComponent(
      Array.prototype.map.call(atob(b64), (c: string) =>
        '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
      ).join('')
    );
    const m = decoded.match(/(\d{5,30})$/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
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
      photoId: null,
      albumId: null,
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
      photoId: null,
      albumId: null,
      shortCode: null,
      sanitizedUrl: `https://www.facebook.com/reel/${id}/`,
      error: null,
    };
  }

  // Share links — facebook.com/share/r/{code} (Reels) and /share/v/{code}
  // (videos). The code is alphanumeric and Facebook redirects these to the
  // canonical media URL, so the share URL itself is kept as the fetch URL.
  const shareReelMatch = pathname.match(SHARE_REEL_RE);
  if (shareReelMatch) {
    const code = shareReelMatch[1];
    return {
      isValid: true,
      isVideo: true,
      linkType: 'reel',
      videoId: null,
      photoId: null,
      albumId: null,
      shortCode: code,
      sanitizedUrl: `https://www.facebook.com/share/r/${code}/`,
      error: null,
    };
  }

  const shareVideoMatch = pathname.match(SHARE_VIDEO_RE);
  if (shareVideoMatch) {
    const code = shareVideoMatch[1];
    return {
      isValid: true,
      isVideo: true,
      linkType: 'profile_video',
      videoId: null,
      photoId: null,
      albumId: null,
      shortCode: code,
      sanitizedUrl: `https://www.facebook.com/share/v/${code}/`,
      error: null,
    };
  }

  // Photo share links — facebook.com/share/p/{code} (the format Facebook's
  // app produces for "Copy link" on a photo). The code is alphanumeric and
  // Facebook redirects to the photo page, so the share URL is kept as-is
  // (original host preserved — flagged IPs serve the full photo set to
  // web.facebook.com share pages but shell www./m. variants).
  const sharePhotoMatch = pathname.match(SHARE_PHOTO_RE);
  if (sharePhotoMatch) {
    const code = sharePhotoMatch[1];
    return {
      isValid: true,
      isVideo: false,
      linkType: 'photo',
      videoId: null,
      photoId: code,
      albumId: null,
      shortCode: null,
      sanitizedUrl: `https://${host}/share/p/${code}/`,
      error: null,
    };
  }

  // Profile / group post permalinks — facebook.com/{user}/posts/{pfbid…}
  // (and /permalink/), facebook.com/groups/{gid}/posts/{pfbid…}. Facebook's
  // "Copy link" for photo posts produces these; the post page HTML carries
  // the photo via og:image + "image":{"uri":…} JSON so the photo extractor
  // reads it like any photo page. The token can be a legacy numeric id or a
  // modern alphanumeric "pfbid…" token.
  const PROFILE_POST_RE = /^\/([A-Za-z0-9._-]+)\/(?:posts|permalink)\/([A-Za-z0-9_-]{8,80})\/?$/;
  const GROUP_POST_RE = /^\/groups\/([A-Za-z0-9._-]+)\/(?:posts|permalink)\/([A-Za-z0-9_-]{8,80})\/?$/;
  const postMatch =
    pathname.match(PROFILE_POST_RE) ||
    pathname.match(GROUP_POST_RE);
  if (postMatch) {
    const token = postMatch[2];
    return {
      isValid: true,
      isVideo: false,
      linkType: 'photo',
      videoId: null,
      photoId: token,
      albumId: null,
      shortCode: null,
      sanitizedUrl: `https://${host}${pathname}/`,
      error: null,
    };
  }

  // Stories — facebook.com/stories/{user_id}[/{story_token}]
  const storyMatch = pathname.match(STORY_PATH_RE);
  if (storyMatch) {
    const userId = storyMatch[2];
    const storyToken = storyMatch[3] || '';
    // Story tokens are base64 of "S:_ISC:{story_id}" — decode to the real
    // story id so we can build the classic story.php permalink, which serves
    // the story media JSON that the extractor knows how to read.
    const storyId = storyToken ? decodeStoryToken(storyToken) : '';
    // Build both URL formats: the /stories/ path (for direct fetch) and
    // the story.php query (for the classic extractor).
    const storiesUrl = `https://www.facebook.com/stories/${userId}${storyToken ? `/${storyToken}` : ''}/`;
    const storyPhpUrl = storyId
      ? `https://www.facebook.com/story.php?story_fbid=${storyId}&id=${userId}`
      : storiesUrl;
    return {
      isValid: true,
      isVideo: true,
      linkType: 'story',
      videoId: storyId || storyToken || userId,
      photoId: null,
      albumId: null,
      shortCode: null,
      sanitizedUrl: storyPhpUrl,
      // Keep the /stories/ URL available for fast-path fetching.
      storiesUrl,
      error: null,
    };
  }

  // Mobile stories — stories.php?profile_id={user_id}
  if (STORIES_PHP_PROFILE_RE.test(pathname)) {
    const profileId = parsed.searchParams.get('profile_id');
    if (profileId && /^\d{5,20}$/.test(profileId)) {
      return {
        isValid: true,
        isVideo: true,
        linkType: 'story',
        videoId: profileId,
        photoId: null,
        albumId: null,
        shortCode: null,
        sanitizedUrl: `https://www.facebook.com/stories/${profileId}/`,
        error: null,
      };
    }
    return invalid('Please include the profile ID (…stories.php?profile_id=123456) in the Facebook stories link.');
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
      photoId: null,
      albumId: null,
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
        photoId: null,
        albumId: null,
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
        photoId: null,
        albumId: null,
        shortCode: null,
        sanitizedUrl: `https://www.facebook.com/watch/live/?v=${v}`,
        error: null,
      };
    }
    return invalid('Please include the video ID (…watch/live/?v=123456789) in the Facebook link.');
  }

  // Legacy video pages — video.php / permalink.php / story.php
  if (VIDEO_PAGE_PATH_RE.test(pathname)) {
    const isStoryPhp = pathname === '/story.php' || pathname === '/permalink.php';

    // permalink.php?story_fbid=pfbid... — new Facebook obfuscated post ID.
    // story_fbid = pfbid (unique post token), id = profile/page numeric ID.
    // This is a POST permalink (may contain photos/album), route as photo.
    const storyFbid = parsed.searchParams.get('story_fbid') || '';
    if (/^pfbid/i.test(storyFbid)) {
      const profileId = parsed.searchParams.get('id') || '';
      console.error(`[FB-ALBUM-DEBUG] parseFacebookUrl: permalink.php pfbid detected: story_fbid=${storyFbid}, id=${profileId}`);
      return {
        isValid: true,
        isVideo: false,
        linkType: 'photo',
        videoId: null,
        photoId: storyFbid,
        albumId: null,
        shortCode: null,
        sanitizedUrl: `https://www.facebook.com/permalink.php/?story_fbid=${storyFbid}&id=${profileId}`,
        error: null,
      };
    }

    const id =
      parsed.searchParams.get('v') ||
      (isStoryPhp ? parsed.searchParams.get('story_fbid') : null) ||
      parsed.searchParams.get('id') ||
      parsed.searchParams.get('story_fbid');
    if (id && /^\d{5,20}$/.test(id)) {
      // story.php?story_fbid={storyId}&id={userId} is a story permalink —
      // story_fbid is the MEDIA id, id is the USER id (stories are served
      // as posts). Route it through the story pipeline so the story tool
      // accepts it and the extractor builds the classic story permalink.
      if (isStoryPhp && parsed.searchParams.get('story_fbid')) {
        const storyId = parsed.searchParams.get('story_fbid') || '';
        const userId = parsed.searchParams.get('id') || '';
        return {
          isValid: true,
          isVideo: true,
          linkType: 'story',
          videoId: storyId,
          photoId: null,
          albumId: null,
          shortCode: null,
          sanitizedUrl: `https://www.facebook.com/story.php?story_fbid=${storyId}&id=${userId}`,
          error: null,
        };
      }
      return {
        isValid: true,
        isVideo: true,
        linkType: 'video_page',
        videoId: id,
        photoId: null,
        albumId: null,
        shortCode: null,
        sanitizedUrl: `https://www.facebook.com/video.php?v=${id}`,
        error: null,
      };
    }
    return invalid('Could not find a video ID in that Facebook link.');
  }

  // Photo pages are valid Facebook content but not downloadable videos.
  // facebook.com/photo.php?fbid=…, /photo/?fbid=…, /{user}/photos/{id},
  // /{user}/photos/a.{album}/{id} and /photo/view_full_size/?id=…
  //
  // `set=pcb.{postId}` marks a photo inside a multi-photo carousel POST.
  // `set=a.{albumId}` marks a photo inside a photo ALBUM — the album page
  // (/{user}/albums/{albumId}) lists every photo in the album. When this
  // parameter is present, we store the albumId so the extractor can fetch
  // the full album instead of just the single viewed photo.
  //
  // The sanitized URL is always `photo.php?fbid={id}` — it works from any IP.
  // The extraction pipeline recovers carousel siblings via the reader proxy
  // and per-photo photo.php fetches (the old permalink.php rewrite 404s on
  // flagged IPs).
  if (PHOTO_PAGE_PATH_RE.test(pathname)) {
    const id =
      parsed.searchParams.get('fbid') ||
      parsed.searchParams.get('photo') ||
      parsed.searchParams.get('story_fbid') ||
      parsed.searchParams.get('id');
    if (id && /^\d{5,30}$/.test(id)) {
      const set = parsed.searchParams.get('set') || '';
      // set=a.{albumId} → photo inside a photo ALBUM (fetch full album)
      // set=pcb.{postId} → photo inside a multi-photo CAROUSEL POST (fetch all siblings)
      // set=p.{setId} → profile photo set (fetch all in set)
      const albumMatch = set.match(/^a\.(\d{5,30})$/);
      const pcbMatch = set.match(/^pcb\.(\d{5,30})$/);
      // Preserve pcb. prefix so fetchFacebookPhotoSet can distinguish carousel
      // posts (reader proxy path) from real albums (album fetch path).
      const albumId = pcbMatch ? `pcb.${pcbMatch[1]}` : (albumMatch?.[1] || null);
      const sanitizedUrl = `https://www.facebook.com/photo.php?fbid=${id}`;
      return {
        isValid: true,
        isVideo: false,
        linkType: 'photo',
        videoId: null,
        photoId: id,
        albumId,
        shortCode: null,
        sanitizedUrl,
        error: null,
      };
    }
    return {
      isValid: true,
      isVideo: false,
      linkType: 'photo',
      videoId: null,
      photoId: null,
      albumId: null,
      shortCode: null,
      sanitizedUrl: parsed.toString(),
      error: 'Could not find the photo ID in that Facebook link.',
    };
  }

  // Profile photo pages — facebook.com/{user}/photos/{id}, with optional
  // album prefixes (a.{album}, p.{album}, pcb.{post}, set.a.{album}) and
  // numeric albums: facebook.com/{user}/photos/{album}/{id}. The photo id is
  // always the LAST numeric path segment; trailing slug segments are dropped.
  if (PHOTO_PROFILE_BASE_RE.test(pathname)) {
    return invalid('Could not find the photo ID in that Facebook link.');
  }
  const photoProfileMatch = pathname.match(PHOTO_PROFILE_ITEM_RE);
  if (photoProfileMatch) {
    const segments = photoProfileMatch[2].split('/').filter(Boolean);
    let id = '';
    while (segments.length) {
      const seg = segments.pop() as string;
      if (/^\d{5,30}$/.test(seg)) {
        id = seg;
        break;
      }
    }
    if (id) {
      return {
        isValid: true,
        isVideo: false,
        linkType: 'photo',
        videoId: null,
        photoId: id,
        albumId: null,
        shortCode: null,
        sanitizedUrl: `https://www.facebook.com/photo.php?fbid=${id}`,
        error: null,
      };
    }
  }

  // Album pages — facebook.com/{user}/albums/{albumId} with optional
  // ?media={photoId} to view a specific photo. Without ?media=, treat
  // the entire album as downloadable content.
  const albumPageMatch = pathname.match(ALBUM_PAGE_RE);
  if (albumPageMatch) {
    const albumNumericId = albumPageMatch[2];
    const mediaId = parsed.searchParams.get('media');
    if (mediaId && /^\d{5,30}$/.test(mediaId)) {
      return {
        isValid: true,
        isVideo: false,
        linkType: 'photo',
        videoId: null,
        photoId: mediaId,
        albumId: albumNumericId,
        shortCode: null,
        sanitizedUrl: `https://www.facebook.com/photo.php?fbid=${mediaId}`,
        error: null,
      };
    }
    // Album page without ?media= — treat as album download
    return {
      isValid: true,
      isVideo: false,
      linkType: 'photo',
      videoId: null,
      photoId: null,
      albumId: albumNumericId,
      shortCode: null,
      sanitizedUrl: `https://www.facebook.com/albums/${albumNumericId}`,
      error: null,
    };
  }

  // Direct album link without user prefix — facebook.com/albums/{albumId}
  const albumDirectMatch = pathname.match(ALBUM_DIRECT_RE);
  if (albumDirectMatch) {
    const albumNumericId = albumDirectMatch[1];
    const mediaId = parsed.searchParams.get('media');
    if (mediaId && /^\d{5,30}$/.test(mediaId)) {
      return {
        isValid: true,
        isVideo: false,
        linkType: 'photo',
        videoId: null,
        photoId: mediaId,
        albumId: albumNumericId,
        shortCode: null,
        sanitizedUrl: `https://www.facebook.com/photo.php?fbid=${mediaId}`,
        error: null,
      };
    }
    return {
      isValid: true,
      isVideo: false,
      linkType: 'photo',
      videoId: null,
      photoId: null,
      albumId: albumNumericId,
      shortCode: null,
      sanitizedUrl: `https://www.facebook.com/albums/${albumNumericId}`,
      error: null,
    };
  }

  // Photo viewer page — facebook.com/photo/view_full_size/?id={id}
  if (PHOTO_VIEW_FULL_RE.test(pathname)) {
    const id = parsed.searchParams.get('id') || parsed.searchParams.get('fbid');
    if (id && /^\d{5,30}$/.test(id)) {
      return {
        isValid: true,
        isVideo: false,
        linkType: 'photo',
        videoId: null,
        photoId: id,
        albumId: null,
        shortCode: null,
        sanitizedUrl: `https://www.facebook.com/photo.php?fbid=${id}`,
        error: null,
      };
    }
  }

  return invalid(
    'Please enter a valid Facebook link (video, reel, story or photo — e.g. facebook.com/reel/…, facebook.com/watch/?v=…, fb.watch/…, facebook.com/photo.php?fbid=…, facebook.com/share/p/…, facebook.com/{profile}/posts/…).'
  );
}

export function isValidFacebookVideoUrl(rawUrl: string): boolean {
  const parsed = parseFacebookUrl(rawUrl);
  return parsed.isValid && parsed.isVideo;
}
