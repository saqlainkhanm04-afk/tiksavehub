/**
 * Permanent media-quality invariants for the Facebook photo pipeline.
 *
 * DO NOT weaken these rules: they are the result of live CDN probing (Aug 2026)
 * and are enforced by `npm run test:fb-photo`. Two facts underpin them:
 *
 *  1. `ctp={p|s}{w}x{h}` is the ONLY size parameter Facebook's URL signature
 *     does NOT lock. Dropping it serves the true full-size file (verified:
 *     og:image 600x800 -> 1179x1572 ; sibling s590 -> 1179x1572, same
 *     signature, 172-188KB). Every other rewrite (`stp=p2048`, path bumps,
 *     `cstp`, `_o.jpg`) 403s on signed URLs — dead weight that must never be
 *     attempted on signed/locked URLs.
 *  2. Real post photos always live in the media CDN buckets (`t51.82787-15`,
 *     `t45.*`, `t60.*`). Reaction stickers/emoji are in `t39.1997-6` and
 *     avatar/emoji renditions in `t39.30808-1`; those are 110-320px assets
 *     that must never appear in a photo set.
 *
 * This module is intentionally dependency-free so its invariants can be
 * regression-tested in isolation. The pipeline also runs
 * `enforcePhotoQuality` at its output boundary, so no future extraction path
 * can leak a capped or non-photo URL into a result.
 */

/** A photo candidate as found on the page: the promoted URL plus its raw original. */
export interface PhotoCandidate {
  url: string;
  alt: string;
}

/** Anything smaller than this is a quad/thumbnail rendition — never a full photo. */
export const MIN_FULL_PHOTO_SCORE = 320;

/**
 * Drop the client-selectable `ctp={p|s}{w}x{h}` size cap from a FB CDN URL.
 * `ctp` is the ONE rewrite Facebook's signature does NOT lock (verified live:
 * 443x590 -> 1179x1572 on reader URLs, 600x800 -> 1179x1572 on og:image URLs;
 * `stp`/`cstp`/path rewrites 403 as signed, `ctp` stripping always serves the
 * file at its true `cstp`-bound full size). Used for BOTH the primary URL and
 * the fallback, so a capped rendition can never ship.
 */
export function stripCtpCap(u: string): string {
  return u
    .replace(/([?&])ctp=[sp]\d{1,5}x\d{1,5}/, '$1')
    .replace(/\?&/, '?')
    .replace(/&{2,}/g, '&');
}

/**
 * True for FB CDN URLs that are NOT part of a photo post. Reaction/sticker/
 * emoji assets live in the `t39.1997-6` bucket, avatar/emoji renditions in
 * `t39.30808-1`, and external-gif proxies under `/emg1/`; real post photos
 * are always served from the media buckets (`t51.82787-15`, `t45.*`, `t60.*`).
 * These leaks used to sneak into photo sets as tiny 110-320px stamps.
 */
export function isNonPhotoAssetUrl(u: string): boolean {
  return (
    /^https?:\/\/static\./i.test(u) ||
    /rsrc\.php/.test(u) ||
    /dst-emg/.test(u) ||
    /emg1-?scontent|emg1\//.test(u) ||
    /t39\.1997-6\//.test(u) ||
    /t39\.30808-1\//.test(u)
  );
}

/**
 * Promote a FB CDN image URL to the best-available resolution. The `stp` token
 * is client-selectable ONLY for unsigned URLs: upgrade small squares to the
 * 2048px rendition and bump any small `p{size}` path token to the full-size
 * variant. Signed/locked URLs ignore those rewrites (they 403), so the ONLY
 * guaranteed upsize for them is dropping the `ctp` cap — which serves the
 * original full-size file on every URL shape. Downloaders retry the fallback
 * (`altUrl` = `stripCtpCap(original)`) when the promoted URL is rejected.
 */
