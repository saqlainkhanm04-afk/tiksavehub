/**
 * Cloudflare Browser Run integration for Facebook photo extraction.
 *
 * Uses a real headless Chromium browser to load Facebook pages with full
 * JavaScript execution — bypassing login walls that lightweight fetchers
 * (r.jina.ai, plain HTTP) trigger. Only used as a fallback when the reader
 * proxy hits a login wall.
 *
 * Session lifecycle: the browser is NOT explicitly closed. Cloudflare's
 * Browser Run auto-closes idle sessions after 1 minute (default) or the
 * configured keep_alive duration — no resource leak possible.
 */

import type { CfEnv } from './env';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Timeout for the browser page load (ms). */
const BROWSER_TIMEOUT_MS = 20_000;

/**
 * Fetch a Facebook page via Cloudflare Browser Run (real Chromium).
 * Returns the fully rendered HTML after JavaScript execution, or null
 * on any failure (binding missing, import error, timeout, etc.).
 *
 * The browser session is NOT closed — it auto-expires via Cloudflare's
 * keep_alive mechanism (default 1 min idle timeout).
 */
export async function fetchWithBrowser(
  env: CfEnv,
  url: string
): Promise<{ html: string; title: string } | null> {
  // Browser binding must be configured in wrangler.toml
  if (!env.MYBROWSER) {
    console.error('[FB-BROWSER] No MYBROWSER binding — skipping browser fallback');
    return null;
  }

  let puppeteer: typeof import('@cloudflare/puppeteer');
  try {
    // Dynamic import — fails gracefully in environments without the binding
    puppeteer = await import('@cloudflare/puppeteer');
  } catch (e: any) {
    console.error(`[FB-BROWSER] Failed to import @cloudflare/puppeteer: ${e?.message ?? e}`);
    return null;
  }

  let browser: any = null;
  try {
    console.error(`[FB-BROWSER] Launching browser for: ${url}`);
    // Launch with 60s keep_alive — session auto-closes 60s after last use.
    // No browser.close() call — Cloudflare manages the lifecycle.
    browser = await puppeteer.launch(env.MYBROWSER as any, {
      keep_alive: 60_000,
    });

    const page = await browser.newPage();

    // Realistic desktop fingerprint
    await page.setUserAgent(BROWSER_UA);
    await page.setViewport({ width: 1920, height: 1080 });

    // Navigate with network idle — ensures JS-rendered content is loaded
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: BROWSER_TIMEOUT_MS,
    });

    // Brief wait for any late-loading dynamic elements (carousel photos)
    await new Promise((r) => setTimeout(r, 1_500));

    const html = await page.content();
    const title = await page.title();

    console.error(`[FB-BROWSER] Got ${html.length} chars, title="${title.substring(0, 80)}"`);

    // Disconnect from the page — browser stays open for other requests
    // (page.close() is called implicitly when we exit the try block)
    await page.close();

    return { html, title };
  } catch (e: any) {
    console.error(`[FB-BROWSER] Browser fetch failed: ${e?.message ?? e}`);
    return null;
  }
  // NOTE: browser is intentionally NOT closed.
  // Cloudflare Browser Run auto-closes idle sessions after keep_alive expires.
  // Explicit close would prevent session reuse by subsequent requests.
}
