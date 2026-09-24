export {};

const form = document.getElementById('mp3-tiktok-form') as HTMLFormElement;
const urlInput = document.getElementById('mp3-tiktok-url') as HTMLInputElement;
const downloadBtn = document.getElementById('mp3-download-btn') as HTMLButtonElement;
const btnLabel = document.getElementById('mp3-btn-label') as HTMLElement;
const btnSpinner = document.getElementById('mp3-btn-spinner') as HTMLElement;
const errorMsg = document.getElementById('mp3-error-msg') as HTMLElement;
const errorText = document.getElementById('mp3-error-text') as HTMLElement;
const resultMount = document.getElementById('mp3-result-mount') as HTMLElement;

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
  const fetchNote = document.getElementById('fetch-note');
  if (fetchNote) fetchNote.hidden = !loading;
}

function showError(msg: string) {
  errorText.textContent = msg;
  errorMsg.removeAttribute('hidden');
  resultMount.innerHTML = '';
}

function hideError(): void {
  errorMsg.setAttribute('hidden', '');
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

let submittedUrl = '';
let selectedBitrate = 0;

function bitrateLabel(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${kbps} kbps`;
}

function proxyThumb(url: string | null | undefined): string {
  if (!url) return '';
  return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}

function renderResult(data: any) {
  const { audio, video, bitrate } = data;
  const { sourceKbps, options = [], ffmpegAvailable = false } = bitrate || {};
  const showSelector = ffmpegAvailable && Array.isArray(options) && options.length > 0;
  selectedBitrate = showSelector ? Math.max(...options) : 0;

  const downloadHref = showSelector
    ? `/api/download-mp3?url=${encodeURIComponent(submittedUrl)}&dl=1&br=${selectedBitrate}`
    : `/api/download-mp3?url=${encodeURIComponent(submittedUrl)}&dl=1`;

  const thumbSrc = proxyThumb(audio.cover || video.cover);

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
            width="80"
            height="108"
            onerror="this.style.display='none'"
          />
          <span class="result-duration text-caption-mono">${formatDuration(audio.duration || 0)}</span>
        </div>
        <div class="result-info">
          <p class="result-author text-caption-mono">${audio.author || video.author?.nickname || 'TikTok'}</p>
          <h3 class="result-title">${audio.title || 'TikTok Audio'}</h3>
          <div class="result-stats">
            <span class="result-stat" title="Likes">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              ${formatNumber(video.digg_count || 0)}
            </span>
            <span class="result-stat" title="Comments">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              ${formatNumber(video.comment_count || 0)}
            </span>
            <span class="result-stat" title="Shares">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              ${formatNumber(video.share_count || 0)}
            </span>
          </div>
        </div>
      </div>
      ${showSelector ? `
      <div class="bitrate-selector" role="radiogroup" aria-label="Select MP3 audio quality">
        <span class="bitrate-label text-caption-mono">Audio Quality</span>
        <div class="bitrate-options">
          ${options.map((kbps: number, i: number) => `
            <button
              type="button"
              role="radio"
              class="bitrate-option${i === options.length - 1 ? ' bitrate-option-active' : ''}"
              data-kbps="${kbps}"
              aria-checked="${i === options.length - 1 ? 'true' : 'false'}"
            >
              <span class="bitrate-value">${bitrateLabel(kbps)}</span>
              ${kbps === sourceKbps || i === options.length - 1 ? '<span class="bitrate-max">Best</span>' : ''}
            </button>
          `).join('')}
        </div>
        <p class="bitrate-hint">Quality is limited by the source audio (${bitrateLabel(sourceKbps || options[options.length - 1])}). Higher is not upscaled.</p>
      </div>
      ` : ''}
      ${audio.play_url ? `
      <div class="result-actions">
        <a
          id="btn-download-mp3"
          href="${downloadHref}"
          download="tiksavehub-audio.mp3"
          class="btn-primary result-btn mp3-dl-btn"
          aria-label="Download MP3 audio"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          <span class="result-btn-text">Download MP3${showSelector ? ` (${bitrateLabel(selectedBitrate)})` : ''}</span>
        </a>
        <button
          id="btn-preview-audio"
          class="btn-secondary result-btn audio-preview-btn"
          aria-label="Preview audio"
          data-url="${audio.play_url}"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Preview
        </button>
      </div>
      <div id="audio-preview-wrap" class="audio-preview-wrap" hidden>
        <audio id="audio-preview" controls class="audio-player">
          <source src="${audio.play_url}" type="audio/mpeg" />
        </audio>
      </div>
      <p class="result-notice">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        For personal use only. Please respect copyright and content creators.
      </p>
      ` : `
      <div class="result-actions">
        <p class="no-audio-msg">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          No audio track available for this video. Try a different TikTok video.
        </p>
      </div>
      `}
    </div>
  `;

  const downloadLink = document.getElementById('btn-download-mp3') as HTMLAnchorElement | null;
  const bitrateOptions = document.querySelectorAll<HTMLButtonElement>('.bitrate-option');

  // Never save a server error (JSON/HTML) as "tiksavehub-audio.mp3" — verify the
  // response is real MP3 audio before writing the file to disk.
  const isMp3ContentType = (ct: string) =>
    ct.includes('audio/mpeg') || ct.includes('audio/mp3') || ct.includes('application/octet-stream');

  const looksLikeMp3 = (buf: ArrayBuffer) => {
    const bytes = new Uint8Array(buf);
    if (bytes.length < 2) return false;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // ID3
    if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true; // MPEG sync
    return false;
  };

  downloadLink?.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(downloadLink.href);
      const ct = res.headers.get('content-type') || '';

      if (!res.ok) {
        let msg = 'Failed to download MP3. Please try again.';
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {}
        showError(msg);
        return;
      }

      if (!isMp3ContentType(ct)) {
        showError('MP3 audio is not available for this video. Try another public TikTok link.');
        return;
      }

      const blob = await res.blob();
      const head = await blob.slice(0, 4).arrayBuffer();
      if (!looksLikeMp3(head)) {
        showError('MP3 audio is not available for this video. Try another public TikTok link.');
        return;
      }

      const disposition = res.headers.get('content-disposition') || '';
      const cdMatch = /filename="([^"]+)"/.exec(disposition);
      const filename = cdMatch?.[1] || downloadLink.getAttribute('download') || 'tiksavehub-audio.mp3';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err: any) {
      showError(err?.message || 'Failed to download MP3. Please try again.');
    }
  });

  bitrateOptions.forEach((opt) => {
    opt.addEventListener('click', () => {
      selectedBitrate = Number(opt.dataset.kbps || 0);
      bitrateOptions.forEach((o) => {
        const active = o === opt;
        o.classList.toggle('bitrate-option-active', active);
        o.setAttribute('aria-checked', String(active));
      });
      if (downloadLink) {
        downloadLink.href = `/api/download-mp3?url=${encodeURIComponent(submittedUrl)}&dl=1&br=${selectedBitrate}`;
        const label = downloadLink.querySelector('.result-btn-text');
        const value = bitrateLabel(selectedBitrate);
        if (label) label.textContent = `Download MP3 (${value})`;
      }
    });
  });

  const previewBtn = document.getElementById('btn-preview-audio');
  const previewWrap = document.getElementById('audio-preview-wrap');
  const audioEl = document.getElementById('audio-preview') as HTMLAudioElement;

  previewBtn?.addEventListener('click', () => {
    const isHidden = previewWrap?.hasAttribute('hidden');
    if (isHidden) {
      previewWrap?.removeAttribute('hidden');
      previewBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Hide Player
      `;
      audioEl?.load();
    } else {
      previewWrap?.setAttribute('hidden', '');
      audioEl?.pause();
      previewBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Preview
      `;
    }
  });
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
  submittedUrl = url;

  try {
    const res = await fetch(`/api/download-mp3?url=${encodeURIComponent(url)}`);
    const json = await res.json() as { success?: boolean; error?: string };

    if (!res.ok || !json.success) {
      throw new Error(json.error || 'Failed to fetch audio. Please try again.');
    }

    renderResult(json);
  } catch (err: any) {
    showError(err.message || 'Something went wrong. Please try again.');
  } finally {
    setLoading(false);
  }
});
