/**
 * PERMANENT REGRESSION LOCK — Facebook photo quality.
 *
 * Run: `npm run test:fb-photo` (or `node tests/facebook-photo-quality.test.ts`)
 *
 * These tests pin the invariants discovered via live CDN probing (Aug 2026).
 * If ANY of them fails, the Facebook photo pipeline has regressed and the
 * site is serving capped/locked or non-photo renditions again — do not
 * "fix" the test; fix the pipeline (see src/lib/facebook-photo-quality.ts).
 *
 * 1. `ctp=` (the client-selectable size cap) can NEVER survive in any photo
 *    URL that leaves the pipeline — it is the one rewrite FB's signature
 *    does not lock, and stripping it is the ONLY guaranteed full-res unlock.
 * 2. Sticker/emoji/avatar buckets (t39.1997-6, t39.30808-1, static/rsrc)
 *    can NEVER appear in a photo set — they are 110-320px stamps, not photos.
 * 3. Thumbnail-only renditions (< 320px) are never shipped as full photos.
 * 4. Signed/locked URLs must NEVER be rewritten with stp/path 2048 bumps —
 *    those 403; only the ctp cap may be stripped.
 */
import assert from 'node:assert/strict';
import {
  stripCtpCap,
  isNonPhotoAssetUrl,
  promotePhotoUrl,
  photoQualityScore,
  isThumbOnly,
  enforcePhotoQuality,
  MIN_FULL_PHOTO_SCORE,
  type PhotoCandidate,
} from '../src/lib/facebook-photo-quality.ts';

let passed = 0;
function ok(cond: unknown, name: string): void {
  assert.ok(cond, name);
  passed++;
}

// Real signed URLs captured from live reader-rendered share page (Aug 2026).
const OG_IMAGE_SIGNED =
  'https://z-m-scontent.flhe2-4.fna.fbcdn.net/v/t51.82787-15/774185067_18014068130923761_3821451981126285534_n.jpg?stp=cp0_dst-jpg_e15_fr_q65_tt6&cstp=mx1179x1572&_nc_cat=103&ccb=1-7&_nc_sid=cae128&_nc_ohc=LON7IePYLm4Q7kNvwFI-eiQ&_nc_oc=Adp-5_GDR5cB20IGvXXLp0Pvsh-6NQBDOqXIIJ9Mg6BV3ctTCbAqqhMGAOxysx1M1sk&_nc_ad=z-m&_nc_cid=1347&_nc_eh=164efdf29312aa732d07288a2e962034&_nc_zt=23&_nc_rml=0&_nc_ht=z-m-scontent.flhe2-4.fna&_nc_gid=NjAa549Qbmrtxd9YFO5aTQ&_nc_ss=7f289&oh=00_AQEcyC04e3slFQYoaODHS-HRQA9p6A3GRMOmUzK76Ae4nQ&oe=6A8C6961';
const SIBLING_SIGNED =
  'https://scontent-sea1-1.xx.fbcdn.net/v/t51.82787-15/772937743_18014068154923761_9043507870423445691_n.jpg?stp=dst-jpg_tt6&cstp=mx1179x1572&ctp=s590x590&_nc_cat=1&ccb=1-7&_nc_sid=b0d26a&_nc_ohc=VvdiMR6pzc8Qb72FmHkk-pz&_nc_ht=scontent-sea1-1.xx&oh=00_AYH4TkfZ3MVwCHYBMN0nSdp4YnkUXkqK_owGBCIcIqWqVQ&oe=6A8C6961';
const STICKER_LEAK =
  'https://scontent-atl3-3.xx.fbcdn.net/v/t39.1997-6/83640226_953860661742958_8297483048391664602_n.png?stp=cp0_dst-png&cstp=mx240x240&ctp=s110x80&_nc_cat=106&ccb=1-7&_nc_sid=b0d26a&_nc_ohc=stick&_nc_ht=scontent-atl3-3.xx&oh=00_XYZSTICK&oe=6A8C6961';
