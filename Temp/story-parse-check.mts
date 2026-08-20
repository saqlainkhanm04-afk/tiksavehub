import { parseFacebookUrl } from '../src/lib/facebook-url.ts';

const cases = [
  ['user story link (raw)', 'https://web.facebook.com/stories/122106409004612377/UzpfSVNDOjEwMDIzMzYzNjI3NzMwODE=/?view_single=1', 'story'],
  ['story encoded %3D', 'https://www.facebook.com/stories/122106409004612377/UzpfSVNDOjEwMDIzMzYzNjI3NzMwODE%3D/?view_single=1', 'story'],
  ['story no token', 'https://www.facebook.com/stories/122106409004612377/', 'story'],
  ['stories.php profile_id', 'https://www.facebook.com/stories.php?profile_id=122106409004612377', 'story'],
  ['story.php permalink', 'https://www.facebook.com/story.php?story_fbid=1002336362773081&id=122106409004612377', 'story'],
  ['permalink.php fbid', 'https://www.facebook.com/permalink.php?story_fbid=1002336362773081&id=122106409004612377', 'story'],
  ['video.php', 'https://www.facebook.com/video.php?v=1002336362773081', 'video_page'],
  ['reel share/r regression', 'https://www.facebook.com/share/r/1999ebjPbt/', 'reel'],
  ['photo share/p regression', 'https://www.facebook.com/share/p/14jou2QjmXc/', 'photo'],
];
let pass = 0;
for (const [name, url, want] of cases) {
  const p = parseFacebookUrl(url);
  const ok = p.linkType === want;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${name}] -> type=${p.linkType} videoId=${p.videoId ?? ''} shortCode=${p.shortCode ?? ''} photoId=${p.photoId ?? ''}`);
  console.log(`      sanitized: ${p.sanitizedUrl ?? '(invalid)'}`);
}
console.log(`\n${pass}/${cases.length} PASS`);