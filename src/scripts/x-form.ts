import { attachSimProgress, showLoadingCard as showLoadingCard_ } from '../lib/download-progress';

export {};

const form = document.getElementById('x-form') as HTMLFormElement;
const urlInput = document.getElementById('x-url') as HTMLInputElement;
const clearBtn = document.getElementById('x-clear') as HTMLButtonElement;
const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;
const btnLabel = document.getElementById('btn-label') as HTMLElement;
const btnSpinner = document.getElementById('btn-spinner') as HTMLElement;
const errorMsg = document.getElementById('error-msg') as HTMLElement;
const errorText = document.getElementById('error-text') as HTMLElement;
const resultMount = document.getElementById('result-mount') as HTMLElement;

const URL_PATTERN =
  /^(https?:\/\/)?(www\.|mobile\.|m\.|)?(twitter\.com|x\.com)\//i;

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
initTurnstile();
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
// --- End Turnstile ---

function setLoading(loading: boolean) {
  downloadBtn.disabled = loading;
  btnLabel.hidden = loading;
  btnSpinner.hidden = !loading;
  const fetchNote = document.getElementById('fetch-note');
  if (fetchNote) fetchNote.hidden = !loading;
}

function showLoadingCard() {
  const phases = ['Connecting to X', 'Extracting video data', 'Preparing download links'];
  (window as any).__xLoadingCard = showLoadingCard_(resultMount, {
    title: 'Fetching your video…',
    phases,
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  });
}