const STICKER_LEAK2 =
  'https://scontent-sea5-1.xx.fbcdn.net/v/t39.1997-6/105941685_953860581742966_1572841152382279834_n.png?stp=dst-png_p320x320&_nc_cat=1&ccb=1-7&_nc_sid=b0d26a&_nc_ohc=stick2&_nc_ht=scontent-sea5-1.xx&oh=00_ABCSTICK2&oe=6A8C6961';
const AVATAR_BUCKET =
  'https://scontent-fra5-1.xx.fbcdn.net/v/t39.30808-1/363210152_903020757078253_6622833256069054409_n.jpg?stp=cp0_dst-jpg_s40x40&_nc_cat=1&ccb=1-7&_nc_sid=5b2fld&_nc_ohc=avat&_nc_ht=scontent-fra5-1.xx&oh=00_ZZZAVAT&oe=6A8C6961';
const STATIC_ASSET = 'https://static.xx.fbcdn.net/rsrc.php/y8/r/dQpQ7k8yG7n.gif?ctp=s80x80';
const UNSIGNED_THUMB =
  'https://scontent-sea5-1.xx.fbcdn.net/v/t51.82787-15/775243694_18014068139923761_8558549279846297057_n.jpg?stp=dst-webp_q70_s261x260&cstp=mx1179x1572';
const TRUE_TINY_THUMB =
  'https://scontent-sea5-1.xx.fbcdn.net/v/t51.82787-15/775243694_18014068139923761_8558549279846297057_n.jpg?stp=dst-webp_q70_s261x260&_nc_cat=1&oh=00_THUMB&oe=6A8C6961';

// ---------- stripCtpCap: ctp= NEVER survives ----------
const strippedOg = stripCtpCap(OG_IMAGE_SIGNED);
ok(!/ctp=/.test(strippedOg), 'ctp stripped from og:image URL (p600 cap)');
const strippedSib = stripCtpCap(SIBLING_SIGNED);
ok(!/ctp=/.test(strippedSib), 'ctp stripped from sibling URL (s590 cap)');
ok(/cstp=mx1179x1572/.test(strippedSib), 'cstp full-size bound preserved after strip');
ok(!/&&/.test(strippedSib), 'no dangling && after ctp removal');
ok(stripCtpCap('https://x/y.jpg') === 'https://x/y.jpg', 'no ctp -> unchanged');
ok(
  stripCtpCap('https://x/y.jpg?ctp=p600x600&a=1').includes('?a=1') &&
    !stripCtpCap('https://x/y.jpg?ctp=p600x600&a=1').includes('ctp'),
  'leading ?ctp handled'
);

// ---------- promotePhotoUrl: signed URLs get ONLY ctp-strip, never 2048 bumps ----------
const promotedOg = promotePhotoUrl(OG_IMAGE_SIGNED);
ok(!/ctp=/.test(promotedOg), 'promote(og signed) has no ctp');
ok(!/p2048x2048/.test(promotedOg), 'promote(og signed) did NOT attempt 2048 rewrite (would 403)');
ok(/cp0_dst-jpg_e15_fr_q65_tt6/.test(promotedOg), 'promote(og signed) kept its stp token intact');
const promotedSib = promotePhotoUrl(SIBLING_SIGNED);
ok(!/ctp=/.test(promotedSib), 'promote(sibling signed) has no ctp');
ok(!/p2048x2048/.test(promotedSib), 'promote(sibling signed) no 2048 rewrite');
ok(/cstp=mx1179x1572/.test(promotedSib), 'promote(sibling signed) keeps full cstp bound');
// Unsigned small stp tokens may still be bumped (harmless on unsigned URLs).
ok(promotePhotoUrl(UNSIGNED_THUMB).includes('stp=dst-jpg_p2048x2048'), 'unsigned webp thumb still upgraded');

