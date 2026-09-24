import { attachSimProgress } from '../lib/download-progress';

export {};

const form = document.getElementById('instagram-form') as HTMLFormElement;
const urlInput = document.getElementById('instagram-url') as HTMLInputElement;
const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;
const btnLabel = document.getElementById('btn-label') as HTMLElement;
const btnSpinner = document.getElementById('btn-spinner') as HTMLElement;
const errorMsg = document.getElementById('error-msg') as HTMLElement;
const errorText = document.getElementById('error-text') as HTMLElement;
const resultMount = document.getElementById('result-mount') as HTMLElement;

const section = document.getElementById('download-form') as HTMLElement;
const currentTabType = (section?.dataset.type || 'video') as 'video' | 'reels' | 'story' | 'audio';
const typeLabel = currentTabType.charAt(0).toUpperCase() + currentTabType.slice(1);

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
const tabPatterns: Record<string, RegExp> = {
  video: /^(https?:\/\/)?(www\.)?instagram\.com\/(p|tv|reel)\//i,
  reels: /^(https?:\/\/)?(www\.)?instagram\.com\/(p|tv|reel)\//i,
  story: /^(https?:\/\/)?(www\.)?instagram\.com\/stories\//i,
  audio: /^(https?:\/\/)?(www\.)?instagram\.com\/(p|tv|reel)\//i,
};

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

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function renderResult(data: any, inputUrl: string) {
  const {
    cover,      // thumbnail
    duration,
  } = data;

  const dlIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

  let actions = '';
  if (currentTabType === 'audio') {
    actions = `
      <button class="dl-tile dl-tile-hd" id="btn-dl-audio" type="button" aria-label="Download Instagram audio as MP3">
        <span class="dl-tile-icon" aria-hidden="true">${dlIcon}</span>
        <span class="dl-tile-label">Download <strong>MP3 Audio</strong></span>
        <span class="dl-proc-bar"></span>
      </button>`;
  } else if (currentTabType === 'story') {
    actions = `
      <button class="dl-tile dl-tile-sd" id="btn-dl-story" type="button" aria-label="Download Instagram story">
        <span class="dl-tile-icon" aria-hidden="true">${dlIcon}</span>
        <span class="dl-tile-label">Download <strong>Story</strong></span>
        <span class="dl-proc-bar"></span>
      </button>`;
  } else {
    actions = `
      <button class="dl-tile dl-tile-sd" id="btn-dl-sd" type="button" aria-label="Download Instagram video without watermark">
        <span class="dl-tile-icon" aria-hidden="true">${dlIcon}</span>
        <span class="dl-tile-label">Without Watermark</span>
        <span class="dl-proc-bar"></span>
      </button>
      <button class="dl-tile dl-tile-hd" id="btn-dl-hd" type="button" aria-label="Download Instagram video in HD without watermark">
        <span class="dl-tile-icon" aria-hidden="true">${dlIcon}</span>
        <span class="dl-tile-label">Without Watermark <strong>HD</strong></span>
        <span class="dl-proc-bar"></span>
      </button>`;
  }

  resultMount.innerHTML = `
    <div class="result-card animate-fade-in-up" role="region" aria-label="Download result">
      <div class="result-header">
        <div class="result-thumb-wrap">
          <img
            src="${cover}"
            alt="Video thumbnail"
            class="result-thumb"
            loading="lazy"
            width="120"
            height="160" />
          <span class="result-duration-badge text-caption-mono">${formatDuration(duration || 0)}</span>
        </div>
        <div class="result-info">
          <div class="result-actions">
        ${actions}
      </div>
        </div>
      </div>
    </div>
  `;

  const sdBtn = document.getElementById('btn-dl-sd') as HTMLButtonElement;
  const hdBtn = document.getElementById('btn-dl-hd') as HTMLButtonElement;
  const audioBtn = document.getElementById('btn-dl-audio') as HTMLButtonElement;
  const storyBtn = document.getElementById('btn-dl-story') as HTMLButtonElement;
  const origUrl = inputUrl;

  function startDownload(type: string, btn: HTMLButtonElement) {
    btn.classList.add('dl-tile-processing');
    btn.disabled = true;
    const labelEl = btn.querySelector('.dl-tile-label') as HTMLElement;
    const origLabel = labelEl?.textContent || '';
    if (labelEl) labelEl.textContent = 'Processing… 0%';
    const bar = btn.querySelector('.dl-proc-bar') as HTMLElement;
    if (bar) { bar.style.transition = 'none'; bar.style.width = '0%'; }

    // Simulated progress — smooth 0→85% while server prepares the stream
    const sim = attachSimProgress(bar, labelEl, 'Processing…', { ceiling: 85, intervalMs: 250 });

    const xhr = new XMLHttpRequest();
    getTurnstileToken().then((token) => {
    const tokenParam = token ? '&turnstileToken=' + encodeURIComponent(token) : '';
    xhr.open('GET', `/api/instagram-download?url=${encodeURIComponent(origUrl)}&type=${currentTabType}&dl=${type}${tokenParam}`);
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
        const isAudio = currentTabType === 'audio';
        a.download = isAudio ? 'tiksavehub-audio.mp3' : 'tiksavehub-reel.mp4';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
        btn.classList.add('dl-tile-done');
        setTimeout(() => btn.classList.remove('dl-tile-done'), 1500);
      } else {
        let errMsg = 'Download failed. Please try again.';
        try {
          const errJson = JSON.parse(xhr.responseText);
          if (errJson.error) errMsg = errJson.error;
        } catch {}
        showError(errMsg);
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

  sdBtn?.addEventListener('click', () => startDownload('sd', sdBtn));
  hdBtn?.addEventListener('click', () => startDownload('hd', hdBtn));
  audioBtn?.addEventListener('click', () => startDownload('audio', audioBtn));
  storyBtn?.addEventListener('click', () => startDownload('story', storyBtn));
}

function renderStories(stories: any[]) {
  const dlIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const dlAllIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const checkIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  const count = stories.length;
  const header = `
    <div class="stories-header">
      <div class="stories-header-left">
        <span class="stories-count">${count} ${count === 1 ? 'Story' : 'Stories'} Found</span>
        <span class="stories-hint">Active stories from this account</span>
      </div>
      ${count > 1 ? `
        <button class="stories-dl-all-btn" id="btn-dl-all" type="button" aria-label="Download all Instagram stories">
          ${dlAllIcon}
          <span class="stories-dl-all-label">Download All</span>
        </button>
      ` : ''}
    </div>`;

  const tiles = stories.map((s: any, i: number) => {
    const badge = s.isPhoto
      ? '<span class="story-type-badge">Photo</span>'
      : s.duration
        ? `<span class="story-duration-badge">${Math.floor(s.duration / 60)}:${(s.duration % 60).toString().padStart(2, '0')}</span>`
        : '';
    return `
      <div class="story-tile" id="story-tile-${i}">
        <div class="story-thumb-wrap">
          <img src="${s.cover || ''}" alt="Story ${i + 1}" class="story-thumb" loading="lazy" width="110" height="195" />
          ${badge}
        </div>
        <button class="story-dl-btn" type="button" aria-label="Download story ${i + 1}" data-index="${i}" data-story-url="${encodeURIComponent('/stories/' + (s.author?.unique_id || 'user') + '/' + s.mediaId + '/')}" data-stream-url="${(s.downloadUrl || '').replace(/&/g, '&amp;')}" data-is-photo="${s.isPhoto ? '1' : '0'}">
          ${dlIcon}
        </button>
        <div class="story-dl-overlay" id="story-overlay-${i}" hidden>
          <div class="story-dl-spinner"></div>
        </div>
      </div>`;
  }).join('');

  resultMount.innerHTML = `
    <div class="result-card stories-card animate-fade-in-up" role="region" aria-label="Download stories">
      ${header}
      <div class="stories-status-msg" id="stories-status-msg" role="status" aria-live="polite">
        <p class="stories-status-text" id="stories-status-text">${count} active ${count === 1 ? 'story' : 'stories'} ready to download. Click <strong>Download All</strong> or tap any story to save it.</p>
      </div>
      <div class="stories-grid">${tiles}</div>
      <div class="stories-dl-all-status" id="dl-all-status" hidden>
        <div class="stories-dl-all-bar"><div class="stories-dl-all-bar-fill" id="dl-all-bar-fill"></div></div>
        <span class="stories-dl-all-text" id="dl-all-text"></span>
      </div>
    </div>
  `;

  async function fetchAndDownload(storyUrl: string, fileName: string, streamUrl?: string): Promise<boolean> {
    let apiUrl: string;
    if (streamUrl) {
      apiUrl = `/api/instagram-download?url=${encodeURIComponent(storyUrl)}&type=story&dl=story&stream=${encodeURIComponent(streamUrl)}`;
    } else {
      apiUrl = `/api/instagram-download?url=${encodeURIComponent(storyUrl)}&type=story&dl=story`;
    }
    const resp = await fetch(apiUrl);
    if (!resp.ok) {
      const errJson = await resp.json().catch(() => null) as { error?: string } | null;
      throw new Error(errJson?.error || `Server returned ${resp.status}`);
    }
    const blob = await resp.blob();
    if (blob.size < 1000) {
      const text = await blob.text().catch(() => '');
      if (text.includes('"error"')) {
        const parsed = JSON.parse(text);
        throw new Error(parsed.error || 'Download failed');
      }
    }
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    return true;
  }

  function setTileState(idx: number, state: 'loading' | 'done' | 'error') {
    const overlay = document.getElementById(`story-overlay-${idx}`);
    const btn = resultMount.querySelector(`.story-dl-btn[data-index="${idx}"]`) as HTMLButtonElement | null;
    if (state === 'loading') {
      if (overlay) { overlay.hidden = false; overlay.innerHTML = '<div class="story-dl-spinner"></div>'; }
      if (btn) { btn.disabled = true; btn.classList.add('dl-tile-processing'); }
    } else if (state === 'done') {
      if (overlay) overlay.innerHTML = checkIcon;
      if (btn) { btn.classList.remove('dl-tile-processing'); btn.classList.add('dl-tile-done'); }
      setTimeout(() => {
        if (overlay) overlay.hidden = true;
        if (btn) btn.classList.remove('dl-tile-done');
      }, 2000);
    } else {
      if (overlay) overlay.hidden = true;
      if (btn) { btn.classList.remove('dl-tile-processing'); btn.classList.add('dl-tile-error'); }
      setTimeout(() => { if (btn) btn.classList.remove('dl-tile-error'); }, 2000);
    }
  }

  function updateBar(done: number, total: number, text: string) {
    const barFill = document.getElementById('dl-all-bar-fill');
    const statusText = document.getElementById('dl-all-text');
    if (barFill) barFill.style.width = Math.round((done / total) * 100) + '%';
    if (statusText) statusText.textContent = text;
  }

  resultMount.querySelectorAll('.story-dl-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const el = btn as HTMLButtonElement;
      const idx = Number(el.getAttribute('data-index') || '0');
      const storyUrl = decodeURIComponent(el.getAttribute('data-story-url') || '');
      const streamUrl = el.getAttribute('data-stream-url') || undefined;
      const isPhoto = el.getAttribute('data-is-photo') === '1';
      const fileName = isPhoto ? `tiksavehub-story-${idx + 1}.jpg` : `tiksavehub-story-${idx + 1}.mp4`;
      setTileState(idx, 'loading');
      try {
        await fetchAndDownload(storyUrl, fileName, streamUrl);
        setTileState(idx, 'done');
      } catch {
        setTileState(idx, 'error');
      }
    });
  });

  const dlAllBtn = document.getElementById('btn-dl-all') as HTMLButtonElement | null;
  if (dlAllBtn && count > 1) {
    dlAllBtn.addEventListener('click', async () => {
      dlAllBtn.disabled = true;
      dlAllBtn.classList.add('dl-tile-processing');
      const label = dlAllBtn.querySelector('.stories-dl-all-label') as HTMLElement;
      const statusEl = document.getElementById('dl-all-status');
      const statusMsg = document.getElementById('stories-status-text');
      if (statusEl) statusEl.hidden = false;

      const allBtns = Array.from(resultMount.querySelectorAll('.story-dl-btn')) as HTMLButtonElement[];
      const total = allBtns.length;
      let done = 0;
      let failed = 0;

      if (statusMsg) statusMsg.innerHTML = `<strong>Preparing ${total} stories for download…</strong> Your videos are being fetched and saved in sequence.`;
      updateBar(0, total, `Preparing ${total} downloads…`);

      for (const btn of allBtns) {
        const idx = Number(btn.getAttribute('data-index') || '0');
        const storyUrl = decodeURIComponent(btn.getAttribute('data-story-url') || '');
        const streamUrl = btn.getAttribute('data-stream-url') || undefined;
        const isPhoto = btn.getAttribute('data-is-photo') === '1';
        const fileName = isPhoto ? `tiksavehub-story-${idx + 1}.jpg` : `tiksavehub-story-${idx + 1}.mp4`;

        setTileState(idx, 'loading');
        const current = done + failed + 1;
        if (statusMsg) statusMsg.innerHTML = `<strong>Downloading story ${current} of ${total}…</strong> ${isPhoto ? 'Photo' : 'Video'} ${current} is being processed and saved to your device.`;
        updateBar(done + failed, total, `Downloading ${current} of ${total}…`);

        try {
          await fetchAndDownload(storyUrl, fileName, streamUrl);
          done++;
          setTileState(idx, 'done');
        } catch {
          failed++;
          setTileState(idx, 'error');
        }

        updateBar(done + failed, total, failed > 0
          ? `${done} of ${total} downloaded (${failed} failed)`
          : `Downloaded ${done} of ${total}…`);
      }

      if (label) label.textContent = failed > 0 ? `${done} Done` : 'All Done!';
      if (statusMsg) statusMsg.innerHTML = failed > 0
        ? `<strong>Download complete.</strong> ${done} of ${total} stories saved successfully${failed > 0 ? `, ${failed} failed` : ''}.`
        : `<strong>All ${total} stories downloaded!</strong> Your Instagram stories have been saved to your device without watermark.`;
      updateBar(total, total, failed > 0
        ? `Finished — ${done} downloaded, ${failed} failed`
        : `All ${total} stories downloaded!`);

      setTimeout(() => {
        dlAllBtn.disabled = false;
        dlAllBtn.classList.remove('dl-tile-processing');
        if (label) label.textContent = 'Download All';
        if (statusEl) statusEl.hidden = true;
        const barFill = document.getElementById('dl-all-bar-fill');
        if (barFill) barFill.style.width = '0%';
        if (statusMsg) statusMsg.innerHTML = `${count} active ${count === 1 ? 'story' : 'stories'} ready to download. Click <strong>Download All</strong> or tap any story to save it.`;
      }, 3000);
    });
  }
}

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  const url = urlInput.value.trim();

  if (!url) {
    showError(`Please paste an Instagram ${typeLabel} URL.`);
    return;
  }

  const pattern = tabPatterns[currentTabType];
  if (!pattern.test(url)) {
    const example =
      currentTabType === 'video'
        ? 'https://www.instagram.com/p/…'
        : `https://www.instagram.com/${currentTabType === 'audio' ? 'reel' : currentTabType}/…`;
    showError(`Please enter a valid Instagram ${typeLabel} URL (e.g. ${example})`);
    return;
  }

  setLoading(true);
  resultMount.innerHTML = '';

  if (currentTabType === 'story') {
    resultMount.innerHTML = `
      <div class="result-card stories-loading-card animate-fade-in-up" role="status" aria-live="polite">
        <div class="stories-loading-icon">
          <div class="stories-loading-ring"></div>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div class="stories-loading-text">
          <span class="stories-loading-title">Fetching stories…</span>
          <span class="stories-loading-sub" id="loading-sub">Connecting to Instagram</span>
        </div>
        <div class="stories-loading-dots"><span></span><span></span><span></span></div>
      </div>
    `;
    const sub = document.getElementById('loading-sub');
    const phases = ['Connecting to Instagram', 'Resolving account', 'Loading story tray', 'Preparing downloads'];
    let pi = 0;
    const phaseTimer = setInterval(() => {
      pi = Math.min(pi + 1, phases.length - 1);
      if (sub) sub.textContent = phases[pi];
    }, 2000);
    (window as any).__igPhaseTimer = phaseTimer;
  }

  try {
    const token = await getTurnstileToken();
    const tokenParam = token ? '&turnstileToken=' + encodeURIComponent(token) : '';
    const res = await fetch(`/api/instagram-download?url=${encodeURIComponent(url)}&type=${currentTabType}${tokenParam}`);
    if ((window as any).__igPhaseTimer) { clearInterval((window as any).__igPhaseTimer); delete (window as any).__igPhaseTimer; }
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Invalid Instagram link or API is busy. Please check the link and try again.');
    }

    if (!res.ok || !json.success) {
      throw new Error(json.error || 'Failed to fetch content. Please try again.');
    }

    if (json.stories && json.stories.length > 0) {
      renderStories(json.stories);
    } else {
      renderResult(json.video, url);
    }
  } catch (err: any) {
    if ((window as any).__igPhaseTimer) { clearInterval((window as any).__igPhaseTimer); delete (window as any).__igPhaseTimer; }
    showError(err.message || 'Something went wrong. Please try again.');
  } finally {
    setLoading(false);
  }
});
