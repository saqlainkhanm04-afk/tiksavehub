/**
 * Instagram extraction through Cloudflare Browser Rendering (real Chromium).
 *
 * WHY THIS EXISTS (verified live 2026-09-27, Cloudflare edge + local):
 * Instagram serves ZERO media data to plain HTTP clients now. The reel page and
 * the /embed/captioned/ page both return a 630-750KB JavaScript shell with no
 * `og:video`, no `video_versions`, no `dash_manifest`; public GraphQL doc_ids
 * answer 403; `?__a=1` answers 404. The only thing that still renders a public
 * reel is a real browser, which is exactly what the MYBROWSER binding is.
 *
 * A logged-out Chromium DOES render public reels (verified on 5 real reels: the
 * reel, caption, cover and progressive MP4 are all in the DOM; only the login
 * overlay chrome is present). The media payload lives in a
 * `<script type="application/json" data-sjs>` bootstrap tag, which we JSON.parse
 * and deep-search for the object that owns `video_versions`.
 *
 * A shortcode that is private, deleted or nonexistent renders
 * "Post isn't available" with no media JSON, which we report as a distinct
 * unavailable error so the API route can say that honestly instead of blaming
 * the user for our own network failures.
 *
 * Cost note: every call here spends Cloudflare Browser Rendering time (~5s per
 * reel, free tier 10 min/day). It is the LAST source in the chain so the cheap
 * HTTP sources always get a free shot first, and IG_BROWSER_DISABLED=true turns
 * it off entirely.
 */

import type { CfEnv } from './env';
import type { MediaMeta } from './platforms/types';

/** Sentinel: Instagram itself says the media is not available (private/deleted). */
export const IG_ERR_UNAVAILABLE = 'instagram_media_unavailable';

/**
 * Sentinel: Cloudflare refused to give us a browser (concurrency/rate limit or
 * daily minutes exhausted). Our capacity problem, never the user's link.
 */
export const IG_ERR_BROWSER_BUSY = 'instagram_browser_busy';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const NAV_TIMEOUT_MS = 30_000;
const DATA_WAIT_MS = 12_000;
const KEEP_ALIVE_MS = 30_000;

export interface IgBrowserResult {
  meta: MediaMeta;
  /** True when Instagram explicitly reported the media as unavailable. */
  unavailable: boolean;
}

function browserDisabled(env: CfEnv): boolean {
  const flag = (env as Record<string, unknown>).IG_BROWSER_DISABLED;
  return flag === true || flag === 'true' || flag === '1';
}

/**
 * Runs inside the page. Kept as a single self-contained function because it is
 * serialized and evaluated in the browser context (no closures over module
 * scope, no imports).
 */
