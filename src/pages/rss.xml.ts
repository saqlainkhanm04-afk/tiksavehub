import type { APIRoute } from 'astro';
import { posts } from '../data/blog-posts';

export const prerender = true;

const site = 'https://tiksavehub.com';

export const GET: APIRoute = () => {
  const items = posts.map((post) => `
    <item>
      <title><![CDATA[${post.title}]]></title>
      <link>${site}/blog/${post.slug}</link>
      <guid isPermaLink="true">${site}/blog/${post.slug}</guid>
      <description><![CDATA[${post.excerpt}]]></description>
      <category>${post.category}</category>
      <pubDate>${new Date(post.date).toUTCString()}</pubDate>
      <enclosure url="${site}${post.cover}" type="image/svg+xml" />
    </item>`).join('\n');

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>TikSaveHub Blog — Video Downloader Guides &amp; Tutorials</title>
    <link>${site}</link>
    <description>Guides, tips, and tutorials for downloading videos from TikTok, Instagram, Facebook, and X (Twitter) in HD quality without watermarks.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${site}/rss.xml" rel="self" type="application/rss+xml" />
    <image>
      <url>${site}/web-app-manifest-192x192.png</url>
      <title>TikSaveHub</title>
      <link>${site}</link>
    </image>${items}
  </channel>
</rss>`;

  return new Response(rss, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
