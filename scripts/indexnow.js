// IndexNow pinger — submits every URL from the live sitemap to indexnow.org.
//
// Usage:
//   node scripts/indexnow.js          # fetch sitemap from the live site
//   node scripts/indexnow.js --local  # read sitemap files from dist/ instead
//   npm run indexnow
//
// Key file: public/<key>.txt must be served at
//   https://tiksavehub.com/<key>.txt  (IndexNow hosts the key for us).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = 'https://tiksavehub.com';
const HOST = 'tiksavehub.com';
const KEY = process.env.INDEXNOW_KEY ?? 'd36fb3cc3f7e47c3baf2c076c12899da';
const KEY_LOCATION = `${SITE}/${KEY}.txt`;
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const CHUNK_SIZE = 10_000; // IndexNow hard limit per submission

const local = process.argv.includes('--local');

/** Extract <loc>…</loc> URLs from sitemap XML. */
function locs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

/** All sitemap URLs the site exposes (index → child sitemaps → page URLs). */
async function collectUrls() {
  if (local) {
    // Build output lives in dist/client/ (sitemap-index.xml created there).
    const dir = join(process.cwd(), 'dist', 'client');
    const files = readdirSync(dir).filter((f) => /^sitemap.*\.xml$/.test(f));
    if (files.length === 0) throw new Error('no sitemap*.xml found in dist/ — run npm run build first');
    const urls = new Set();
    for (const f of files) for (const u of locs(readFileSync(join(dir, f), 'utf8'))) urls.add(u);
    return [...urls];
  }

  const indexRes = await fetch(`${SITE}/sitemap-index.xml`, {
    headers: { 'User-Agent': 'tiksavehub-indexnow/1.0' },
  });
  if (!indexRes.ok) throw new Error(`sitemap-index.xml → HTTP ${indexRes.status}`);
  const children = locs(await indexRes.text());

  const urls = new Set();
  for (const child of children) {
    const res = await fetch(child, { headers: { 'User-Agent': 'tiksavehub-indexnow/1.0' } });
    if (!res.ok) {
      console.warn(`skip ${child} — HTTP ${res.status}`);
      continue;
    }
    for (const u of locs(await res.text())) urls.add(u);
  }
  return [...urls];
}

async function ping(urlList) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: HOST,
      key: KEY,
      keyLocation: KEY_LOCATION,
      urlList,
    }),
  });
  const text = (await res.text()).trim();
  // 200 = submitted, 202 = received (key will be checked later)
  console.log(`HTTP ${res.status}${text ? ` — ${text}` : ''} (${urlList.length} URLs)`);
  return res.ok;
}

const urls = await collectUrls();
console.log(`Collected ${urls.length} URLs from ${local ? 'dist/ sitemaps' : `${SITE}/sitemap-index.xml`}`);

let ok = true;
for (let i = 0; i < urls.length; i += CHUNK_SIZE) {
  const chunk = urls.slice(i, i + CHUNK_SIZE);
  ok = (await ping(chunk)) && ok;
}
process.exit(ok ? 0 : 1);
