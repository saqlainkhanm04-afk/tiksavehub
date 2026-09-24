import { attachSimProgress } from '../lib/download-progress';

export {};

const form = document.getElementById('tiktok-form') as HTMLFormElement;
const urlInput = document.getElementById('tiktok-url') as HTMLInputElement;
const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;
const btnLabel = document.getElementById('btn-label') as HTMLElement;
const btnSpinner = document.getElementById('btn-spinner') as HTMLElement;
const errorMsg = document.getElementById('error-msg') as HTMLElement;
const errorText = document.getElementById('error-text') as HTMLElement;
const resultMount = document.getElementById('result-mount') as HTMLElement;

const COBALT_TURNSTILE_SITEKEY = '0x4AAAAAAEl-ZmiorHhgs7jw';
let turnstileToken: string | null = null;
let turnstileReady = false;
let turnstileWidgetId: string | null = null;

function cleanupTurnstile() {
  if (turnstileWidgetId !== null && typeof (window as any).turnstile !== 'undefined') {
    try { (window as any).turnstile.remove(turnstileWidgetId); } catch {}
    turnstileWidgetId = null;
  }
}

function initTurnstile() {
  if (typeof (window as any).turnstile === 'undefined') { setTimeout(initTurnstile, 500); return; }
  const c = document.getElementById('cf-turnstile-container');
  if (!c) return;
  cleanupTurnstile();
  turnstileWidgetId = (window as any).turnstile.render(c, { sitekey: COBALT_TURNSTILE_SITEKEY, appearance: 'interaction-only',
    callback: (t: string) => { turnstileToken = t; turnstileReady = true; },
    'error-callback': () => { turnstileToken = null; turnstileReady = false; },
    'expired-callback': () => { turnstileToken = null; turnstileReady = false; },
  });
}
setTimeout(initTurnstile, 1000);

function getTurnstileToken(): Promise<string | null> {
  return new Promise((resolve) => {
    if (turnstileToken && turnstileReady) { resolve(turnstileToken); return; }
    const c = document.getElementById('cf-turnstile-container');
    if (!c || typeof (window as any).turnstile === 'undefined') { resolve(null); return; }
    cleanupTurnstile();
    c.innerHTML = '';
    turnstileWidgetId = (window as any).turnstile.render(c, { sitekey: COBALT_TURNSTILE_SITEKEY, appearance: 'interaction-only',
      callback: (t: string) => { turnstileToken = t; turnstileReady = true; resolve(t); },
      'error-callback': () => { turnstileToken = null; turnstileReady = false; resolve(null); },
      'expired-callback': () => { turnstileToken = null; turnstileReady = false; resolve(null); },
    });
    setTimeout(() => resolve(turnstileToken), 8000);
  });
}

document.querySelectorAll<HTMLButtonElement>('.paste-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = document.getElementById(btn.dataset.pasteTarget || '') as HTMLInputElement | null;
    if (!target) return;
    let text = '';
    try {
      if (navigator.clipboard && window.isSecureContext) {
        text = await navigator.clipboard.readText();
      } else if ((window as any).clipboardData && (window as any).clipboardData.getData) {
        text = (window as any).clipboardData.getData('Text');
      }
    } catch {}
    if (text) {
      target.value = text.trim();
      target.focus();
    } else {
      target.focus();
    }
  });
});

function setLoading(loading: boolean) {
  downloadBtn.disabled = loading;
  btnLabel.hidden = loading;
  btnSpinner.hidden = !loading;
}

function showError(msg: string) {
  errorText.textContent = msg;
  errorMsg.removeAttribute('hidden');
  resultMount.innerHTML = '';
}

