// Shared 301 path-redirect map.
//
// Sources:
// 1. Legacy slug redirects (mirrors public/_redirects for the SSR Cloudflare
//    Worker, where _redirects is not processed).
// 2. Double locale prefix (Google crawled "/de/de/facebook-story-downloader"
//    from pre-prefixed internal links): collapse to a single locale.
// 3. Localized blog posts only exist in English ("/de/blog/{slug}" -> "/blog/{slug}").
//
// Dependency-free so it can be unit-tested with plain Node.

export const LOCALES = ['es', 'ja', 'fr', 'de', 'pt', 'ko', 'it'] as const;

const DOUBLE_LOCALE_RE = new RegExp(`^/(${LOCALES.join('|')})/\\1(?:/(.*))?$`);

const LOCALIZED_BLOG_RE = new RegExp(`^/(${LOCALES.join('|')})/blog/(.+)$`);

export const LEGACY_PATH_REDIRECTS: ReadonlyArray<readonly [string, string]> = [
  ['/tiktok-video-downloader', '/tiktok-video-downloader-without-watermark'],
  ['/instagram-reels-downloader', '/instagram-reels-downloader-without-watermark'],
  ['/instagram-video-downloader', '/instagram-video-downloader-without-watermark'],
  ['/instagram-story-downloader', '/instagram-story-downloader-without-watermark'],
] as const;

export function resolvePathRedirect(pathname: string): string | null {
  for (const [from, to] of LEGACY_PATH_REDIRECTS) {
    if (pathname === from) return to;
  }

  const double = pathname.match(DOUBLE_LOCALE_RE);
  if (double) return `/${double[1]}/${double[2] ?? ''}`;

  const blog = pathname.match(LOCALIZED_BLOG_RE);
  if (blog) return `/blog/${blog[2]}`;

  return null;
}