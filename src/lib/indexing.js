// Central, reversible indexation policy.
//
// Keep every noindex decision in this one file so a URL can be removed from the
// index (and from the sitemap/hreflang graph) without touching page components.
// All paths are root-relative and are normalized without a trailing slash.
//
// Rule: the English site, the seven locale homepages, and the 17 localized
// pages in keepIndexedTranslatedToolPages are indexable. Every other localized
// page is noindexed automatically and removed from the sitemap and hreflang
// clusters. To reverse, add or remove paths from the keep list below.

export const INDEXING_POLICY = {
  // Optional exact-path noindex list (kept for future owner-supplied URLs).
  noindexPaths: [],

  // Never noindex these paths. The seven locale homepages are protected.
  keepIndexedPaths: ['/', '/es', '/ja', '/fr', '/de', '/pt', '/ko', '/it'],

  // The only localized tool/utility pages allowed to stay indexable.
  keepIndexedTranslatedToolPages: [
    '/ko/snapchat-downloader',
    '/it/facebook-reels-downloader',
    '/fr/facebook-to-mp3',
    '/de/facebook-video-downloader',
    '/it/facebook-story-downloader',
    '/ja/facebook-reels-downloader',
    '/pt/snapchat-downloader',
    '/pt/facebook-to-mp3',
    '/es/facebook-reels-downloader',
    '/ja/dmca',
    '/fr/facebook-reels-downloader',
    '/ko/facebook-to-mp3',
    '/de/facebook-story-downloader',
    '/es/tiktok-to-mp3',
    '/es/snapchat-downloader',
    '/de/facebook-photo-downloader',
    '/ja/facebook-photo-downloader',
  ],
};

const LOCALIZED_PREFIX_RE = /^\/(?:es|ja|fr|de|pt|ko|it)(?:\/|$)/;

/** @param {string} pathname */
export function normalizeIndexPath(pathname) {
  const clean = String(pathname || '/').split(/[?#]/)[0].replace(/\/+$/, '');
  return clean || '/';
}

/** @param {string} pathname */
export function isNoindexedPath(pathname) {
  const path = normalizeIndexPath(pathname);

  // English pages stay indexable (noindexPaths is empty by default).
  if (!LOCALIZED_PREFIX_RE.test(path)) {
    return INDEXING_POLICY.noindexPaths.includes(path);
  }

  if (INDEXING_POLICY.keepIndexedPaths.includes(path)) return false;
  if (INDEXING_POLICY.keepIndexedTranslatedToolPages.includes(path)) return false;

  // Every other localized path — tool, utility, blog, compare, or unknown.
  return true;
}
