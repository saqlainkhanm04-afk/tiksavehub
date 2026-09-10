/**
 * Shared download progress utilities for all download form components.
 * Provides simulated progress bars, loading cards, and phase text rotation.
 *
 * Usage in Astro <script> tags:
 *   import { attachSimProgress, showLoadingCard, startPhaseRotation } from '../../lib/download-progress';
 */

/* ------------------------------------------------------------------ */
/*  Simulated progress bar                                            */
/* ------------------------------------------------------------------ */

export interface SimProgressController {
  /** Stop the simulation. If realPct is provided, jump to that value. */
  stop: (realPct?: number) => void;
  /** Current simulated percentage (0–100). */
  current: number;
}

/**
 * Start a smooth simulated progress bar that advances from 0% toward a
 * ceiling while the real XHR is connecting / waiting for first bytes.
 *
 * When `xhr.onprogress` fires with real data, call `stop(realPct)` and
 * let the real progress take over.
 *
 * @param bar        – the `.dl-proc-bar` (or equivalent) element
 * @param labelEl    – the label element showing "Processing… X%"
 * @param labelPrefix – prefix before the percentage (default "Processing…")
 * @param opts       – ceiling (default 85), intervalMs (default 250)
 */
export function attachSimProgress(
  bar: HTMLElement | null,
  labelEl: HTMLElement | null,
  labelPrefix = 'Processing…',
  opts?: { ceiling?: number; intervalMs?: number },
): SimProgressController {
  const ceiling = opts?.ceiling ?? 85;
  const intervalMs = opts?.intervalMs ?? 250;
  let pct = 0;
  let stopped = false;

  const ctrl: SimProgressController = {
    current: 0,
    stop(realPct?: number) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (realPct != null && bar) {
        bar.style.transition = 'width 0.3s ease';
        bar.style.width = realPct + '%';
      }
      if (labelEl && realPct != null) {
        labelEl.textContent = labelPrefix + ' ' + Math.round(realPct) + '%';
      }
    },
  };

  // Ease-out progress: fast at start, slows as it approaches ceiling
  const timer = setInterval(() => {
    if (stopped) { clearInterval(timer); return; }
    // Ease-out quadratic: each step adds less
    const remaining = ceiling - pct;
    const step = Math.max(0.5, remaining * 0.08);
    pct = Math.min(pct + step, ceiling);
    ctrl.current = pct;
    if (bar) {
      bar.style.transition = 'none';
      bar.style.width = pct + '%';
    }
    if (labelEl) {
      labelEl.textContent = labelPrefix + ' ' + Math.round(pct) + '%';
    }
  }, intervalMs);

  return ctrl;
}

/* ------------------------------------------------------------------ */
/*  Loading card (shown during metadata POST phase)                   */
/* ------------------------------------------------------------------ */

export interface LoadingCardCleanup {
  /** Remove the loading card and stop phase rotation. */
  destroy: () => void;
  /** Update the sub-text manually (stops auto-rotation). */
  setSub: (text: string) => void;
}

const DEFAULT_PHASES = [
  'Connecting to server',
  'Extracting video data',
  'Preparing download links',
];