function hideError() {
  errorMsg.setAttribute('hidden', '');
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function proxyThumb(url: string | null | undefined): string {
  if (!url) return '';
  return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}

function renderResult(data: any, inputUrl: string) {
  const {
    cover,      // thumbnail
    duration,
  } = data;

  const thumbSrc = proxyThumb(cover);

  resultMount.innerHTML = `
    <div class="result-card animate-fade-in-up" role="region" aria-label="Download result">
      <div class="result-header">
        <div class="result-thumb-wrap">
          <img
            src="${thumbSrc}"
            alt="Video thumbnail"
            class="result-thumb"
            referrerpolicy="no-referrer"
            loading="lazy"
            width="120"
            height="160"
            onerror="this.style.display='none'" />
          <span class="result-duration-badge text-caption-mono">${formatDuration(duration || 0)}</span>
        </div>
        <div class="result-info">
          <div class="result-actions">
        <button class="dl-tile dl-tile-sd" id="btn-dl-sd" type="button" aria-label="Download video without watermark">
          <span class="dl-tile-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span>
          <span class="dl-tile-label">Without Watermark</span>
          <span class="dl-proc-bar"></span>
        </button>
        <button class="dl-tile dl-tile-hd" id="btn-dl-hd" type="button" aria-label="Download HD video without watermark">
          <span class="dl-tile-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span>
          <span class="dl-tile-label">Without Watermark <strong>HD</strong></span>
          <span class="dl-proc-bar"></span>
        </button>
      </div>
        </div>
      </div>
    </div>
  `;

  const sdBtn = document.getElementById('btn-dl-sd') as HTMLButtonElement;
  const hdBtn = document.getElementById('btn-dl-hd') as HTMLButtonElement;
  const origUrl = inputUrl;

  function startDownload(type: string, btn: HTMLButtonElement) {
    btn.classList.add('dl-tile-processing');
    btn.disabled = true;
    const labelEl = btn.querySelector('.dl-tile-label') as HTMLElement;
    const origLabel = labelEl?.textContent || '';
    if (labelEl) labelEl.textContent = 'Fetching…';
    const bar = btn.querySelector('.dl-proc-bar') as HTMLElement;
    if (bar) { bar.style.transition = 'none'; bar.style.width = '0%'; }
    const fetchNote = document.getElementById('fetch-note');
    if (fetchNote) fetchNote.hidden = false;

    // Simulated progress — smooth 0→85% while server prepares the stream
    const sim = attachSimProgress(bar, labelEl, 'Processing…', { ceiling: 85, intervalMs: 250 });

    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/api/download?url=${encodeURIComponent(origUrl)}&dl=${type}`);
    xhr.responseType = 'blob';
    xhr.timeout = 120_000;

    xhr.onprogress = function (e) {
      if (e.lengthComputable && bar && labelEl) {
        const pct = Math.round((e.loaded / e.total) * 100);
        // Real progress arrived — stop simulation, use real value
        sim.stop(pct);
      }
    };

    xhr.onload = function () {
      sim.stop(xhr.status === 200 ? 100 : undefined);
      if (xhr.status === 200) {
        const blob = xhr.response;
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = 'tiksavehub-video.mp4';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
        btn.classList.add('dl-tile-done');
        setTimeout(() => btn.classList.remove('dl-tile-done'), 1500);
      } else {
        btn.classList.add('dl-tile-error');
        setTimeout(() => btn.classList.remove('dl-tile-error'), 2000);
      }
      btn.classList.remove('dl-tile-processing');
      btn.disabled = false;
      if (labelEl) labelEl.textContent = origLabel;
      if (bar) bar.style.width = '0%';
      const fetchNoteDone = document.getElementById('fetch-note');
      if (fetchNoteDone) fetchNoteDone.hidden = true;
    };

    xhr.onerror = function () {
      sim.stop();
      btn.classList.add('dl-tile-error');
      setTimeout(() => btn.classList.remove('dl-tile-error'), 2000);
      btn.classList.remove('dl-tile-processing');
      btn.disabled = false;
      if (labelEl) labelEl.textContent = origLabel;
      if (bar) bar.style.width = '0%';
      const fetchNoteErr = document.getElementById('fetch-note');
      if (fetchNoteErr) fetchNoteErr.hidden = true;
    };

    xhr.ontimeout = function () {
      sim.stop();
      btn.classList.add('dl-tile-error');
      if (labelEl) labelEl.textContent = 'Timed out — try again';
      setTimeout(() => {
        btn.classList.remove('dl-tile-error');
        if (labelEl) labelEl.textContent = origLabel;
      }, 2000);
      btn.classList.remove('dl-tile-processing');
      btn.disabled = false;
      if (bar) bar.style.width = '0%';
      const fetchNoteErr = document.getElementById('fetch-note');
      if (fetchNoteErr) fetchNoteErr.hidden = true;
    };

    xhr.send();
  }

  sdBtn?.addEventListener('click', () => startDownload('sd', sdBtn));
  hdBtn?.addEventListener('click', () => startDownload('hd', hdBtn));
}

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  const url = urlInput.value.trim();

  if (!url) {
    showError('Please paste a TikTok video URL.');
    return;
  }

  if (!url.includes('tiktok.com') && !url.includes('vm.tiktok.com') && !url.includes('vt.tiktok.com')) {
    showError('Please enter a valid TikTok video URL (e.g. https://www.tiktok.com/@user/video/…)');
    return;
  }

  setLoading(true);
  resultMount.innerHTML = '';

  try {
    const token = await getTurnstileToken();
    const tokenParam = token ? '&turnstileToken=' + encodeURIComponent(token) : '';
    const res = await fetch(`/api/download?url=${encodeURIComponent(url)}${tokenParam}`);
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Invalid TikTok link or API is busy. Please check the link and try again.');
    }

    if (!res.ok || !json.success) {
      throw new Error(json.error || 'Failed to fetch video. Please try again.');
    }

    renderResult(json.video, url);
  } catch (err: any) {
    showError(err.message || 'Something went wrong. Please try again.');
  } finally {
    setLoading(false);
  }
});
