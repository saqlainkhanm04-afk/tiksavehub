const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Instagram 219.0.0.12.117 Android (23/6.0; 420dpi; 1080x2310; Meizu; Meizu 16; meizu16; zh_CN; 62401037)';
const INSTAGRAM_GRAPHQL = 'https://www.instagram.com/graphql/query';
const INSTAGRAM_HOME = 'https://www.instagram.com/';
const INSTAGRAM_API = 'https://i.instagram.com/api/v1';

async function getCsrf(): Promise<{ token: string; cookies: string }> {
  const resp = await fetch(INSTAGRAM_HOME, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  const setCookies = resp.headers.getSetCookie();
  const csrfCookie = setCookies.find((c) => c.startsWith('csrftoken='));
  const token = csrfCookie ? csrfCookie.split(';')[0].replace('csrftoken=', '') : '';
  const cookies = setCookies.map((c) => c.split(';')[0]).join('; ');
  console.log('csrf token:', token ? token.slice(0, 12) + '...' : '(empty)', '| cookies:', cookies.slice(0, 60));
  return { token, cookies };
}

async function graphql(docId: string, variables: object) {
  const { token, cookies } = await getCsrf();
  const resp = await fetch(INSTAGRAM_GRAPHQL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': token,
      Cookie: cookies,
      Accept: '*/*',
      Origin: 'https://www.instagram.com',
      Referer: 'https://www.instagram.com/',
    },
    body: new URLSearchParams({ doc_id: docId, variables: JSON.stringify(variables), server_timestamps: 'true' }),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await resp.text();
  console.log(`  status: ${resp.status} len: ${text.length}`);
  return text.slice(0, 800);
}

async function privateApi(path: string) {
  const resp = await fetch(`${INSTAGRAM_API}${path}`, {
    headers: {
      'User-Agent': MOBILE_UA,
      Accept: 'application/json, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-IG-Capabilities': '3brTvw==',
      'X-IG-Connection-Type': 'WIFI',
      'X-IG-App-ID': '567067343352427',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.instagram.com',
      Referer: 'https://www.instagram.com/stories/',
    },
    signal: AbortSignal.timeout(25_000),
  });
  const text = await resp.text();
  console.log(`  status: ${resp.status} len: ${text.length}`);
  return text.slice(0, 400);
}

console.log('=== 1. GraphQL media_info (4740221914432035) fresh cookies ===');
console.log(await graphql('4740221914432035', { media_id: '1234567890123456789', should_track_viewed: false }));

console.log('\n=== 2. private users/web_profile_info anonymously ===');
console.log(await privateApi('/users/web_profile_info/?username=instagram'));

console.log('\n=== 3. private reels_media anonymously ===');
console.log(await privateApi('/feed/reels_media/?reel_ids=25025320'));

console.log('\n=== 4. GraphQL with newer doc id guesses ===');
for (const docId of ['9645755436008956', '7150336596929834', '2721935559717057']) {
  console.log(`doc ${docId}:`);
  console.log(await graphql(docId, { shortcode: 'CYNqg7yIVO3' }));
}