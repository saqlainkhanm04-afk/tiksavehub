import { parseStoryPage } from '../src/lib/facebook.ts';

const sjs = (payload: unknown) => `<script type="application/json" data-sjs="">${JSON.stringify(payload)}</script>`;

// Realistic story.php relay payload: data.video.story.attachments[].media —
// segment 1: single video object; segment 2: a 2-item media ARRAY (multi-segment
// story: photo + video); segment 3: photo. Plus unrelated page noise.
const storyData = {
  video: {
    story: {
      attachments: [
        {
          media: {
            __typename: 'Video',
            name: 'First segment',
            playable_url: 'https://video.xx.fbcdn.net/v/t42.1790-4/sd1.mp4?efg=abc&oh=sig1',
            playable_url_quality_hd: 'https://video.xx.fbcdn.net/v/t43.1790-4/hd1.mp4?efg=abc&oh=sig2',
            playable_duration_in_ms: 5432,
            thumbnailImage: { uri: 'https://scontent.xx.fbcdn.net/v/t15.5256-10/p720x720/thumb1.jpg?stp=dst-jpg_p720x720&oh=x' },
          },
          target: { __typename: 'Story' },
        },
        {
          media: [
            {
              __typename: 'Photo',
              image: { uri: 'https://scontent.xx.fbcdn.net/v/t1.6435-9/photo1_12345_67890_9876_n.jpg?stp=dst-jpg_s590x590&ctp=s590x590&oh=y' },
            },
            {
              __typename: 'Video',
              playable_url: 'https://video.xx.fbcdn.net/v/t42.1790-4/sd2.mp4?oh=sig3',
              playable_duration_in_ms: 2211,
              image: { uri: 'https://scontent.xx.fbcdn.net/v/t15.5256-10/p720x720/thumb2.jpg?oh=z' },
            },
          ],
          target: { __typename: 'Story' },
        },
        {
          media: {
            __typename: 'Photo',
            image: { uri: 'https://scontent.xx.fbcdn.net/v/t1.6435-9/photo2_111_222_333_n.jpg?stp=dst-jpg_tt6&oh=w' },
          },
        },
      ],
    },
  },
};

const relay = {
  require: [
    ['ScheduledServerJS', 'handle', null, [{ __bbox: { define: [['cr:1', [], {}, -1]], require: [['__x'], ['__bbox', 'result', 'data', storyData]] } }]],
  ],
};

// Case 2: same data but nested as an escaped JSON string (relay payload style).
const nested = { require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['__bbox', 'result', 'data', JSON.stringify(storyData)]] } }]]] };

// Case 3: duplicate video URL must dedupe to one segment.
const dupData = {
  video: {
    story: {
      attachments: [
        { media: { __typename: 'Video', playable_url: 'https://video.xx.fbcdn.net/v/t42.1790-4/same.mp4?oh=1' } },
        { media: { __typename: 'Video', playable_url: 'https://video.xx.fbcdn.net/v/t42.1790-4/same.mp4?oh=1', playable_url_quality_hd: 'https://video.xx.fbcdn.net/v/t43.1790-4/same-hd.mp4?oh=2' } },
      ],
    },
  },
};

// Case 4: no attachments JSON at all (shelled page) → zero segments.
const shell = '<html><head><title>Error</title></head><body><div>You must log in to continue</div></body></html>';

// Case 5: related-video noise OUTSIDE attachments (must NOT be collected).
const noiseData = {
  video: { story: { attachments: [{ media: { __typename: 'Video', playable_url: 'https://video.xx.fbcdn.net/v/t42.1790-4/real.mp4?oh=1' } }] } },
  other: { suggestions: { edges: [{ node: { media: { __typename: 'Video', playable_url: 'https://video.xx.fbcdn.net/v/t42.1790-4/noise.mp4?oh=9' } } }] } },
};

const html = (blobs: string[]) => `<html><head><title>Title | Facebook</title>
  <meta property="og:title" content="Story title here" />
  <meta property="og:image" content="https://scontent.xx.fbcdn.net/ogcover.jpg" />
  ${blobs.join('\n')}
</head><body></body></html>`;

let pass = 0;
const total: string[] = [];
const check = (name: string, cond: boolean | string | null | undefined, extra = '') => {
  total.push(name);
  if (cond) pass++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

// 1 — four segments from the classic relay shape (video + [photo, video] + photo).
const s1 = parseStoryPage(html([sjs(relay)]));
check('relay shape: 4 segments', s1.length === 4, `got ${s1.length}`);
check('seg1 video hd+sd', s1[0]?.kind === 'video' && s1[0]?.hdUrl?.includes('hd1.mp4') && s1[0]?.sdUrl?.includes('sd1.mp4'));
check('seg1 duration ms->s', s1[0]?.duration === 5.432, `got ${s1[0]?.duration}`);
check('seg1 cover from thumbnailImage', s1[0]?.cover?.includes('thumb1.jpg'));
check('seg1 title kept', s1[0]?.title === 'First segment');
check('seg2 photo', s1[1]?.kind === 'photo' && !!s1[1]?.photoUrl, `got kind=${s1[1]?.kind}`);
check('seg2 photo promoted (no ctp/s590)', s1[1]?.photoUrl && !s1[1]?.photoUrl.includes('ctp=') && s1[1]?.photoUrl.includes('p2048x2048'), s1[1]?.photoUrl ?? '');
check('seg2 photo altUrl = raw', s1[1]?.altUrl === 'https://scontent.xx.fbcdn.net/v/t1.6435-9/photo1_12345_67890_9876_n.jpg?stp=dst-jpg_s590x590&ctp=s590x590&oh=y');
check('seg3 video (array item 2)', s1[2]?.kind === 'video' && s1[2]?.sdUrl?.includes('sd2.mp4'));
check('seg3 video cover from image', s1[2]?.cover?.includes('thumb2.jpg'));
check('seg3 duration', s1[2]?.duration === 2.211);
check('seg4 photo (attachment 3)', s1[3]?.kind === 'photo' && !!s1[3]?.photoUrl, `got kind=${s1[3]?.kind}`);

// 2 — nested-string relay payload.
const s2 = parseStoryPage(html([sjs(nested)]));
check('nested string: 4 segments', s2.length === 4, `got ${s2.length}`);

// 3 — dedupe by URL.
const s3 = parseStoryPage(html([sjs(dupData)]));
check('duplicate video deduped', s3.length === 1, `got ${s3.length}`);
check('dedup keeps hd', s3[0]?.hdUrl?.includes('same-hd.mp4'));

// 4 — shelled page → 0.
const s4 = parseStoryPage(shell);
check('shelled page: 0 segments', s4.length === 0);

// 5 — noise outside attachments ignored.
const s5 = parseStoryPage(html([sjs(noiseData)]));
check('attachments-only filter', s5.length === 1 && s5[0]?.sdUrl?.includes('real.mp4'), `got ${s5.length}`);

// 6 — og:image/og:title NOT in segments (page-level metadata handled by caller).
const s6 = parseStoryPage(html([sjs(relay)]));
check('segment photos not og:image', !s6.some((s) => s.cover.includes('ogcover.jpg')));

// 7 — MAX_SJS_BLOB_BYTES guard: giant blob skipped (no crash).
const big = { video: { story: { attachments: [{ media: { __typename: 'Video', playable_url: 'https://x.mp4' } }] } }, pad: 'x'.repeat(1_600_000) };
const s7 = parseStoryPage(html([sjs(big)]));
check('oversized blob skipped', s7.length === 0, `got ${s7.length}`);

console.log(`\n${pass}/${total.length} PASS`);
