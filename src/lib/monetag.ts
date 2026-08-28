/**
 * Monetag Ad Integration — Hook Handlers
 * 
 * Provides clean event callbacks for Paste and Download button clicks
 * to trigger Monetag popunder/interstitial ad scripts without breaking UI flow.
 * 
 * Usage in any Astro page:
 *   import { initMonetagHooks } from '../lib/monetag';
 *   initMonetagHooks();
 */

const MONETAG_EVENTS = {
  PASTE: 'tiksavehub:paste',
  DOWNLOAD: 'tiksavehub:download',
  RESULT: 'tiksavehub:result',
} as const;

let initialized = false;

/**
 * Initialize Monetag ad hooks.
 * Call once on page load. Binds to paste/download buttons automatically.
 */
export function initMonetagHooks(): void {
  if (initialized) return;
  initialized = true;

  if (typeof document === 'undefined') return;

  // Dispatch custom events on paste button clicks
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Paste button detection
    if (target.closest('[data-ad-hook="paste"]') || target.closest('.paste-btn')) {
      document.dispatchEvent(new CustomEvent(MONETAG_EVENTS.PASTE));
    }

    // Download button detection
    if (
      target.closest('[data-ad-hook="download"]') ||
      target.closest('.download-submit-btn') ||
      target.closest('[id*="download-btn"]') ||
      target.closest('.dl-tile') ||
      target.closest('.fb-dl-tile') ||
      target.closest('.sc-dl-tile') ||
      target.closest('.ig-dl-tile')
    ) {
      document.dispatchEvent(new CustomEvent(MONETAG_EVENTS.DOWNLOAD));
    }
  }, true);

  // Dispatch result event when result mount gets content
  const resultMount = document.getElementById('result-mount');
  if (resultMount) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          document.dispatchEvent(new CustomEvent(MONETAG_EVENTS.RESULT));
          break;
        }
      }
    });
    observer.observe(resultMount, { childList: true });
  }
}

/**
 * Trigger a Monetag popunder ad.
 * Call this from download/paste handlers for monetization.
 */
export function triggerPopunder(): void {
  if (typeof window === 'undefined') return;

  // Monetag popunder integration point.
  // When you add your Monetag script, call it here.
  // Example (Monetag tag):
  //   if (window.__tag) window.__tag.popunder();
  //
  // For now, this dispatches a DOM event so ad scripts can listen:
  document.dispatchEvent(new CustomEvent('monetag:popunder'));
}

/**
 * Trigger a Monetag interstitial ad.
 */
export function triggerInterstitial(): void {
  if (typeof window === 'undefined') return;

  document.dispatchEvent(new CustomEvent('monetag:interstitial'));
}

/**
 * Expose event names for external script binding.
 */
export const AD_EVENTS = MONETAG_EVENTS;
