import { attachSimProgress } from '../lib/download-progress';

export {};

const form = document.getElementById('snapchat-form') as HTMLFormElement;
const urlInput = document.getElementById('snapchat-url') as HTMLInputElement;
const clearBtn = document.getElementById('snapchat-clear') as HTMLButtonElement;
const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;
const btnLabel = document.getElementById('btn-label') as HTMLElement;
const btnSpinner = document.getElementById('btn-spinner') as HTMLElement;
const errorMsg = document.getElementById('error-msg') as HTMLElement;
const errorText = document.getElementById('error-text') as HTMLElement;
const resultMount = document.getElementById('result-mount') as HTMLElement;

const URL_PATTERN =
  /^(https?:\/\/)?(www\.|m\.|)?(snapchat\.com|story\.snapchat\.com)\//i;

function setLoading(loading: boolean) {
  downloadBtn.disabled = loading;
  btnLabel.hidden = loading;
  btnSpinner.hidden = !loading;
  const fetchNote = document.getElementById('fetch-note');
  if (fetchNote) fetchNote.hidden = !loading;
}

function showError(msg: string) {
  errorText.textContent = msg;
  errorMsg.removeAttribute('hidden');
  resultMount.innerHTML = '';
}

function hideError() {
  errorMsg.setAttribute('hidden', '');
}

function updateClearState() {
  clearBtn.hidden = !urlInput.value.trim();
}

urlInput.addEventListener('input', updateClearState);

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
      updateClearState();
    } else {
      target.focus();
    }
  });
});

clearBtn.addEventListener('click', () => {
  urlInput.value = '';
  urlInput.focus();
  updateClearState();
  hideError();
  resultMount.innerHTML = '';
});

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m + ':' + s.toString().padStart(2, '0');
}

const dlIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const musicIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

const MODE = (document.getElementById('download-form') as HTMLElement | null)?.dataset.mode || 'video';
const isMp3Mode = MODE === 'mp3';

// --- Cloudflare Turnstile for cobalt API auth ---
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
  if (typeof (window as any).turnstile === 'undefined') {
    // Script not loaded yet — retry in 500ms
    setTimeout(initTurnstile, 500);
    return;
  }
  const container = document.getElementById('cf-turnstile-container');
  if (!container) return;
  cleanupTurnstile();
  turnstileWidgetId = (window as any).turnstile.render(container, {
    sitekey: COBALT_TURNSTILE_SITEKEY,
    appearance: 'interaction-only',
    callback: (token: string) => { turnstileToken = token; turnstileReady = true; },
    'error-callback': () => { turnstileToken = null; turnstileReady = false; },
    'expired-callback': () => { turnstileToken = null; turnstileReady = false; },
  });
}
initTurnstile();

/** Get a fresh turnstile token — re-render if expired or missing. */
function getTurnstileToken(): Promise<string | null> {
  return new Promise((resolve) => {
    if (turnstileToken && turnstileReady) { resolve(turnstileToken); return; }
    // Re-render widget to get a fresh token
    const container = document.getElementById('cf-turnstile-container');
    if (!container || typeof (window as any).turnstile === 'undefined') { resolve(null); return; }
    cleanupTurnstile();
    container.innerHTML = '';
    turnstileWidgetId = (window as any).turnstile.render(container, {
      sitekey: COBALT_TURNSTILE_SITEKEY,
      appearance: 'interaction-only',
      callback: (token: string) => { turnstileToken = token; turnstileReady = true; resolve(token); },
      'error-callback': () => { turnstileToken = null; turnstileReady = false; resolve(null); },
      'expired-callback': () => { turnstileToken = null; turnstileReady = false; resolve(null); },
    });
    // Timeout fallback — if turnstile doesn't resolve in 8s, proceed without token
    setTimeout(() => resolve(turnstileToken), 8000);
  });
}
// --- End Turnstile ---

function renderResult(video: any, _inputUrl: string) {
  if (!video) {
    showError('No video data found. Please check the link and try again.');
    return;
  }

  const { thumbnail, duration, title, videoHd, videoSd, videoUrl } = video || {};
  const hdUrl: string = videoHd || videoUrl || '';
  const sdUrl: string = videoSd || videoHd || videoUrl || '';
  const videoTitle: string = title || 'Snapchat Video';

  const thumbHtml = thumbnail
    ? '<img src="' + thumbnail + '" alt="Snapchat media" class="sc-result-thumb" loading="lazy" width="120" height="160" referrerpolicy="no-referrer" onerror="this.closest(\'.sc-result-thumb-wrap\').classList.add(\'thumb-failed\')" />'
    : '<div class="sc-result-thumb-fallback" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></div>';

  const durationBadge = duration
    ? '<span class="sc-result-duration-badge">' + formatDuration(duration) + '</span>'
    : '';

  const hasHd = Boolean(hdUrl);
  const hasSd = Boolean(sdUrl);

  const hdTile = hasHd
    ? '<button class="sc-dl-tile" id="sc-btn-dl-hd" type="button" data-dl="hd" aria-label="Download HD video"><span class="sc-dl-tile-icon" aria-hidden="true">' + dlIcon + '</span><span class="sc-dl-tile-label">Download <strong>HD Video</strong></span><span class="sc-dl-badge" aria-hidden="true">HD</span><span class="sc-dl-proc-bar"></span></button>'
    : '';

  const sdTile = hasSd
    ? '<button class="sc-dl-tile" id="sc-btn-dl-sd" type="button" data-dl="sd" aria-label="Download SD video"><span class="sc-dl-tile-icon" aria-hidden="true">' + dlIcon + '</span><span class="sc-dl-tile-label">Download <strong>SD Video</strong></span><span class="sc-dl-proc-bar"></span></button>'
    : '';

  const audioTile = '<button class="sc-dl-tile sc-dl-tile-audio' + (isMp3Mode ? ' sc-dl-tile-prime' : '') + '" id="sc-btn-dl-audio" type="button" data-dl="audio" aria-label="Download audio as MP3"><span class="sc-dl-tile-icon" aria-hidden="true">' + musicIcon + '</span><span class="sc-dl-tile-label">Download <strong>Audio (MP3)</strong></span>' + (isMp3Mode ? '<span class="sc-dl-tile-badge">Recommended</span>' : '') + '<span class="sc-dl-proc-bar"></span></button>';

  const tiles = isMp3Mode
    ? [audioTile]
    : [hdTile, sdTile, audioTile].filter(Boolean).join('');

  resultMount.innerHTML =
    '<div class="sc-result-card animate-fade-in-up" role="region" aria-label="Download result">' +
      '<div class="sc-result-header">' +
        '<div class="sc-result-thumb-wrap">' +
          thumbHtml +
          durationBadge +
        '</div>' +
        '<div class="sc-result-info">' +
          '<div class="sc-result-meta">' +
            '<p class="sc-result-title">' + videoTitle.replace(/</g, '&lt;') + '</p>' +
          '</div>' +
          '<div class="sc-result-actions">' +
            tiles +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  if (!hasHd && !hasSd) {
    showError('No downloadable video found. Please try another link.');
  }

  resultMount.querySelectorAll<HTMLButtonElement>('.sc-dl-tile').forEach((btn) => {
    btn.addEventListener('click', () => startDownload(btn));
  });
}

