// Regression guards for the SEO fixes:
//   1. Internal links must not end with a slash (trailingSlash: 'never').
//   2. Prerendered pages must self-reference their canonical URL.
//   3. Blog metaTitles must not truncate to a tool page's exact head term.
//
// Run after `npm run build`:  npm run check:regressions

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SITE = 'https://tiksavehub.com';
const CLIENT_DIR = join(ROOT, 'dist/client');
const failures = [];
const warnings = [];

function walk(dir, extension) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, extension));
    else if (full.endsWith(extension)) out.push(full);
  }
  return out;
}

function rel(file) {
  return relative(ROOT, file).replace(/\\/g, '/');
}

function routeFromHtml(file) {
  let route = '/' + relative(CLIENT_DIR, file).replace(/\\/g, '/');
  route = route.replace(/index\.html$/, '').replace(/\.html$/, '');
  route = route.replace(/\/+$/, '');
  return route || '/';
}

function normalizedPath(value) {
  const path = value.split(/[?#]/)[0].replace(/\/+$/, '');
  return path || '/';
}

function checkBuiltHtml() {
  if (!existsSync(CLIENT_DIR)) {
    warnings.push('dist/client not found — run npm run build before this check.');
    return;
  }

  const htmlFiles = walk(CLIENT_DIR, '.html');
  for (const file of htmlFiles) {
    const html = readFileSync(file, 'utf8');
    const expected = routeFromHtml(file);

    const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i);
    if (!canonical) {
      failures.push(`${rel(file)}: missing canonical`);
    } else {
      let canonicalPath;
      try {
        canonicalPath = normalizedPath(new URL(canonical[1], SITE).pathname);
      } catch {
        canonicalPath = canonical[1];
      }
      if (canonicalPath !== normalizedPath(expected)) {
        failures.push(`${rel(file)}: canonical ${canonicalPath} does not match route ${expected}`);
      }
    }

    for (const match of html.matchAll(/\bhref="([^"]+)"/gi)) {
      const href = match[1];
      if (!href.startsWith('/') || href.startsWith('//') || href === '/') continue;
      if (href.startsWith('/#') || href.startsWith('/api/')) continue;
      if (/\.(?:png|jpe?g|webp|gif|svg|ico|xml|txt|css|js|json|woff2?|mp4|webm)$/i.test(href)) continue;
      const path = href.split(/[?#]/)[0];
      if (path !== '/' && path.endsWith('/')) {
        failures.push(`${rel(file)}: trailing-slash internal link ${href}`);
      }
    }
  }
}

async function checkBlogTitles() {
  const { posts } = await import(pathToFileURL(join(ROOT, 'src/data/blog-posts.js')).href);
  const { seoTitle } = await import(pathToFileURL(join(ROOT, 'src/lib/seo.ts')).href);

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

  function pageFile(path) {
    return path === '/'
      ? join(ROOT, 'src/pages/index.astro')
      : join(ROOT, 'src/pages', `${path.slice(1)}.astro`);
  }

  function layoutTitle(file) {
    if (!existsSync(file)) return null;
    const source = readFileSync(file, 'utf8');
    const match = source.match(/<Layout\b[\s\S]*?\btitle="([^"]+)"/);
    return match?.[1] ?? null;
  }

  const toolTitles = [];
  for (const path of seoPages) {
    const title = layoutTitle(pageFile(path));
    if (title) toolTitles.push({ path, title, head: title.split(/\s+[-|]\s+/)[0].trim() });
  }

  const normalize = (value) => value.toLowerCase().replace(/\s+/g, ' ').trim();

  for (const post of posts) {
    const raw = post.metaTitle ?? `${post.title} - TikSaveHub Blog`;
    const rendered = seoTitle(raw);
    for (const tool of toolTitles) {
      if (normalize(rendered) === normalize(tool.title)) {
        failures.push(`blog/${post.slug}: title duplicates ${tool.path}`);
      } else if (normalize(rendered) === normalize(tool.head)) {
        failures.push(`blog/${post.slug}: title truncates to tool head term for ${tool.path}`);
      }
    }
  }
}

checkBuiltHtml();
await checkBlogTitles();

for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const failure of failures) console.error(`FAIL ${failure}`);

if (failures.length) {
  console.error(`\n${failures.length} regression(s) found.`);
  process.exitCode = 1;
} else {
  console.log('Regression checks passed.');
}