export function promotePhotoUrl(u: string): string {
  const signed = /[?&](?:oe|oh|sig|token|eav)=/.test(u) || /\/v\/scontent/.test(u);
  let out = u;
  if (!signed) {
    out = out.replace(/stp=dst-jpg(?:_q\d+)?_[sp]\d{1,5}x\d{1,5}(?:_q\d+)?/, 'stp=dst-jpg_p2048x2048');
    out = out.replace(/stp=dst-webp(?:_q\d+)?_[sp]\d{1,5}x\d{1,5}(?:_q\d+)?/, 'stp=dst-jpg_p2048x2048');
    out = out.replace(/(\/p\d{1,5}x\d{1,5}\/)/, '/p2048x2048/');
    out = out.replace(/(\/s\d{1,5}x\d{1,5}\/)/, '/s2048x2048/');
  }
  return stripCtpCap(out);
}

/**
 * Rough resolution/quality score of a FB CDN image URL. Used to pick the best
 * rendition of the SAME photo (multiple pages/contexts expose the same file at
 * different sizes) and to detect "thumbnail-only" siblings that need their own
 * photo page fetched. Higher = better. An unsigned `dst-jpg` URL with no size
 * token at all is the ORIGINAL file — the top score.
 */
export function photoQualityScore(u: string): number {
  let score = 0;
  if (/dst-webp/.test(u)) score += 1;
  else if (/dst-jpg|dst-png|\.jpg(?:[?#]|$)|\.png(?:[?#]|$)/.test(u)) score += 10;

  const stp = /stp=([^&]+)/.exec(u)?.[1] ?? '';
  const dim = /[sp](\d{2,5})x(\d{2,5})/.exec(stp);
  if (dim) score += Math.max(Number(dim[1]), Number(dim[2]));
  const ctp = /ctp=p(\d{2,5})x(\d{2,5})/.exec(u);
  if (ctp) score += Math.max(Number(ctp[1]), Number(ctp[2]));
  const cstp = /cstp=mx(\d{2,5})x(\d{2,5})/.exec(u);
  if (cstp) score += Math.max(Number(cstp[1]), Number(cstp[2]));
  const ptok = /\/p(\d{2,5})x(\d{2,5})\//.exec(u);
  if (ptok) score += Math.max(Number(ptok[1]), Number(ptok[2]));

  if (!dim && !ctp && !cstp && !ptok && /dst-jpg/.test(u)) score += 2000;
  return score;
}

/**
 * CDN path of a photo URL — same file on different FB CDN hosts/params
 * (e.g. `flhe2-2` vs `sea5-1` nodes, `stp` size tokens) dedupes to one.
 */
export function cdnPathOf(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return u.split('?')[0];
  }
}

/** True when a photo is only available as a small (≤ ~320px) thumbnail. */
export function isThumbOnly(u: string): boolean {
  return photoQualityScore(u) < MIN_FULL_PHOTO_SCORE;
}

/**
 * OUTPUT-BOUNDARY ENFORCEMENT — the permanent lock.
 *
 * Every photo candidate that reaches the pipeline output passes through here.
 * It guarantees the two invariants regardless of which extraction/recovery
 * path produced the candidate:
 *   - strip EVERY `ctp=` cap from the URL (primary and fallback) so a capped
 *     rendition can never be served or downloaded;
 *   - drop non-photo asset buckets (stickers/emoji/avatars) — they can never
 *     show up in a photo set as tiny stamps;
 *   - guard against thumbnail-only leftovers (score < MIN_FULL_PHOTO_SCORE).
 */
export function enforcePhotoQuality(candidates: PhotoCandidate[]): PhotoCandidate[] {
  const seen = new Set<string>();
  const out: PhotoCandidate[] = [];
  for (const c of candidates) {
    if (isNonPhotoAssetUrl(c.url) || isNonPhotoAssetUrl(c.alt)) continue;
    const url = promotePhotoUrl(c.url);
    const alt = stripCtpCap(c.alt);
    if (isThumbOnly(alt)) continue;
    const key = cdnPathOf(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, alt });
  }
  return out;
}