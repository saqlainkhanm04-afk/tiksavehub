// Shared 301 path-redirect map.
//
// Sources:
// 1. Legacy slug redirects (mirrors public/_redirects for the SSR Cloudflare
//    Worker, where _redirects is not processed).
// 2. Double locale prefix (Google crawled "/de/de/facebook-story-downloader"
//    from pre-prefixed internal links): collapse to a single locale.
// 3. Localized blog posts: only redirect /{lang}/blog/{slug} to English when
//    {slug} is NOT a real localized post for that language. Real localized
//    posts (e.g. /de/blog/snapchat-videos-ohne-wasserzeichen-herunterladen)
//    must serve their own page, not bounce to English.

import { postsByLang } from '../data/blog-i18n/index.js';

export const LOCALES = ['es', 'ja', 'fr', 'de', 'pt', 'ko', 'it'] as const;

const DOUBLE_LOCALE_RE = new RegExp(`^/(${LOCALES.join('|')})/\\1(?:/(.*))?$`);

const LOCALIZED_BLOG_RE = new RegExp(`^/(${LOCALES.join('|')})/blog/(.+)$`);

export const LEGACY_PATH_REDIRECTS: ReadonlyArray<readonly [string, string]> = [
  ['/tiktok-video-downloader', '/tiktok-video-downloader-without-watermark'],
  ['/instagram-reels-downloader', '/instagram-reels-downloader-without-watermark'],
  ['/instagram-video-downloader', '/instagram-video-downloader-without-watermark'],
  ['/instagram-story-downloader', '/instagram-story-downloader-without-watermark'],
  // Keyword-cannibalization cleanup: the two TikTok blog posts were renamed to
  // informational/long-tail slugs (they used to compete with the tool page for
  // "TikTok video downloader").
  ['/blog/tiktok-video-downloader-without-watermark', '/blog/how-to-download-tiktok-videos'],
  ['/blog/best-tiktok-video-downloader-2026', '/blog/tiktok-downloader-troubleshooting'],
] as const;

/** Slugs that exist as localized posts, keyed by language code. */
const LOCALIZED_BLOG_SLUGS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(postsByLang ?? {}).map(([lang, list]) => [
    lang,
    new Set((list ?? []).map((p) => p.slug)),
  ])
);

export function resolvePathRedirect(pathname: string): string | null {
  for (const [from, to] of LEGACY_PATH_REDIRECTS) {
    if (pathname === from) return to;
  }

  const double = pathname.match(DOUBLE_LOCALE_RE);
  // Land directly on the canonical no-slash URL ("/de", not "/de/") so the
  // hop is a single 301 instead of 301 → 307 trailing-slash chain.
  if (double) return double[2] ? `/${double[1]}/${double[2]}` : `/${double[1]}`;

  const blog = pathname.match(LOCALIZED_BLOG_RE);
  if (blog) {
    const lang = blog[1];
    // Strip any trailing slash so the redirect target is the canonical URL.
    const slug = blog[2].replace(/\/+$/, '');
    if (!slug) return `/${lang}/blog`;
    // Real localized post: only redirect if the request carried a trailing
    // slash (single hop to canonical); unknown slug: send to English.
    if (LOCALIZED_BLOG_SLUGS[lang]?.has(slug)) {
      return pathname.endsWith('/') ? `/${lang}/blog/${slug}` : null;
    }
    return `/blog/${slug}`;
  }

  return null;
}