const LOADING_CARD_CSS = `
/* Download loading card — injected once via download-progress.ts */
.tsh-loading-card {
  display: flex;
  align-items: center;
  gap: var(--spacing-md, 16px);
  padding: var(--spacing-lg, 24px);
  background-color: var(--color-canvas, #fff);
  border-radius: var(--radius-lg, 16px);
  box-shadow:
    inset 0 0 0 1px #00000014,
    0px 2px 2px #0000000a,
    0px 8px 16px -4px #0000001a;
  animation: tsh-fade-in-up 0.35s ease both;
}
.tsh-loading-icon {
  position: relative;
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-grad-develop-start, #007cf0);
}
.tsh-loading-ring {
  position: absolute;
  inset: 0;
  border: 3px solid transparent;
  border-top-color: var(--color-grad-develop-start, #007cf0);
  border-radius: 50%;
  animation: tsh-spin 1s linear infinite;
}
.tsh-loading-ring::after {
  content: '';
  position: absolute;
  inset: 4px;
  border: 3px solid transparent;
  border-top-color: var(--color-grad-develop-end, #7928ca);
  border-radius: 50%;
  animation: tsh-spin 1.5s linear infinite reverse;
}
@keyframes tsh-spin { to { transform: rotate(360deg); } }
@keyframes tsh-fade-in-up {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.tsh-loading-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tsh-loading-title {
  font-weight: 600;
  font-size: var(--text-body, 15px);
  color: var(--color-ink, #1a1a1a);
}
.tsh-loading-sub {
  font-size: var(--text-caption, 13px);
  color: var(--color-mute, #888);
}
.tsh-loading-dots {
  display: flex;
  gap: 5px;
  flex-shrink: 0;
}
.tsh-loading-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-grad-develop-start, #007cf0);
  animation: tsh-dot 1.2s ease-in-out infinite;
}
.tsh-loading-dots span:nth-child(2) { animation-delay: 0.15s; }
.tsh-loading-dots span:nth-child(3) { animation-delay: 0.3s; }
@keyframes tsh-dot {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40%           { transform: scale(1);   opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .tsh-loading-ring, .tsh-loading-ring::after { animation: none; }
  .tsh-loading-dots span { animation: none; }
}
`;

let cssInjected = false;
function injectCardCss() {
  if (cssInjected) return;
  cssInjected = true;
  const s = document.createElement('style');
  s.textContent = LOADING_CARD_CSS;
  document.head.appendChild(s);
}

/**
 * Show a loading card in the given container.
 * Returns a cleanup handle to remove it.
 */
export function showLoadingCard(
  container: HTMLElement,
  opts?: { title?: string; phases?: string[]; icon?: string },
): LoadingCardCleanup {
  injectCardCss();

  const title = opts?.title ?? 'Fetching your video…';
  const phases = opts?.phases ?? DEFAULT_PHASES;
  const icon = opts?.icon ?? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

  const card = document.createElement('div');
  card.className = 'tsh-loading-card';
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  card.innerHTML = `
    <div class="tsh-loading-icon">
      <div class="tsh-loading-ring"></div>
      ${icon}
    </div>
    <div class="tsh-loading-text">
      <span class="tsh-loading-title">${title}</span>
      <span class="tsh-loading-sub" id="tsh-loading-sub">${phases[0]}</span>
    </div>
    <div class="tsh-loading-dots"><span></span><span></span><span></span></div>
  `;
  container.appendChild(card);

  // Phase text rotation
  let phaseIdx = 0;
  let destroyed = false;
  const subEl = card.querySelector('.tsh-loading-sub') as HTMLElement | null;

  const timer = setInterval(() => {
    if (destroyed) { clearInterval(timer); return; }
    phaseIdx = Math.min(phaseIdx + 1, phases.length - 1);
    if (subEl) subEl.textContent = phases[phaseIdx];
  }, 2500);

  return {
    destroy() {
      destroyed = true;
      clearInterval(timer);
      card.remove();
    },
    setSub(text: string) {
      destroyed = true;
      clearInterval(timer);
      if (subEl) subEl.textContent = text;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Phase text rotation (standalone, for elements already in DOM)     */
/* ------------------------------------------------------------------ */

/**
 * Rotate text through an array of phrases in the given element.
 * Returns a cleanup function.
 */
export function startPhaseRotation(
  el: HTMLElement,
  phrases: string[],
  intervalMs = 2500,
): () => void {
  let idx = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) { clearInterval(timer); return; }
    idx = Math.min(idx + 1, phrases.length - 1);
    el.textContent = phrases[idx];
  }, intervalMs);
  return () => { stopped = true; clearInterval(timer); };
}
