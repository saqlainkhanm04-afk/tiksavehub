import http from 'node:http';

process.env.IG_SESSIONID = 'mock-session-123';
process.env.IG_DS_USER_ID = '25025320';
process.env.IG_CSRF_TOKEN = 'mock-csrf';

let trayFailFirst = false;
const mockState = { loginFailsRemaining: 0 };

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://mock');
  const path = url.pathname;
  res.setHeader('Content-Type', 'application/json');

  const send = (code: number, obj: unknown) => {
    res.statusCode = code;
    res.end(JSON.stringify(obj));
  };

  if (path === '/api/v1/users/web_profile_info/') {
    const u = url.searchParams.get('username') || '';
    if (u === 'unknownuser') return send(200, { message: 'Invalid user' });
    return send(200, {
      data: { user: { id: '25025320', username: 'instagram', is_private: false } },
      status: 'ok',
    });
  }

  if (path === '/api/v1/feed/reels_media/') {
    if (mockState.loginFailsRemaining > 0) {
      mockState.loginFailsRemaining -= 1;
      return send(403, { message: 'login_required', status: 'fail' });
    }
    if (trayFailFirst) {
      trayFailFirst = false;
      return send(200, { reels: {}, status: 'ok' });
    }
    const reelId = url.searchParams.get('reel_ids') || '';
    return send(200, {
      reels: {
        [reelId]: {
          items: [
            {
              media_id: '9999999999999999999',
              media_type: 2,
              pk: '9999999999999999999',
              video_versions: [{ url: 'https://scontent.mock/story-video.mp4', width: 1080, height: 1920 }],
              image_versions2: {
                candidates: [{ url: 'https://scontent.mock/story-cover.jpg', width: 1080, height: 1920 }],
              },
              video_duration: 12.5,
              user: { username: 'instagram', full_name: 'Instagram', profile_pic_url: 'https://scontent.mock/avatar.jpg' },
              view_count: 42,
            },
          ],
          user: { id: reelId, username: 'instagram' },
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
          media_type: 1,
          pk: '1234567890123456789',
          image_versions2: {
            candidates: [{ url: 'https://scontent.mock/direct-photo.jpg', width: 1080, height: 1920 }],
          },
          display_url: 'https://scontent.mock/direct-photo.jpg',
          user: { username: 'someone', full_name: 'Someone' },
        },
      ],
      status: 'ok',
    });
  }

  send(404, { message: 'not found' });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as any).port as number;
console.log(`mock IG API on 127.0.0.1:${port}`);

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const u = String(input);
  if (u.startsWith('https://www.instagram.com/')) {
    return realFetch(u.replace('https://www.instagram.com', `http://127.0.0.1:${port}`), init);
  }
  if (u.startsWith('https://i.instagram.com/')) {
    return realFetch(u.replace('https://i.instagram.com/', `http://127.0.0.1:${port}/`), init);
  }
  if (u.startsWith('https://www.instagram.com/graphql')) {
    return Promise.resolve(
      new Response(JSON.stringify({ status: 'fail', errors: [{ message: 'execution error' }] }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

const { fetchStoryByMediaId, resolveUserIdByUsername, ERR_STORY_EXPIRED, ERR_SESSION_REQUIRED } = await import(
  '../src/lib/instagram.ts'
);

let pass = 0;
let fail = 0;
function check(name: string, got: any, expect: any, extra = '') {
  const ok = got === expect || (typeof expect === 'function' && expect(got));
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name} — got: ${JSON.stringify(got)} ${extra}`);
  }
}

// Case A: session + tray hit (video story)
try {
  const media = await fetchStoryByMediaId('9999999999999999999', 'instagram');
  check('A: tray hit returns matched story', getBest(media), 'https://scontent.mock/story-video.mp4');
  check('A: user backfilled', media?.user?.username, 'instagram');
} catch (err: any) {
  check('A: tray hit no throw', String(err?.message), 'NO_THROW');
}

function getBest(m: any): string {
  const v = m?.video_versions || [];
  const sorted = [...v].sort((a: any, b: any) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url;
}

// Case B: tray non-empty but mediaId missing -> expired sentinel
try {
  await fetchStoryByMediaId('1111111111111111111', 'instagram');
  check('B: missing story throws', 'NO_THROW', 'throws');
} catch (err: any) {
  check('B: expired sentinel', err?.message, ERR_STORY_EXPIRED);
}

// Case C: no username -> falls to media/info layer (photo story)
try {
  const media = await fetchStoryByMediaId('1234567890123456789');
  check('C: media-info fallback', media?.display_url, 'https://scontent.mock/direct-photo.jpg');
  check('C: photo media_type', media?.media_type, 1);
} catch (err: any) {
  check('C: media-info no throw', String(err?.message), 'NO_THROW');
}

// Case D: login_required on tray -> csrf bust + retry succeeds
mockState.loginFailsRemaining = 1;
try {
  const media = await fetchStoryByMediaId('9999999999999999999', 'instagram');
  check('D: auto-retry after session block', getBest(media), 'https://scontent.mock/story-video.mp4');
} catch (err: any) {
  check('D: auto-retry no throw', String(err?.message), 'NO_THROW');
}

// Case E: username resolution + cache
try {
  const uid = await resolveUserIdByUsername('instagram');
  check('E: username -> userId', uid, '25025320');
  const uid2 = await resolveUserIdByUsername('instagram');
  check('E: userId cached (second call)', uid2, '25025320');
} catch (err: any) {
  check('E: resolve no throw', String(err?.message), 'NO_THROW');
}

// Case F: no session -> ERR_SESSION_REQUIRED fast (anonymous graphql mock fails)
delete (process.env as any).IG_SESSIONID;
delete (process.env as any).IG_DS_USER_ID;
delete (process.env as any).IG_CSRF_TOKEN;
try {
  await fetchStoryByMediaId('5555555555555555555', 'instagram');
  check('F: no session throws', 'NO_THROW', 'throws');
} catch (err: any) {
  check('F: session-required sentinel', err?.message, ERR_SESSION_REQUIRED);
}

console.log(`\nRESULT: ${pass} PASS, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);