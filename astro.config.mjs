// @ts-check
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import { posts } from './src/data/blog-posts.js';
import { postsByLang } from './src/data/blog-i18n/index.js';
import { isNoindexedPath } from './src/lib/indexing.js';

const site = 'https://tiksavehub.com';
const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Map a sitemap URL back to the source file that actually holds its content.
// Non-blog pages use the real file edit time; blog posts use their own
// published/updated date (see sitemapLastmod) instead of the shared data file's
// mtime, so each post carries a truthful lastmod.
/**
 * @param {string} pathname
 * @returns {string | undefined}
 */
function sitemapSourceFor(pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+|\/+$/g, '');
  if (!clean) return join(projectRoot, 'src/pages/index.astro');

  // Blog post bodies live in one data module, not in individual page files.
  if (clean.startsWith('blog/')) return join(projectRoot, 'src/data/blog-posts.js');
  const localizedBlog = clean.match(/^(es|ja|fr|de|pt|ko|it)\/blog\//);
  if (localizedBlog) {
    return join(projectRoot, `src/data/blog-i18n/${localizedBlog[1]}.js`);
  }

  const candidates = [
    join(projectRoot, 'src/pages', `${clean}.astro`),
    join(projectRoot, 'src/pages', clean, 'index.astro'),
    join(projectRoot, 'src/pages', `${clean}.md`),
    join(projectRoot, 'src/pages', clean, 'index.md'),
  ];
  return candidates.find((file) => existsSync(file));
}

/** Blog post URL -> its own published or updated date. */
const BLOG_POST_DATES = new Map(
  [
    ...posts.map((post) => [`/blog/${post.slug}`, post.updated ?? post.date]),
    ...Object.entries(postsByLang).flatMap(([lang, list]) =>
      list.map((post) => [`/${lang}/blog/${post.slug}`, post.updated ?? post.date])
    ),
  ].filter(([, date]) => Boolean(date))
);

/**
 * @param {string} url
 * @returns {Date | undefined}
 */
function sitemapLastmod(url) {
  const pathname = new URL(url).pathname;
  const blogDate = BLOG_POST_DATES.get(pathname);
  if (blogDate) {
    const parsed = new Date(blogDate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const source = sitemapSourceFor(pathname);
  if (!source) return undefined;
  try {
    return new Date(statSync(source).mtimeMs);
  } catch {
    return undefined;
  }
}

const seoPages = [
  '/',
  '/tiktok-video-downloader-without-watermark',
  '/tiktok-to-mp3',
  '/instagram-video-downloader-without-watermark',
  '/instagram-reels-downloader-without-watermark',
  '/instagram-story-downloader-without-watermark',
  '/instagram-audio-downloader',
  '/facebook-video-downloader',
  '/facebook-reels-downloader',
  '/facebook-to-mp3',
  '/facebook-story-downloader',
  '/facebook-photo-downloader',
  '/x-video-downloader',
  '/snapchat-downloader',
  '/snapchat-story-downloader',
  '/snapchat-to-mp3',
  '/blog',
];

const customPages = [
  ...seoPages.map((p) => site + p),
  ...posts.map((p) => `${site}/blog/${p.slug}`),
  // English-only trust/E-E-A-T pages (no localized variants exist).
  `${site}/about`,
  `${site}/authors/samneil`,
  `${site}/editorial-policy`,
  // English-only focused tool pages (no localized variants exist).
  `${site}/tiktok-thumbnail-downloader`,
  `${site}/instagram-profile-picture-downloader`,
  `${site}/tiktok-comment-downloader`,
  // Snapchat comparison pages (English + localized).
  `${site}/compare/snapchat-vs-tiktok-downloader`,
  // Localized pages for all languages.
  // Locale homepages must be emitted as /de (not /de/) to match trailingSlash: 'never'.
  ...['es', 'ja', 'fr', 'de', 'pt', 'ko', 'it'].flatMap((lang) => [
    ...seoPages.map((p) => `${site}/${lang}${p === '/' ? '' : p}`),
    `${site}/${lang}/compare/snapchat-vs-tiktok-downloader`,
  ]),
  // Localized Snapchat blog posts (different slugs per language).
  ...Object.entries(postsByLang).flatMap(([lang, list]) =>
    list.map((p) => `${site}/${lang}/blog/${p.slug}`)
  ),
].filter((url) => !isNoindexedPath(new URL(url).pathname));

const isProd = process.argv.includes('build') || process.argv.includes('preview');

export default defineConfig({
  site,
  output: 'server',
  trailingSlash: 'never',
  adapter: isProd ? cloudflare({ imageService: 'compile' }) : node({ mode: 'standalone' }),
  server: { port: 3000 },
  integrations: [
    sitemap({
      customPages,
      // Per-URL <lastmod>: blog posts use their own published/updated date;
      // other pages use the source file's modification time. If neither is
      // available we leave lastmod out rather than lie with the build time.
      serialize: (item) => {
        const lastmod = sitemapLastmod(item.url);
        return lastmod ? { ...item, lastmod: lastmod.toISOString() } : item;
      },
      filter: (page) => {
        const { pathname } = new URL(page);
        if (pathname === '/404' || pathname === '/500') return false;
        if (isNoindexedPath(pathname)) return false;
        if (pathname === '/') return true;
        if (pathname.endsWith('/')) {
          // Locale homepages like /de/ are a single segment ending in a slash.
          const segments = pathname.split('/').filter(Boolean);
          return segments.length === 1;
        }
        return true;
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    server: {
      watch: {
        ignored: ['**/data/**'],
      },
    },
  },
});