function extractMediaFromPage() {
  // Instagram ships type 102 entries that are DASH video-only (silent) streams.
  // Progressive types (101 / 103) are muxed video+audio, so they come first.
  const PROGRESSIVE = [101, 103, 100, 104];

  function deepFindMedia(node: any, depth: number): any {
    if (!node || depth > 16) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = deepFindMedia(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof node === 'object') {
      if (Array.isArray(node.video_versions) && node.video_versions.length > 0) return node;
      for (const key of Object.keys(node)) {
        const found = deepFindMedia(node[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function dashText(media: any): string {
    const raw = media && media.video_dash_manifest;
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw === 'object') return raw.text || raw.url || '';
    return '';
  }

  function audioFromDash(dash: string): string {
    if (!dash || dash.indexOf('audio/') === -1) return '';
    const reps = dash.match(/<Representation[^>]*>[\s\S]*?<\/Representation>/gi) || [];
    let best = '';
    let bestBandwidth = -1;
    for (const rep of reps) {
      if (!/mimeType="audio\/(mp4|mpeg)"/i.test(rep)) continue;
      const bandwidth = Number(rep.match(/bandwidth="(\d+)"/)?.[1] || 0);
      const base = rep.match(/<BaseURL>([^<]*)<\/BaseURL>/)?.[1];
      if (!base) continue;
      const url = base.replace(/&amp;/g, '&').trim();
      if (!url.startsWith('http')) continue;
      if (bandwidth > bestBandwidth) {
        bestBandwidth = bandwidth;
        best = url;
      }
    }
    return best;
  }

  function durationFromDash(dash: string): number {
    const iso = dash.match(/mediaPresentationDuration="PT([\d.]+)S"/);
    if (iso) return Math.round(parseFloat(iso[1]) || 0);
    const clock = dash.match(/mediaPresentationDuration="PT(\d+):(\d+):([\d.]+)S"/);
    if (clock) {
      return Math.round(Number(clock[1]) * 3600 + Number(clock[2]) * 60 + parseFloat(clock[3]));
    }
    return 0;
  }

  let media: any = null;
  const scripts = document.querySelectorAll('script');
  for (let i = 0; i < scripts.length && !media; i++) {
    const text = scripts[i].textContent || '';
    if (text.indexOf('video_versions') === -1) continue;
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    media = deepFindMedia(parsed, 0);
  }

  if (!media && (window as any)._sharedData) {
    try {
      media = deepFindMedia(JSON.parse(JSON.stringify((window as any)._sharedData)), 0);
    } catch {
      media = null;
    }
  }

  const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 600);
  const unavailable =
    /post isn.t available|page isn.t available|sorry, this page isn.t|content isn.t available/i.test(bodyText) ||
    /isn.t available/i.test(document.title || '');

  if (!media) {
    return { found: false, unavailable, loginWall: /log in|sign up/i.test(bodyText), bodyText };
  }

  const all = (media.video_versions || []).filter((v: any) => v && typeof v.url === 'string' && v.url);
  const rank = (v: any) => {
    const idx = PROGRESSIVE.indexOf(v.type);
    return (idx === -1 ? 99 : idx) * 1e9 + (10000 - Math.min(v.width || 0, 9999));
  };
  const progressive = all.filter((v: any) => PROGRESSIVE.indexOf(v.type) !== -1).sort((a: any, b: any) => rank(a) - rank(b));
  const rest = all.filter((v: any) => PROGRESSIVE.indexOf(v.type) === -1).sort((a: any, b: any) => rank(a) - rank(b));
  const ordered = [...progressive, ...rest];

  const dash = dashText(media);
  const cover =
    media.image_versions2?.candidates?.[0]?.url ||
    media.display_url ||
    media.thumbnail_url ||
    '';

  return {
    found: ordered.length > 0 || !!cover,
    unavailable: false,
    versions: ordered.map((v: any) => ({ url: v.url, type: v.type, width: v.width || 0, height: v.height || 0 })),
    cover: typeof cover === 'string' ? cover : '',
    caption: media.caption?.text || '',
    username: media.user?.username || '',
    fullName: media.user?.full_name || '',
    avatar: media.user?.profile_pic_url || '',
    likes: media.like_count ?? 0,
    comments: media.comment_count ?? 0,
    views: media.play_count ?? 0,
    mediaType: media.media_type ?? 0,
    duration: media.video_duration || durationFromDash(dash),
    audioUrl: audioFromDash(dash) || '',
  };
}

/**
 * Resolve a public reel / video post with real Chromium.
 * Never throws for "media not available" (it reports `unavailable: true` so the
 * caller can pick honest copy); throws only when the browser itself misbehaves.
 */
export async function fetchInstagramViaBrowser(
  env: CfEnv,
  inputUrl: string,
  type: string
): Promise<IgBrowserResult> {
  if (!env.MYBROWSER) {
    throw new Error('Cloudflare Browser Rendering binding (MYBROWSER) is not available');
  }
  if (browserDisabled(env)) {
    throw new Error('Instagram browser source is disabled (IG_BROWSER_DISABLED)');
  }

  let puppeteer: typeof import('@cloudflare/puppeteer');
  try {
    puppeteer = await import('@cloudflare/puppeteer');
  } catch (err: any) {
    throw new Error(`Browser Rendering SDK unavailable: ${err?.message ?? err}`);
  }

  // Cloudflare throttles browser CREATION (concurrency + daily minutes). A 429
  // here is OUR capacity, not the user's link, so it gets its own sentinel and
  // the API answers "temporarily unavailable" instead of a misleading failure.
  let browser: import('@cloudflare/puppeteer').Browser;
  try {
    browser = await puppeteer.launch(env.MYBROWSER as any, { keep_alive: KEEP_ALIVE_MS });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/429|rate limit|quota|too many/i.test(msg)) {
      console.warn(`[ig-browser] Browser Rendering refused the launch (capacity): ${msg}`);
      throw new Error(`${IG_ERR_BROWSER_BUSY}: ${msg.slice(0, 160)}`);
    }
    console.error(`[ig-browser] Browser launch failed: ${msg.slice(0, 200)}`);
    throw new Error(`Browser Rendering launch failed: ${msg.slice(0, 160)}`);
  }

  const page = await browser.newPage();
  const startedAt = Date.now();

  try {
    await page.setUserAgent(BROWSER_UA);
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(inputUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    try {
      await page.waitForFunction(
        () => document.body !== null && document.body.innerHTML.indexOf('video_versions') !== -1,
        { timeout: DATA_WAIT_MS }
      );
    } catch {
      // Not fatal: Instagram still renders "Post isn't available" pages, and
      // a few valid posts only expose the cover. extractMediaFromPage decides.
    }

    const raw: any = await page.evaluate(extractMediaFromPage);
    const elapsedMs = Date.now() - startedAt;

    if (!raw?.found) {
      if (raw?.unavailable) {
        throw Object.assign(new Error(IG_ERR_UNAVAILABLE), { unavailable: true });
      }
      throw new Error(
        `Browser page carried no media JSON (loginWall=${raw?.loginWall ? 'yes' : 'no'}): ${String(
          raw?.bodyText || ''
        )
          .replace(/\s+/g, ' ')
          .slice(0, 120)}`
      );
    }

    const versions: Array<{ url: string; type: number; width: number; height: number }> = raw.versions || [];
    const best = versions[0];
    if (!best) {
      throw new Error('Browser page exposed a cover but no video version');
    }

    const meta: MediaMeta = {
      platform: 'instagram',
      type: type === 'reels' ? 'reels' : type === 'story' ? 'story' : 'video',
      hdUrl: best.url,
      sdUrl: versions[1]?.url || null,
      wmUrl: null,
      audioUrl: raw.audioUrl || null,
      cover: raw.cover || null,
      title: raw.caption || '',
      duration: raw.duration || 0,
      authorName: raw.fullName || '',
      authorAvatar: raw.avatar || null,
      authorUsername: raw.username || null,
      stats: {
        likes: raw.likes ?? null,
        comments: raw.comments ?? null,
        shares: null,
        views: raw.views ?? null,
      },
      sourceUrl: inputUrl,
      resolvedBy: 'IG-Browser',
      resolvedMs: elapsedMs,
    };

    console.log(
      `[ig-browser] ${type}/${best.url.slice(0, 60)}... ${best.width || '?'}x${best.height || '?'} ` +
        `type=${best.type} duration=${meta.duration}s audio=${meta.audioUrl ? 'yes' : 'no'} in ${elapsedMs}ms`
    );

    return { meta, unavailable: false };
  } finally {
    // The browser session is intentionally left open: Cloudflare auto-closes it
    // after keep_alive expires, and keeping it warm lets the next request reuse
    // the same Chromium process.
    page.close().catch(() => {});
  }
}