// ---------- isNonPhotoAssetUrl: stickers/avatars/static NEVER pass ----------
ok(isNonPhotoAssetUrl(STICKER_LEAK), 't39.1997-6 sticker bucket rejected');
ok(isNonPhotoAssetUrl(STICKER_LEAK2), 't39.1997-6 dst-png sticker rejected');
ok(isNonPhotoAssetUrl(AVATAR_BUCKET), 't39.30808-1 avatar bucket rejected');
ok(isNonPhotoAssetUrl(STATIC_ASSET), 'static.xx.fbcdn.net asset rejected');
ok(isNonPhotoAssetUrl('https://x/fbcdn/y?dst-emg0_q80'), 'dst-emg token rejected');
ok(isNonPhotoAssetUrl('https://emg1-scontent.xx.fbcdn.net/x'), 'emg1 proxy host rejected');
ok(!isNonPhotoAssetUrl(OG_IMAGE_SIGNED), 'real og:image photo is NOT rejected');
ok(!isNonPhotoAssetUrl(SIBLING_SIGNED), 'real sibling photo is NOT rejected');
ok(!isNonPhotoAssetUrl(UNSIGNED_THUMB), 'real t51.82787-15 media bucket NOT rejected');

// ---------- photoQualityScore / isThumbOnly ----------
ok(photoQualityScore(OG_IMAGE_SIGNED) > MIN_FULL_PHOTO_SCORE, 'og:image scores above thumb threshold');
ok(photoQualityScore(SIBLING_SIGNED) > MIN_FULL_PHOTO_SCORE, 'sibling (ctp-strippable) scores above threshold');
ok(photoQualityScore(STICKER_LEAK2) >= MIN_FULL_PHOTO_SCORE, 'sticker CAN score over the thumb threshold (330) — the bucket filter, NOT the score, is the required defense (this is why isNonPhotoAssetUrl exists)');
ok(isThumbOnly(TRUE_TINY_THUMB), 'small webp thumb (no cstp bound) still detected as thumb');
ok(!isThumbOnly(promotedSib), 'promoted sibling is NOT thumb-only');

// ---------- enforcePhotoQuality (output-boundary lock) ----------
const candidates: PhotoCandidate[] = [
  { url: SIBLING_SIGNED, alt: SIBLING_SIGNED },
  { url: STICKER_LEAK, alt: STICKER_LEAK },
  { url: STICKER_LEAK2, alt: STICKER_LEAK2 },
  { url: AVATAR_BUCKET, alt: AVATAR_BUCKET },
  { url: STATIC_ASSET, alt: STATIC_ASSET },
  { url: OG_IMAGE_SIGNED, alt: OG_IMAGE_SIGNED },
];
const enforced = enforcePhotoQuality(candidates);
ok(enforced.length === 2, `enforcement keeps only the 2 real photos (got ${enforced.length})`);
for (const c of enforced) {
  ok(!/ctp=/.test(c.url) && !/ctp=/.test(c.alt), 'enforced URLs have zero ctp caps');
  ok(!isNonPhotoAssetUrl(c.url) && !isNonPhotoAssetUrl(c.alt), 'enforced URLs are real media photos');
  ok(photoQualityScore(c.alt) >= MIN_FULL_PHOTO_SCORE, 'enforced alt passes full-photo threshold');
  ok(c.alt.includes('cstp=mx1179x1572'), 'enforced alt retains the full-size bound');
}

// Dedupe same CDN path across hosts still collapses (flhe2 vs sea5 of one file).
const dup: PhotoCandidate[] = [
  { url: OG_IMAGE_SIGNED, alt: OG_IMAGE_SIGNED },
  { url: OG_IMAGE_SIGNED.replace('flhe2-4.fna', 'sea5-1.xx'), alt: OG_IMAGE_SIGNED.replace('flhe2-4.fna', 'sea5-1.xx') },
];
ok(enforcePhotoQuality(dup).length === 1, 'cross-host CDN duplicates collapse to one');

console.log(`\nfacebook-photo-quality lock: ${passed} assertions PASS`);
process.exit(0);