function clearLoadingCard() {
  const card = (window as any).__xLoadingCard;
  if (card) { card.destroy(); delete (window as any).__xLoadingCard; }
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

function formatCount(n: number): string {
  if (n == null) return '';
  return n.toLocaleString('en-US');
}

const dlIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const musicIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const eyeIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const heartIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
const rtIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';

function renderResult(video: any, inputUrl: string) {
  if (!video) {
    showError('No video data found. Please check the link and try again.');
    return;
  }

  const {
    username,
    authorName,
    authorAvatar,
    text,
    thumbnail,
    duration,
    viewCount,
    likeCount,
    retweetCount,
    hdUrl,
    sdUrl,
  } = video || {};

  const authorLine = authorName || username || '';
  const handleLine = username ? '@' + username.replace(/^@/, '') : '';

  const thumbHtml = thumbnail
    ? '<img src="' + thumbnail + '" alt="Tweet media" class="x-result-thumb" loading="lazy" width="120" height="160" referrerpolicy="no-referrer" onerror="this.closest(\'.x-result-thumb-wrap\').classList.add(\'thumb-failed\')" />'
    : '<div class="x-result-thumb-fallback" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></div>';

  const durationBadge = duration
    ? '<span class="x-result-duration-badge">' + formatDuration(duration) + '</span>'
    : '';

  const avatarHtml = authorAvatar
    ? '<img src="' + authorAvatar + '" alt="' + (authorLine || 'Author') + '" class="x-result-author-avatar" width="40" height="40" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'" />'
    : '';

  const statsParts: string[] = [];
  if (viewCount != null) {
    statsParts.push(
      '<span class="x-result-stat">' + eyeIcon + ' ' + formatCount(viewCount) + ' views</span>'
    );
  }
  if (likeCount != null) {
    statsParts.push(
      '<span class="x-result-stat">' + heartIcon + ' ' + formatCount(likeCount) + '</span>'
    );
  }
  if (retweetCount != null) {
    statsParts.push(
      '<span class="x-result-stat">' + rtIcon + ' ' + formatCount(retweetCount) + '</span>'
    );
  }

  const hasHd = Boolean(hdUrl);
  const hasSd = Boolean(sdUrl);

  const hdTile = hasHd
    ? '<button class="x-dl-tile" id="x-btn-dl-hd" type="button" data-dl="hd" data-url="' + encodeURIComponent(inputUrl) + '" aria-label="Download HD video"><span class="x-dl-tile-icon" aria-hidden="true">' + dlIcon + '</span><span class="x-dl-tile-label">Download <strong>HD Video</strong></span><span class="x-dl-badge" aria-hidden="true">HD</span><span class="x-dl-proc-bar"></span></button>'
    : '';

  const sdTile = hasSd
    ? '<button class="x-dl-tile" id="x-btn-dl-sd" type="button" data-dl="sd" data-url="' + encodeURIComponent(inputUrl) + '" aria-label="Download SD video"><span class="x-dl-tile-icon" aria-hidden="true">' + dlIcon + '</span><span class="x-dl-tile-label">Download <strong>SD Video</strong></span><span class="x-dl-proc-bar"></span></button>'
    : '';

  const audioTile = '<button class="x-dl-tile x-dl-tile-audio" id="x-btn-dl-audio" type="button" data-dl="audio" data-url="' + encodeURIComponent(inputUrl) + '" aria-label="Download audio as MP3"><span class="x-dl-tile-icon" aria-hidden="true">' + musicIcon + '</span><span class="x-dl-tile-label">Download <strong>Audio (MP3)</strong></span><span class="x-dl-proc-bar"></span></button>';

  const tiles = [hdTile, sdTile, audioTile].filter(Boolean).join('');

  const tweetTextHtml = text
    ? '<p class="x-result-tweet-text">' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>'
    : '';

  resultMount.innerHTML =
    '<div class="x-result-card animate-fade-in-up" role="region" aria-label="Download result">' +
      '<div class="x-result-header">' +
        '<div class="x-result-thumb-wrap">' +
          thumbHtml +
          durationBadge +
        '</div>' +
        '<div class="x-result-info">' +
          (authorLine
            ? '<div class="x-result-author">' +
                avatarHtml +
                '<div>' +
                  '<p class="x-result-author-name">' + authorLine.replace(/</g, '&lt;') + '</p>' +
                  (handleLine ? '<p class="x-result-author-username">' + handleLine.replace(/</g, '&lt;') + '</p>' : '') +
                '</div>' +
              '</div>'
            : '') +
          tweetTextHtml +
          (statsParts.length ? '<div class="x-result-stats">' + statsParts.join('') + '</div>' : '') +
          '<div class="x-result-actions">' +
            tiles +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  if (!hasHd && !hasSd) {
    showError('No downloadable video found. The tweet may only contain a GIF or image.');
  }

  resultMount.querySelectorAll<HTMLButtonElement>('.x-dl-tile').forEach((btn) => {
    btn.addEventListener('click', () => startDownload(btn));
  });
}

function startDownload(btn: HTMLButtonElement) {
  const dlType = btn.dataset.dl;
  const encodedUrl = btn.dataset.url;
  if (!dlType || !encodedUrl) return;

  const labelEl = btn.querySelector('.x-dl-tile-label') as HTMLElement;
  const origLabel = labelEl?.textContent || '';
  const bar = btn.querySelector('.x-dl-proc-bar') as HTMLElement;

  btn.classList.add('x-dl-tile-processing');
  btn.disabled = true;
  if (labelEl) labelEl.textContent = 'Processing… 0%';
  if (bar) { bar.style.transition = 'none'; bar.style.width = '0%'; }

  // Simulated progress — smooth 0→85% while server prepares the stream
  const sim = attachSimProgress(bar, labelEl, 'Processing…', { ceiling: 85, intervalMs: 250 });

  const xhr = new XMLHttpRequest();
  getTurnstileToken().then((token) => {
  const tokenParam = token ? '&turnstileToken=' + encodeURIComponent(token) : '';
  xhr.open('GET', '/api/x-download?url=' + decodeURIComponent(encodedUrl) + '&dl=' + dlType + tokenParam);
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
      a.download = dlType === 'audio' ? 'tiksavehub-audio.mp3' : 'tiksavehub-video.mp4';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      btn.classList.add('x-dl-tile-done');
      if (labelEl) labelEl.innerHTML = origLabel;
      setTimeout(() => btn.classList.remove('x-dl-tile-done'), 1500);
    } else {
      btn.classList.add('x-dl-tile-error');
      if (labelEl) labelEl.textContent = 'Download failed — try again';
      setTimeout(() => {
        btn.classList.remove('x-dl-tile-error');
        if (labelEl) labelEl.innerHTML = origLabel;
      }, 2000);
    }
    btn.classList.remove('x-dl-tile-processing');
    btn.disabled = false;
    if (bar) bar.style.width = '0%';
  };

  xhr.onerror = function () {
    sim.stop();
    btn.classList.add('x-dl-tile-error');
    if (labelEl) labelEl.textContent = 'Download failed — try again';
    setTimeout(() => {
      btn.classList.remove('x-dl-tile-error');
      if (labelEl) labelEl.innerHTML = origLabel;
    }, 2000);
    btn.classList.remove('x-dl-tile-processing');
    btn.disabled = false;
    if (bar) bar.style.width = '0%';
  };

  xhr.ontimeout = function () {
    sim.stop();
    btn.classList.add('x-dl-tile-error');
    if (labelEl) labelEl.textContent = 'Timed out — try again';
    setTimeout(() => {
      btn.classList.remove('x-dl-tile-error');
      if (labelEl) labelEl.innerHTML = origLabel;
    }, 2000);
    btn.classList.remove('x-dl-tile-processing');
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
    showError('Please paste an X or Twitter video URL.');
    return;
  }

  if (!URL_PATTERN.test(url)) {
    showError('Please enter a valid X or Twitter video link (e.g. x.com/user/status/... or twitter.com/user/status/...).');
    return;
  }

  setLoading(true);
  resultMount.innerHTML = '';
  showLoadingCard();

  try {
    const token = await getTurnstileToken();
    const res = await fetch('/api/x-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, turnstileToken: token || undefined }),
    });
    clearLoadingCard();
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Invalid X link or the API is busy. Please check the link and try again.');
    }

    if (!res.ok || !json.success) {
      throw new Error(json.error || 'Failed to fetch the video. Please try again.');
    }

    renderResult(json.video, url);
  } catch (err: any) {
    clearLoadingCard();
    showError(err.message || 'Something went wrong. Please try again.');
  } finally {
    setLoading(false);
  }
});
