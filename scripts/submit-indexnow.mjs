import { posts } from '../src/data/blog-posts.js';

const SITE = 'https://tiksavehub.com';
const HOST = 'tiksavehub.com';
const KEY = process.env.INDEXNOW_KEY ?? 'd36fb3cc3f7e47c3baf2c076c12899da';

const seoPages = [
  '/',
  '/tiktok-video-downloader-without-watermark',
  '/tiktok-to-mp3',
  '/instagram-video-downloader-without-watermark',
  '/instagram-reels-downloader-without-watermark',
  '/instagram-story-downloader-without-watermark',
  '/instagram-audio-downloader',
  '/blog',
  '/contact',
  '/privacy',
  '/terms',
  '/dmca',
];

const urlList = Array.from(
  new Set([
    SITE,
    ...seoPages.map((p) => SITE + p),
    ...posts.map((p) => `${SITE}/blog/${p.slug}`),
  ])
);

const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: KEY, urlList }),
});

console.log(`HTTP ${response.status} — ${urlList.length} URLs`);
console.log(await response.text());