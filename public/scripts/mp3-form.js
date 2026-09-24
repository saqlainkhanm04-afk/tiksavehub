"use strict";(()=>{var k=document.getElementById("mp3-tiktok-form"),_=document.getElementById("mp3-tiktok-url"),F=document.getElementById("mp3-download-btn"),q=document.getElementById("mp3-btn-label"),N=document.getElementById("mp3-btn-spinner"),I=document.getElementById("mp3-error-msg"),z=document.getElementById("mp3-error-text"),x=document.getElementById("mp3-result-mount");document.querySelectorAll(".paste-btn").forEach(e=>{e.addEventListener("click",async()=>{let n=document.getElementById(e.dataset.pasteTarget||"");if(!n)return;let o="";try{navigator.clipboard&&window.isSecureContext?o=await navigator.clipboard.readText():window.clipboardData&&window.clipboardData.getData&&(o=window.clipboardData.getData("Text"))}catch{}o&&(n.value=o.trim()),n.focus()})});function H(e){F.disabled=e,q.hidden=e,N.hidden=!e;let n=document.getElementById("fetch-note");n&&(n.hidden=!e)}function l(e){z.textContent=e,I.removeAttribute("hidden"),x.innerHTML=""}function O(){I.setAttribute("hidden","")}function w(e){return e>=1e6?(e/1e6).toFixed(1)+"M":e>=1e3?(e/1e3).toFixed(1)+"K":String(e)}function V(e){let n=Math.floor(e/60),o=e%60;return`${n}:${o.toString().padStart(2,"0")}`}var y="",u=0;function v(e){return e>=1e3?`${(e/1e3).toFixed(1)} Mbps`:`${e} kbps`}function K(e){return e?`/api/proxy-image?url=${encodeURIComponent(e)}`:""}function Q(e){var L;let{audio:n,video:o,bitrate:p}=e,{sourceKbps:T,options:i=[],ffmpegAvailable:C=!1}=p||{},g=C&&Array.isArray(i)&&i.length>0;u=g?Math.max(...i):0;let P=g?`/api/download-mp3?url=${encodeURIComponent(y)}&dl=1&br=${u}`:`/api/download-mp3?url=${encodeURIComponent(y)}&dl=1`,A=K(n.cover||o.cover);x.innerHTML=`
    <div class="result-card animate-fade-in-up" role="region" aria-label="Download result">
      <div class="result-header">
        <div class="result-thumb-wrap">
          <img
            src="${A}"
            alt="Video thumbnail"
            class="result-thumb"
            referrerpolicy="no-referrer"
            loading="lazy"
            width="80"
            height="108"
            onerror="this.style.display='none'"
          />
          <span class="result-duration text-caption-mono">${V(n.duration||0)}</span>
        </div>
        <div class="result-info">
          <p class="result-author text-caption-mono">${n.author||((L=o.author)==null?void 0:L.nickname)||"TikTok"}</p>
          <h3 class="result-title">${n.title||"TikTok Audio"}</h3>
          <div class="result-stats">
            <span class="result-stat" title="Likes">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              ${w(o.digg_count||0)}
            </span>
            <span class="result-stat" title="Comments">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              ${w(o.comment_count||0)}
            </span>
            <span class="result-stat" title="Shares">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              ${w(o.share_count||0)}
            </span>
          </div>
        </div>
      </div>
      ${g?`
      <div class="bitrate-selector" role="radiogroup" aria-label="Select MP3 audio quality">
        <span class="bitrate-label text-caption-mono">Audio Quality</span>
        <div class="bitrate-options">
          ${i.map((r,t)=>`
            <button
              type="button"
              role="radio"
              class="bitrate-option${t===i.length-1?" bitrate-option-active":""}"
              data-kbps="${r}"
              aria-checked="${t===i.length-1?"true":"false"}"
            >
              <span class="bitrate-value">${v(r)}</span>
              ${r===T||t===i.length-1?'<span class="bitrate-max">Best</span>':""}
            </button>
          `).join("")}
        </div>
        <p class="bitrate-hint">Quality is limited by the source audio (${v(T||i[i.length-1])}). Higher is not upscaled.</p>
      </div>
      `:""}
      ${n.play_url?`
      <div class="result-actions">
        <a
          id="btn-download-mp3"
          href="${P}"
          download="tiksavehub-audio.mp3"
          class="btn-primary result-btn mp3-dl-btn"
          aria-label="Download MP3 audio"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          <span class="result-btn-text">Download MP3${g?` (${v(u)})`:""}</span>
        </a>
        <button
          id="btn-preview-audio"
          class="btn-secondary result-btn audio-preview-btn"
          aria-label="Preview audio"
          data-url="${n.play_url}"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Preview
        </button>
      </div>
      <div id="audio-preview-wrap" class="audio-preview-wrap" hidden>
        <audio id="audio-preview" controls class="audio-player">
          <source src="${n.play_url}" type="audio/mpeg" />
        </audio>
      </div>
      <p class="result-notice">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        For personal use only. Please respect copyright and content creators.
      </p>
      `:`
      <div class="result-actions">
        <p class="no-audio-msg">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          No audio track available for this video. Try a different TikTok video.
        </p>
      </div>
      `}
    </div>
  `;let s=document.getElementById("btn-download-mp3"),E=document.querySelectorAll(".bitrate-option"),j=r=>r.includes("audio/mpeg")||r.includes("audio/mp3")||r.includes("application/octet-stream"),S=r=>{let t=new Uint8Array(r);return t.length<2?!1:t[0]===73&&t[1]===68&&t[2]===51||t[0]===255&&(t[1]&224)===224};s==null||s.addEventListener("click",async r=>{r.preventDefault();try{let t=await fetch(s.href),c=t.headers.get("content-type")||"";if(!t.ok){let B="Failed to download MP3. Please try again.";try{let b=await t.json();b!=null&&b.error&&(B=b.error)}catch{}l(B);return}if(!j(c)){l("MP3 audio is not available for this video. Try another public TikTok link.");return}let M=await t.blob(),U=await M.slice(0,4).arrayBuffer();if(!S(U)){l("MP3 audio is not available for this video. Try another public TikTok link.");return}let D=t.headers.get("content-disposition")||"",f=/filename="([^"]+)"/.exec(D),R=(f==null?void 0:f[1])||s.getAttribute("download")||"tiksavehub-audio.mp3",$=URL.createObjectURL(M),h=document.createElement("a");h.href=$,h.download=R,document.body.appendChild(h),h.click(),h.remove(),setTimeout(()=>URL.revokeObjectURL($),5e3)}catch(t){l((t==null?void 0:t.message)||"Failed to download MP3. Please try again.")}}),E.forEach(r=>{r.addEventListener("click",()=>{if(u=Number(r.dataset.kbps||0),E.forEach(t=>{let c=t===r;t.classList.toggle("bitrate-option-active",c),t.setAttribute("aria-checked",String(c))}),s){s.href=`/api/download-mp3?url=${encodeURIComponent(y)}&dl=1&br=${u}`;let t=s.querySelector(".result-btn-text"),c=v(u);t&&(t.textContent=`Download MP3 (${c})`)}})});let m=document.getElementById("btn-preview-audio"),a=document.getElementById("audio-preview-wrap"),d=document.getElementById("audio-preview");m==null||m.addEventListener("click",()=>{(a==null?void 0:a.hasAttribute("hidden"))?(a==null||a.removeAttribute("hidden"),m.innerHTML=`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Hide Player
      `,d==null||d.load()):(a==null||a.setAttribute("hidden",""),d==null||d.pause(),m.innerHTML=`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Preview
      `)})}k==null||k.addEventListener("submit",async e=>{e.preventDefault(),O();let n=_.value.trim();if(!n){l("Please paste a TikTok video URL.");return}if(!n.includes("tiktok.com")&&!n.includes("vm.tiktok.com")&&!n.includes("vt.tiktok.com")){l("Please enter a valid TikTok video URL (e.g. https://www.tiktok.com/@user/video/\u2026)");return}H(!0),x.innerHTML="",y=n;try{let o=await fetch(`/api/download-mp3?url=${encodeURIComponent(n)}`),p=await o.json();if(!o.ok||!p.success)throw new Error(p.error||"Failed to fetch audio. Please try again.");Q(p)}catch(o){l(o.message||"Something went wrong. Please try again.")}finally{H(!1)}});})();
