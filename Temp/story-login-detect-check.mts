// Verify detectUnavailable logic against the REAL unflagged-IP story page HTML
import { readFileSync } from 'node:fs';
import { parseFacebookUrl } from '../src/lib/facebook-url.ts';

const html = readFileSync(new URL('../Temp/real-story-page.html', import.meta.url), 'utf8').toLowerCase();

const codes = {
  LOGIN_REQUIRED: 'facebook_login_required',
};

let fired: string | null = null;
if (/\/login(\/|$)/.test('https://www.facebook.com/story.php?story_fbid=1&id=2')) {
  fired = codes.LOGIN_REQUIRED;
} else if (
  html.includes('url=/login/?next=') ||
  html.includes('url=/login/?') ||
  html.includes('log into facebook') ||
  html.includes('you must log in to continue') ||
  html.includes('log in to facebook to continue') ||
  html.includes('password</') ||
  html.includes('action="/login')
) {
  fired = codes.LOGIN_REQUIRED;
} else {
  const markers = [
    "content isn't available",
    "content is not available",
    "This video is no longer available",
    "This video isn't available",
    "isn't available right now",
    "may have been removed",
    "The link you followed may be broken",
  ];
  fired = markers.find((m) => html.includes(m.toLowerCase())) ? 'NOT_AVAILABLE' : null;
}

const p = parseFacebookUrl('https://web.facebook.com/stories/122106409004612377/UzpfSVNDOjEwMDIzMzYzNjI3NzMwODE=/?view_single=1');
console.log(`detectUnavailable verdict on real unflagged-IP page: ${fired ?? 'null'}`);
console.log(`expected: LOGIN_REQUIRED — ${fired === codes.LOGIN_REQUIRED ? 'PASS' : 'FAIL'}`);
console.log(`parse type=${p.linkType} videoId=${p.videoId} — ${p.linkType === 'story' && p.videoId === '1002336362773081' ? 'PASS' : 'FAIL'}`);
console.log(`sanitized: ${p.sanitizedUrl}`);