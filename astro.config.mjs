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

const site = 'https://tiksavehub.com';
const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Map a sitemap URL back to the source file that actually holds its content.
// Sitemap <lastmod> then reflects the real file edit time instead of the build
// time, so a deploy that only changes code no longer marks every page as fresh.
/**
 * @param {string} pathname
 * @returns {string | undefined}
 */
function sitemapSourceFor(pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+|\/+$/g, '');
  if (!clean) return join(projectRoot, 'src/pages/index.astro');

  // Blog post bodies live in one data module, not in individual page files.
  if (clean.startsWith('blog/')) return join(projectRoot, 'src/data/blog-posts.js');

  const candidates = [
    join(projectRoot, 'src/pages', `${clean}.astro`),
    join(projectRoot, 'src/pages', clean, 'index.astro'),
    join(projectRoot, 'src/pages', `${clean}.md`),
    join(projectRoot, 'src/pages', clean, 'index.md'),
  ];
  return candidates.find((file) => existsSync(file));
}

/**
 * @param {string} url
 * @returns {Date | undefined}
 */
function sitemapLastmod(url) {
  const source = sitemapSourceFor(new URL(url).pathname);
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
  // Localized pages for all languages.
  // Locale homepages must be emitted as /de (not /de/) to match trailingSlash: 'never'.
  ...['es', 'ja', 'fr', 'de', 'pt', 'ko', 'it'].flatMap((lang) =>
    seoPages.map((p) => `${site}/${lang}${p === '/' ? '' : p}`)
  ),
];

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
      // Per-URL <lastmod> from the source file's modification time. If a page
      // has no resolvable source file we leave lastmod out rather than lie
      // with the build timestamp.
      serialize: (item) => {
        const lastmod = sitemapLastmod(item.url);
        return lastmod ? { ...item, lastmod: lastmod.toISOString() } : item;
      },
      filter: (page) => {
        const { pathname } = new URL(page);
        if (pathname === '/404' || pathname === '/500') return false;
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
