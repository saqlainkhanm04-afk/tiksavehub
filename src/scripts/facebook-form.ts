export {};

const form = document.getElementById('facebook-form') as HTMLFormElement;
const urlInput = document.getElementById('facebook-url') as HTMLInputElement;
const clearBtn = document.getElementById('facebook-clear') as HTMLButtonElement;
const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;
const btnLabel = document.getElementById('btn-label') as HTMLElement;
const btnSpinner = document.getElementById('btn-spinner') as HTMLElement;
const errorMsg = document.getElementById('error-msg') as HTMLElement;
const errorText = document.getElementById('error-text') as HTMLElement;
const resultMount = document.getElementById('result-mount') as HTMLElement;

const URL_PATTERN =
  /^(https?:\/\/)?(www\.|m\.|mbasic\.|web\.|touch\.)?(facebook\.com|fb\.com)\//i;
const SHORT_PATTERN = /^(https?:\/\/)?fb\.watch\//i;

function setLoading(loading: boolean) {
  downloadBtn.disabled = loading;
  btnLabel.hidden = loading;
  btnSpinner.hidden = !loading;
  const fetchNote = document.getElementById('fetch-note');
  if (fetchNote) fetchNote.hidden = !loading;
}

function showError(msg: string, errorType: string | null = null) {
  errorText.textContent = msg;
  errorMsg.removeAttribute('hidden');
  resultMount.innerHTML = '';

  // Remove old retry button if present
  const oldRetry = document.getElementById('retry-btn');
  if (oldRetry) oldRetry.remove();

  // Add retry button for transient errors
  if (errorType === 'timeout' || errorType === null) {
    const retryBtn = document.createElement('button');
    retryBtn.id = 'retry-btn';
    retryBtn.className = 'error-retry-btn';
    retryBtn.type = 'button';
    retryBtn.textContent = 'Try Again';
    retryBtn.addEventListener('click', () => {
      hideError();
      form?.dispatchEvent(new Event('submit', { cancelable: true }));
    });
    errorMsg.appendChild(retryBtn);
  }
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
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const dlIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const musicIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

import { attachSimProgress } from '../lib/download-progress';

const MODE = (document.getElementById('download-form') as HTMLElement | null)?.dataset.mode || 'video';
const isMp3Mode = MODE === 'mp3';
const isPhotoMode = MODE === 'photo';
const isStoryMode = MODE === 'story';

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

function renderResult(data: any, inputUrl: string) {
  const { cover, duration, title, hdplay, sdplay, play } = data || {};
  const hdUrl: string = hdplay || play || '';
  const sdUrl: string = sdplay || play || '';
  const videoTitle: string = title || (isMp3Mode ? 'Facebook Audio' : isPhotoMode ? 'Facebook Photo' : 'Facebook Video');

  if (isStoryMode) {
    const segments: any[] = Array.isArray(data.segments) ? data.segments : [];
    const count = segments.length;
    const storyTitle: string = data.title || videoTitle;
    if (!count) {
      showError('This story has no downloadable media.');
      return;
    }

    const zipTile =
      count > 1
        ? `
        <button class="dl-tile dl-tile-fb dl-tile-prime" id="btn-dl-zip" type="button" aria-label="Download all ${count} media files as ZIP">
          <span class="dl-tile-icon" aria-hidden="true">${dlIcon}</span>
          <span class="dl-tile-label">Download <strong>All Media</strong> (${count} items)</span>
          <span class="dl-tile-badge">ZIP</span>
          <span class="dl-proc-bar"></span>
        </button>`
        : '';

    const rows = segments
      .map((s, i) => {
        const isVideo = s.kind === 'video';
        const segTitle: string = s.title || (isVideo ? `Story Video ${i + 1}` : `Story Photo ${i + 1}`);
        const segCover: string = s.cover || '';
        const thumb = segCover
          ? `<img src="${segCover}" alt="${segTitle}" class="story-seg-thumb" loading="lazy" width="56" height="56" referrerpolicy="no-referrer" data-proxy="0" onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.closest('.story-seg-thumb-wrap').classList.add('thumb-failed')}">`
          : `<div class="story-seg-thumb story-seg-thumb-fallback" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
                <line x1="7" y1="2" x2="7" y2="22"/>
                <line x1="17" y1="2" x2="17" y2="22"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <line x1="2" y1="7" x2="7" y2="7"/>
                <line x1="2" y1="17" x2="7" y2="17"/>
                <line x1="17" y1="17" x2="22" y2="17"/>
                <line x1="17" y1="7" x2="22" y2="7"/>
              </svg>
            </div>`;
        const buttons = isVideo
          ? `
            <button class="dl-tile dl-tile-fb" id="btn-dl-hd-${i}" type="button" aria-label="Download HD video ${i + 1}">
              <span class="dl-tile-icon" aria-hidden="true">${dlIcon}</span>
              <span class="dl-tile-label">Download <strong>HD Video</strong></span>
              <span class="dl-hd-badge" aria-hidden="true">HD</span>
              <span class="dl-proc-bar"></span>
            </button>
            <button class="dl-tile" id="btn-dl-sd-${i}" type="button" aria-label="Download SD video ${i + 1}">
              <span class="dl-tile-icon" aria-hidden="true">${dlIcon}</span>
              <span class="dl-tile-label">Download <strong>SD Video</strong></span>
              <span class="dl-proc-bar"></span>
            </button>`
          : `
            <button class="dl-tile dl-tile-fb" id="btn-dl-photo-${i}" type="button" aria-label="Download photo ${i + 1}">
              <span class="dl-tile-icon" aria-hidden="true">${dlIcon}</span>
              <span class="dl-tile-label">Download <strong>Photo</strong></span>
              <span class="dl-proc-bar"></span>
            </button>`;
        return `
          <div class="story-seg" role="group" aria-label="${segTitle}">
            <div class="story-seg-head">
              <div class="story-seg-thumb-wrap">
                ${thumb}
                ${isVideo && s.duration ? `<span class="result-duration-badge">${formatDuration(s.duration)}</span>` : ''}
              </div>
              <div class="story-seg-meta">
                <p class="story-seg-title">${segTitle}</p>
                <p class="story-seg-type">${isVideo ? 'Video' : 'Photo'} ${i + 1} of ${count}</p>
              </div>
            </div>
            <div class="result-actions">
              ${buttons}
            </div>
          </div>`;
      })
      .join('');

    resultMount.innerHTML = `
      <div class="result-card animate-fade-in-up" role="region" aria-label="Download result">
        <div class="result-header">
          <div class="result-thumb-wrap">
            <img
              src="${cover || ''}"
              alt="Story thumbnail"
              class="result-thumb"
              loading="lazy"
              width="120"
              height="160"
              referrerpolicy="no-referrer"
              data-proxy="0"
              onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.closest('.result-thumb-wrap').classList.add('thumb-failed')}"
              ${!cover ? 'hidden' : ''} />
            ${!cover ? `<div class="result-thumb-fallback" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
                <line x1="7" y1="2" x2="7" y2="22"/>
                <line x1="17" y1="2" x2="17" y2="22"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <line x1="2" y1="7" x2="7" y2="7"/>
                <line x1="2" y1="17" x2="7" y2="17"/>
                <line x1="17" y1="17" x2="22" y2="17"/>
                <line x1="17" y1="7" x2="22" y2="7"/>
              </svg>
            </div>` : ''}
          </div>
          <div class="result-info">
            <div class="result-meta">
              <p class="result-title">${storyTitle}</p>
              ${count > 1 ? `<p class="photo-count">${count} items found in this story</p>` : ''}
            </div>
            <div class="result-actions">
              ${zipTile}
            </div>
          </div>
        </div>
        ${rows}
      </div>
    `;

    const zipBtn = document.getElementById('btn-dl-zip') as HTMLButtonElement | null;
    zipBtn?.addEventListener('click', () => startDownload('zip', zipBtn));
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const isVideo = s.kind === 'video';
      const hdB = document.getElementById(`btn-dl-hd-${i}`) as HTMLButtonElement | null;
      const sdB = document.getElementById(`btn-dl-sd-${i}`) as HTMLButtonElement | null;
      const phB = document.getElementById(`btn-dl-photo-${i}`) as HTMLButtonElement | null;
      hdB?.addEventListener('click', () => startDownload('hd', hdB, i));
      sdB?.addEventListener('click', () => startDownload('sd', sdB, i));
      phB?.addEventListener('click', () => startDownload('photo', phB, i));
      if (!isVideo) continue;
      const hdOk = Boolean(s.hdplay || s.sdplay);
      const sdOk = Boolean(s.sdplay || s.hdplay);
      if (!hdOk) hdB?.setAttribute('disabled', '');
      if (!sdOk) sdB?.setAttribute('disabled', '');
    }
    return;
  }

  if (isPhotoMode) {
    const photos: any[] =
      Array.isArray(data.photos) && data.photos.length ? data.photos : data.photoUrl ? [data] : [];
    const photoHref: string = (photos[0] && (photos[0].photoUrl || photos[0].cover)) || '';
    const count = photos.length;
    const totalCount: number = data.totalPhotoCount || count;

    const PREVIEW_PHOTOS = 5;
    const gridHtml =
      count > 1
        ? `<div class="photo-grid" role="list" aria-label="Photos found in this post">
            ${photos
              .map(
                (p, i) =>
                  `<img class="photo-grid-item${i >= PREVIEW_PHOTOS ? ' photo-grid-hidden' : ''}" src="${p.cover || p.photoUrl || ''}" alt="Facebook photo ${i + 1} of ${count}" loading="lazy" width="120" height="120" referrerpolicy="no-referrer" data-proxy="0" onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.style.display='none'}">`
              )
              .join('')}
            ${count > PREVIEW_PHOTOS ? `<button type="button" class="photo-grid-item photo-grid-more" id="btn-grid-more" aria-label="Show all ${count} photos">+${count - PREVIEW_PHOTOS}</button>` : ''}
          </div>`
        : '';

    const btnLabel =
      count > 1
        ? 'Download <strong>All Photos</strong>'
        : 'Download <strong>Photo</strong>';
    const badge =
      count > 1
        ? '<span class="dl-tile-badge">' + count + ' Photos · ZIP</span>'
        : '<span class="dl-tile-badge">Full Resolution</span>';
    const moreOnFb = totalCount > count
      ? `<p class="photo-count-extra">This post has ${totalCount} photos. Showing ${count} available for download. The remaining ${totalCount - count} photos require Facebook login to access.</p>`
      : '';

    resultMount.innerHTML = `
      <div class="result-card animate-fade-in-up" role="region" aria-label="Download result">
        <div class="result-header">
          <div class="result-thumb-wrap photo-preview">
            <img
              src="${cover || photoHref || ''}"
              alt="Facebook photo preview"
              class="result-thumb"
              loading="lazy"
              width="200"
              height="200"
              referrerpolicy="no-referrer"
              data-proxy="0"
              onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.closest('.result-thumb-wrap').classList.add('thumb-failed')}"
              ${!cover && !photoHref ? 'hidden' : ''} />
            ${!cover && !photoHref ? `<div class="result-thumb-fallback" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
                <line x1="7" y1="2" x2="7" y2="22"/>
                <line x1="17" y1="2" x2="17" y2="22"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <line x1="2" y1="7" x2="7" y2="7"/>
                <line x1="2" y1="17" x2="7" y2="17"/>
                <line x1="17" y1="17" x2="22" y2="17"/>
                <line x1="17" y1="7" x2="22" y2="7"/>
              </svg>
            </div>` : ''}
          </div>
          <div class="result-info">
            <div class="result-meta">
              <p class="result-title">${videoTitle}</p>
              ${count > 1 ? `<p class="photo-count">${count} photos found in this post</p>` : ''}
              ${moreOnFb}
            </div>
            <div class="result-actions">
              <button class="dl-tile dl-tile-fb dl-tile-prime" id="btn-dl-photo" type="button" aria-label="Download Facebook photos">
                <span class="dl-tile-icon" aria-hidden="true">${dlIcon}</span>
                <span class="dl-tile-label">${btnLabel}</span>
                ${badge}
                <span class="dl-proc-bar"></span>
              </button>
            </div>
          </div>
        </div>
        ${gridHtml}
      </div>
    `;

    const photoBtn = document.getElementById('btn-dl-photo') as HTMLButtonElement | null;
    if (!photoBtn) return;
    if (!photoHref) photoBtn.setAttribute('disabled', '');
    else {
      photoBtn.addEventListener('click', () => startDownload(count > 1 ? 'zip' : 'photo', photoBtn));
    }
    const moreBtn = document.getElementById('btn-grid-more') as HTMLButtonElement | null;
    moreBtn?.addEventListener('click', () => {
      resultMount.querySelectorAll('.photo-grid-hidden').forEach((el) => el.classList.remove('photo-grid-hidden'));
      moreBtn.remove();
    });
    return;
  }

  const hdTile = `
    <button class="dl-tile dl-tile-fb" id="btn-dl-hd" type="button" aria-label="Download HD video">
      <span class="dl-tile-icon" aria-hidden="true">${dlIcon}</span>
      <span class="dl-tile-label">Download <strong>HD Video</strong></span>
      <span class="dl-hd-badge" aria-hidden="true">HD</span>
      <span class="dl-proc-bar"></span>
    </button>`;

  const sdTile = `
    <button class="dl-tile" id="btn-dl-sd" type="button" aria-label="Download SD video">
      <span class="dl-tile-icon" aria-hidden="true">${dlIcon}</span>
      <span class="dl-tile-label">Download <strong>SD Video</strong></span>
      <span class="dl-proc-bar"></span>
    </button>`;

  const audioTile = `
    <button class="dl-tile dl-tile-audio${isMp3Mode ? ' dl-tile-prime' : ''}" id="btn-dl-audio" type="button" aria-label="Download audio as MP3">
      <span class="dl-tile-icon" aria-hidden="true">${musicIcon}</span>
      <span class="dl-tile-label">Download <strong>Audio (MP3)</strong></span>
      ${isMp3Mode ? '<span class="dl-tile-badge">Recommended</span>' : ''}
      <span class="dl-proc-bar"></span>
    </button>`;

  const tiles = isMp3Mode ? [audioTile] : [hdTile, sdTile];

  resultMount.innerHTML = `
    <div class="result-card animate-fade-in-up" role="region" aria-label="Download result">
      <div class="result-header">
        <div class="result-thumb-wrap">
          <img
            src="${cover || ''}"
            alt="Video thumbnail"
            class="result-thumb"
            loading="lazy"
            width="120"
            height="160"
            referrerpolicy="no-referrer"
            data-proxy="0"
            onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.closest('.result-thumb-wrap').classList.add('thumb-failed')}"
            ${!cover ? 'hidden' : ''} />
          ${!cover ? `<div class="result-thumb-fallback" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
              <line x1="7" y1="2" x2="7" y2="22"/>
              <line x1="17" y1="2" x2="17" y2="22"/>
              <line x1="2" y1="12" x2="22" y2="12"/>
              <line x1="2" y1="7" x2="7" y2="7"/>
              <line x1="2" y1="17" x2="7" y2="17"/>
              <line x1="17" y1="17" x2="22" y2="17"/>
              <line x1="17" y1="7" x2="22" y2="7"/>
            </svg>
          </div>` : ''}
          <span class="result-duration-badge text-caption-mono">${formatDuration(duration || 0)}</span>
        </div>
        <div class="result-info">
          <div class="result-meta">
            <p class="result-title">${videoTitle}</p>
          </div>
          <div class="result-actions">
            ${tiles.join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  const hdBtn = document.getElementById('btn-dl-hd') as HTMLButtonElement | null;
  const sdBtn = document.getElementById('btn-dl-sd') as HTMLButtonElement | null;
  const audioBtn = document.getElementById('btn-dl-audio') as HTMLButtonElement | null;

  if (!hdUrl || !hdBtn) hdBtn?.setAttribute('disabled', '');
  if (!sdUrl || !sdBtn) sdBtn?.setAttribute('disabled', '');

  function startDownload(mode: string, btn: HTMLButtonElement | null, idx?: number) {
    if (!btn) return;
    btn.classList.add('dl-tile-processing');
    btn.disabled = true;
    const labelEl = btn.querySelector('.dl-tile-label') as HTMLElement | null;
    const origLabel = labelEl?.textContent || '';
    if (labelEl) labelEl.textContent = 'Processing… 0%';
    const bar = btn.querySelector('.dl-proc-bar') as HTMLElement | null;
    if (bar) {
      bar.style.transition = 'none';
      bar.style.width = '0%';
    }

    // Simulated progress — smooth 0→85% while server prepares the stream
    const sim = attachSimProgress(bar, labelEl, 'Processing…', { ceiling: 85, intervalMs: 250 });

    const xhr = new XMLHttpRequest();
    const idxParam = typeof idx === 'number' && idx >= 0 ? `&idx=${idx}` : '';
    getTurnstileToken().then((token) => {
    const tokenParam = token ? '&turnstileToken=' + encodeURIComponent(token) : '';
    xhr.open(
      'GET',
      `/api/facebook?url=${encodeURIComponent(inputUrl)}&dl=${mode}${idxParam}${tokenParam}`
    );
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
        a.download =
          mode === 'audio' ? 'tiksavehub-facebook-audio.mp3' :
          mode === 'photo' ? 'tiksavehub-facebook-photo.jpg' :
          mode === 'zip' ? (isStoryMode ? 'tiksavehub-facebook-story.zip' : 'tiksavehub-facebook-photos.zip') :
          'tiksavehub-facebook-video.mp4';
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
    };

    xhr.onerror = function () {
      sim.stop();
      btn.classList.add('dl-tile-error');
      setTimeout(() => btn.classList.remove('dl-tile-error'), 2000);
      btn.classList.remove('dl-tile-processing');
      btn.disabled = false;
      if (labelEl) labelEl.textContent = origLabel;
      if (bar) bar.style.width = '0%';
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
    };

    xhr.send();
    }); // end getTurnstileToken().then
  }

  hdBtn?.addEventListener('click', () => startDownload('hd', hdBtn));
  sdBtn?.addEventListener('click', () => startDownload('sd', sdBtn));
  audioBtn?.addEventListener('click', () => startDownload('audio', audioBtn));
}

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  const url = urlInput.value.trim();

  if (!url) {
    showError(isPhotoMode ? 'Please paste a Facebook photo URL.' : 'Please paste a Facebook video URL.');
    return;
  }

  if (!URL_PATTERN.test(url) && !SHORT_PATTERN.test(url)) {
    showError(
      isPhotoMode
        ? 'Please enter a valid Facebook photo link (e.g. facebook.com/photo.php?fbid=…, facebook.com/share/p/… or facebook.com/{profile}/posts/…).'
        : 'Please enter a valid Facebook video link (e.g. facebook.com/username/videos/… or fb.watch/…).'
    );
    return;
  }

  setLoading(true);
  resultMount.innerHTML = '';

  try {
    const token = await getTurnstileToken();
    const apiUrl = isStoryMode ? '/api/facebook-story' : '/api/facebook';
    const body = isStoryMode
      ? { url }
      : { url, mode: MODE, turnstileToken: token || undefined };
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Invalid Facebook link or the API is busy. Please check the link and try again.');
    }

    if (!res.ok || !json.success) {
      const err: any = new Error(json.error || 'Failed to fetch the video. Please try again.');
      err.errorType = json.errorType || null;
      throw err;
    }

    // New endpoint returns { data: { segments, ... } }, legacy returns { video/photo/story }
    const resultData = isStoryMode ? json.data : isPhotoMode ? json.photo : json.video;
    renderResult(resultData, url);
  } catch (err: any) {
    showError(err.message || 'Something went wrong. Please try again.', err.errorType || null);
  } finally {
    setLoading(false);
  }
});