function startDownload(btn: HTMLButtonElement) {
  const dlType = btn.dataset.dl;
  if (!dlType) return;

  const url = urlInput.value.trim();
  const labelEl = btn.querySelector('.sc-dl-tile-label') as HTMLElement;
  const origLabel = labelEl?.textContent || '';
  const bar = btn.querySelector('.sc-dl-proc-bar') as HTMLElement;

  btn.classList.add('sc-dl-tile-processing');
  btn.disabled = true;
  if (labelEl) labelEl.textContent = 'Processing… 0%';
  if (bar) { bar.style.transition = 'none'; bar.style.width = '0%'; }

  // Simulated progress — smooth 0→85% while server prepares the stream
  const sim = attachSimProgress(bar, labelEl, 'Processing…', { ceiling: 85, intervalMs: 250 });

  // Get fresh turnstile token before download
  getTurnstileToken().then((token) => {
    const xhr = new XMLHttpRequest();
    const tokenParam = token ? '&turnstileToken=' + encodeURIComponent(token) : '';
    xhr.open('GET', '/api/snapchat?url=' + encodeURIComponent(url) + '&dl=' + dlType + tokenParam);
  xhr.responseType = 'blob';
  xhr.timeout = 120_000;

  xhr.onprogress = function (e) {
    if (e.lengthComputable && bar && labelEl) {
      const pct = Math.round((e.loaded / e.total) * 100);
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
      a.download = dlType === 'audio' ? 'tiksavehub-snapchat-audio.mp3' : 'tiksavehub-snapchat-video.mp4';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      btn.classList.add('sc-dl-tile-done');
      if (labelEl) labelEl.innerHTML = origLabel;
      setTimeout(() => btn.classList.remove('sc-dl-tile-done'), 1500);
    } else {
      btn.classList.add('sc-dl-tile-error');
      if (labelEl) labelEl.textContent = 'Download failed — try again';
      setTimeout(() => {
        btn.classList.remove('sc-dl-tile-error');
        if (labelEl) labelEl.innerHTML = origLabel;
      }, 2000);
    }
    btn.classList.remove('sc-dl-tile-processing');
    btn.disabled = false;
    if (bar) bar.style.width = '0%';
  };

  xhr.onerror = function () {
    sim.stop();
    btn.classList.add('sc-dl-tile-error');
    if (labelEl) labelEl.textContent = 'Download failed — try again';
    setTimeout(() => {
      btn.classList.remove('sc-dl-tile-error');
      if (labelEl) labelEl.innerHTML = origLabel;
    }, 2000);
    btn.classList.remove('sc-dl-tile-processing');
    btn.disabled = false;
    if (bar) bar.style.width = '0%';
  };

  xhr.ontimeout = function () {
    sim.stop();
    btn.classList.add('sc-dl-tile-error');
    if (labelEl) labelEl.textContent = 'Timed out — try again';
    setTimeout(() => {
      btn.classList.remove('sc-dl-tile-error');
      if (labelEl) labelEl.innerHTML = origLabel;
    }, 2000);
    btn.classList.remove('sc-dl-tile-processing');
    btn.disabled = false;
    if (bar) bar.style.width = '0%';
  };

  xhr.send();
  }); // end getTurnstileToken().then
}

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  const url = urlInput.value.trim();

  if (!url) {
    showError('Please paste a Snapchat video URL.');
    return;
  }

  if (!URL_PATTERN.test(url)) {
    showError('Please enter a valid Snapchat link (e.g. snapchat.com/spotlight/..., story.snapchat.com/s/..., snapchat.com/p/..., snapchat.com/@user/highlight/..., or snapchat.com/@username for stories).');
    return;
  }

  setLoading(true);
  resultMount.innerHTML = '';

  try {
    const token = await getTurnstileToken();
    const res = await fetch('/api/snapchat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, turnstileToken: token || undefined }),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Invalid Snapchat link or the API is busy. Please check the link and try again.');
    }

    if (!res.ok || !json.success) {
      throw new Error(json.error || 'Failed to fetch the video. Please try again.');
    }

    renderResult(json.video, url);
  } catch (err: any) {
    showError(err.message || 'Something went wrong. Please try again.');
  } finally {
    setLoading(false);
  }
});
