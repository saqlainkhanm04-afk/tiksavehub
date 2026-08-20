import http from 'node:http';

process.env.IG_SESSIONID = 'mock-session-123';
process.env.IG_DS_USER_ID = '25025320';
process.env.IG_CSRF_TOKEN = 'mock-csrf';

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://mock');
  const path = url.pathname;
  res.setHeader('Content-Type', 'application/json');
  const send = (code: number, obj: unknown) => {
    res.statusCode = code;
    res.end(JSON.stringify(obj));
  };

  if (path === '/api/v1/users/web_profile_info/') {
    return send(200, {
      data: { user: { id: '25025320', username: 'instagram', is_private: false } },
      status: 'ok',
    });
  }

  if (path === '/api/v1/feed/reels_media/') {
    const reelId = url.searchParams.get('reel_ids') || '';
    return send(200, {
      reels: {
        [reelId]: {
          items: [
            {
              media_id: '9999999999999999999',
              media_type: 2,
              video_versions: [{ url: 'https://scontent.mock/story-video.mp4', width: 1080, height: 1920 }],
              image_versions2: { candidates: [{ url: 'https://scontent.mock/story-cover.jpg' }] },
              video_duration: 12.5,
              user: { username: 'instagram', full_name: 'Instagram', profile_pic_url: 'https://scontent.mock/avatar.jpg' },
            },
            {
              media_id: '8888888888888888888',
              media_type: 1,
              image_versions2: { candidates: [{ url: 'https://scontent.mock/story-photo.jpg', width: 1080, height: 1920 }] },
              display_url: 'https://scontent.mock/story-photo.jpg',
              user: { username: 'instagram', full_name: 'Instagram' },
            },
          ],
        },
      },
      status: 'ok',
    });
  }

  if (path.startsWith('/api/v1/media/')) {
    return send(200, {
      items: [
        {
          media_id: '1234567890123456789',
          media_type: 2,
          video_versions: [{ url: 'https://scontent.mock/direct-video.mp4', width: 720, height: 1280 }],
          user: { username: 'someone' },
        },
      ],
      status: 'ok',
    });
  }

  send(404, { message: 'not found' });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as any).port as number;

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const u = String(input);
  if (u.startsWith('https://www.instagram.com/')) {
    return realFetch(u.replace('https://www.instagram.com', `http://127.0.0.1:${port}`), init);
  }
  if (u.startsWith('https://i.instagram.com/')) {
    return realFetch(u.replace('https://i.instagram.com/', `http://127.0.0.1:${port}/`), init);
  }
  if (u.startsWith('https://scontent.mock/')) {
    const body = u.includes('story-photo.jpg') ? 'JPEGDATA-PHOTO' : 'MP4DATA-VIDEO';
    return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'video/mp4' } }));
  }
  return realFetch(input, init);
}) as typeof fetch;

const { GET } = await import('../src/pages/api/instagram-download.ts');

let pass = 0;
let fail = 0;
function check(name: string, got: any, expect: any) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name} — got: ${JSON.stringify(got)} expected: ${JSON.stringify(expect)}`);
  }
}

async function apiGet(url: string): Promise<Response> {
  return (GET as any)({ url: new URL(url, 'http://x'), request: new Request(url) });
}

// E2E 1: video story -> metadata JSON
let res = await apiGet('http://x/api/instagram-download?url=https://www.instagram.com/stories/instagram/9999999999999999999/&type=story');
let body = JSON.parse(await res.text());
check('E2E-1 status', res.status, 200);
check('E2E-1 type', body.type, 'story');
check('E2E-1 video url', body.video?.play, 'https://scontent.mock/story-video.mp4');
check('E2E-1 not photo', body.video?.isPhoto ?? false, false);
check('E2E-1 username', body.video?.author?.unique_id, 'instagram');

// E2E 2: photo story -> isPhoto + image url
res = await apiGet('http://x/api/instagram-download?url=https://www.instagram.com/stories/instagram/8888888888888888888/&type=story');
body = JSON.parse(await res.text());
check('E2E-2 status', res.status, 200);
check('E2E-2 isPhoto', body.video?.isPhoto, true);
check('E2E-2 photo url', body.video?.play, 'https://scontent.mock/story-photo.jpg');

// E2E 3: download a video story -> MP4 stream
res = await apiGet('http://x/api/instagram-download?url=https://www.instagram.com/stories/instagram/9999999999999999999/&type=story&dl=story');
const text3 = await res.text();
check('E2E-3 stream ok', res.status, 200);
check('E2E-3 video bytes', text3, 'MP4DATA-VIDEO');

// E2E 4: download a photo story -> served with image content type
res = await apiGet('http://x/api/instagram-download?url=https://www.instagram.com/stories/instagram/8888888888888888888/&type=story&dl=story');
const text4 = await res.text();
check('E2E-4 status', res.status, 200);
check('E2E-4 content-type', res.headers.get('Content-Type') || '', 'image/jpeg');
check('E2E-4 photo bytes', text4, 'JPEGDATA-PHOTO');

// E2E 5: highlight link -> honest unsupported message
res = await apiGet('http://x/api/instagram-download?url=https://www.instagram.com/stories/highlights/17912345678901234/&type=story');
body = JSON.parse(await res.text());
check('E2E-5 status', res.status, 500);
check('E2E-5 highlight msg', body.error?.includes('Highlight'), true);

// E2E 6: no session -> fast sentinel via API
delete (process.env as any).IG_SESSIONID;
delete (process.env as any).IG_DS_USER_ID;
delete (process.env as any).IG_CSRF_TOKEN;
const t0 = Date.now();
res = await apiGet('http://x/api/instagram-download?url=https://www.instagram.com/stories/instagram/7777777777777777777/&type=story');
body = JSON.parse(await res.text());
const elapsed = Date.now() - t0;
check('E2E-6 status', res.status, 500);
check('E2E-6 protected-content msg', body.error?.includes('protected content'), true);
check('E2E-6 fast (<8s)', elapsed < 8000, true);

console.log(`\nRESULT: ${pass} PASS, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);