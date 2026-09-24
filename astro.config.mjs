// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import { posts } from './src/data/blog-posts.js';

const site = 'https://tiksavehub.com';

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
  // Localized pages for all languages
  ...['es', 'ja', 'fr', 'de', 'pt', 'ko', 'it'].flatMap((lang) =>
    seoPages.map((p) => `${site}/${lang}${p}`)
  ),
];

const isProd = process.argv.includes('build') || process.argv.includes('preview');

export default defineConfig({
  site,
  output: 'server',
  adapter: isProd ? cloudflare({ imageService: 'compile' }) : node({ mode: 'standalone' }),
  server: { port: 3000 },
  integrations: [
    sitemap({
      customPages,
      filter: (page) => {
        const { pathname } = new URL(page);
        if (pathname === '/404' || pathname === '/500') return false;
        return pathname === '/' || !pathname.endsWith('/');
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
