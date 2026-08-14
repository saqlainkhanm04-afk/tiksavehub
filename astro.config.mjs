// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
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
  '/blog',
  '/contact',
  '/privacy',
  '/terms',
  '/dmca',
];

const customPages = [
  ...seoPages.map((p) => site + p),
  ...posts.map((p) => `${site}/blog/${p.slug}`),
];

export default defineConfig({
  site,
  output: 'server',
  server: { port: 3000 },
  adapter: node({
    mode: 'standalone',
  }),
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
