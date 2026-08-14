import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posts } from '../src/data/blog-posts.js';

const SITE = 'https://tiksavehub.com';
const SCOPES = 'https://www.googleapis.com/auth/indexing';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const INDEXING_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';

const SERVICE_ACCOUNT_FILE =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? 'service-account.json';
const TYPE = process.env.GOOGLE_INDEXING_TYPE ?? 'URL_UPDATED'; // or URL_DELETED

const seoPages = [
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

const customUrls = process.argv
  .filter((a) => a.startsWith('--urls='))
  .flatMap((a) => a.slice('--urls='.length).split(','))
  .map((u) => (u.startsWith('http') ? u : SITE + u));

const urlList = Array.from(
  new Set(
    customUrls.length > 0
      ? customUrls
      : [SITE, ...seoPages.map((p) => SITE + p), ...posts.map((p) => `${SITE}/blog/${p.slug}`)]
  )
);

const base64Url = (data) =>
  Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function signJwt(privateKey, claims) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${base64Url(header)}.${base64Url(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey, 'base64');
  const signatureUrlSafe = signature.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signingInput}.${signatureUrlSafe}`;
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope: SCOPES,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const jwt = signJwt(serviceAccount.private_key, claims);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function notify(token, url) {
  const res = await fetch(INDEXING_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ url, type: TYPE }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_FILE, 'utf8'));
} catch (err) {
  console.error(
    `Could not read service account file "${SERVICE_ACCOUNT_FILE}". ` +
      'Create one in Google Cloud Console (APIs & Services → Credentials → Service Account → Keys) and set GOOGLE_SERVICE_ACCOUNT_JSON to its path.\n' +
      'Enable the Web Search Indexing API first: https://console.cloud.google.com/apis/library/indexing.googleapis.com'
  );
  process.exit(1);
}

if (!serviceAccount.client_email || !serviceAccount.private_key) {
  console.error('Service account JSON is missing client_email or private_key.');
  process.exit(1);
}

console.log(`Getting OAuth token for ${serviceAccount.client_email}...`);
const token = await getAccessToken(serviceAccount);

console.log(`Notifying Google (${TYPE}) for ${urlList.length} URLs...`);
let ok = 0;
let failed = 0;

for (const url of urlList) {
  try {
    const { ok: success, status, body } = await notify(token, url);
    if (success) {
      ok++;
      console.log(`OK  ${status}  ${url}`);
    } else {
      failed++;
      console.log(`ERR ${status}  ${url}  ${body}`);
      if (status === 403 && body.includes('Only the owner')) {
        console.error(
          '\nPermissions missing: open Google Search Console, add your service account email ' +
            `(${serviceAccount.client_email}) as a user with "Full" permission on ${SITE}, then retry.`
        );
        break;
      }
      if (status === 429) {
        console.error('\nQuota exceeded. The Indexing API allows ~200 URLs/day. Retry later.');
        break;
      }
    }
  } catch (err) {
    failed++;
    console.log(`ERR ${url}  ${err.message}`);
  }
}

console.log(`\nDone. ${ok} succeeded, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
