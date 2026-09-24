function H(n,o,u="Processing\u2026",m){let c=m?.ceiling??85,h=m?.intervalMs??250,f=0,p=!1,v={current:0,stop(g){p||(p=!0,clearInterval(b),g!=null&&n&&(n.style.transition="width 0.3s ease",n.style.width=g+"%"),o&&g!=null&&(o.textContent=u+" "+Math.round(g)+"%"))}},b=setInterval(()=>{if(p){clearInterval(b);return}let g=c-f,s=Math.max(.5,g*.08);f=Math.min(f+s,c),v.current=f,n&&(n.style.transition="none",n.style.width=f+"%"),o&&(o.textContent=u+" "+Math.round(f)+"%")},h);return v}var j=document.getElementById("instagram-form"),q=document.getElementById("instagram-url"),N=document.getElementById("download-btn"),F=document.getElementById("btn-label"),O=document.getElementById("btn-spinner"),S=document.getElementById("error-msg"),z=document.getElementById("error-text"),E=document.getElementById("result-mount"),J=document.getElementById("download-form"),w=J?.dataset.type||"video",A=w.charAt(0).toUpperCase()+w.slice(1),D="0x4AAAAAAEl-ZmiorHhgs7jw",T=null,k=!1,C=null;function U(){if(C!==null&&typeof window.turnstile<"u"){try{window.turnstile.remove(C)}catch{}C=null}}function R(){if(typeof window.turnstile>"u"){setTimeout(R,500);return}let n=document.getElementById("cf-turnstile-container");n&&(U(),C=window.turnstile.render(n,{sitekey:D,appearance:"interaction-only",callback:o=>{T=o,k=!0},"error-callback":()=>{T=null,k=!1},"expired-callback":()=>{T=null,k=!1}}))}R();function _(){return new Promise(n=>{if(T&&k){n(T);return}let o=document.getElementById("cf-turnstile-container");if(!o||typeof window.turnstile>"u"){n(null);return}U(),o.innerHTML="",C=window.turnstile.render(o,{sitekey:D,appearance:"interaction-only",callback:u=>{T=u,k=!0,n(u)},"error-callback":()=>{T=null,k=!1,n(null)},"expired-callback":()=>{T=null,k=!1,n(null)}}),setTimeout(()=>n(T),8e3)})}document.querySelectorAll(".paste-btn").forEach(n=>{n.addEventListener("click",async()=>{let o=document.getElementById(n.dataset.pasteTarget||"");if(!o)return;let u="";try{navigator.clipboard&&window.isSecureContext?u=await navigator.clipboard.readText():window.clipboardData&&window.clipboardData.getData&&(u=window.clipboardData.getData("Text"))}catch{}u&&(o.value=u.trim()),o.focus()})});var W={video:/^(https?:\/\/)?(www\.)?instagram\.com\/(p|tv|reel)\//i,reels:/^(https?:\/\/)?(www\.)?instagram\.com\/(p|tv|reel)\//i,story:/^(https?:\/\/)?(www\.)?instagram\.com\/stories\//i,audio:/^(https?:\/\/)?(www\.)?instagram\.com\/(p|tv|reel)\//i};function P(n){N.disabled=n,F.hidden=n,O.hidden=!n;let o=document.getElementById("fetch-note");o&&(o.hidden=!n)}function B(n){z.textContent=n,S.removeAttribute("hidden"),E.innerHTML=""}function Y(){S.setAttribute("hidden","")}function G(n){let o=Math.floor(n/60),u=n%60;return`${o}:${u.toString().padStart(2,"0")}`}function V(n,o){let{cover:u,duration:m}=n,c='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',h="";w==="audio"?h=`
      <button class="dl-tile dl-tile-hd" id="btn-dl-audio" type="button" aria-label="Download Instagram audio as MP3">
        <span class="dl-tile-icon" aria-hidden="true">${c}</span>
        <span class="dl-tile-label">Download <strong>MP3 Audio</strong></span>
        <span class="dl-proc-bar"></span>
      </button>`:w==="story"?h=`
      <button class="dl-tile dl-tile-sd" id="btn-dl-story" type="button" aria-label="Download Instagram story">
        <span class="dl-tile-icon" aria-hidden="true">${c}</span>
        <span class="dl-tile-label">Download <strong>Story</strong></span>
        <span class="dl-proc-bar"></span>
      </button>`:h=`
      <button class="dl-tile dl-tile-sd" id="btn-dl-sd" type="button" aria-label="Download Instagram video without watermark">
        <span class="dl-tile-icon" aria-hidden="true">${c}</span>
        <span class="dl-tile-label">Without Watermark</span>
        <span class="dl-proc-bar"></span>
      </button>
      <button class="dl-tile dl-tile-hd" id="btn-dl-hd" type="button" aria-label="Download Instagram video in HD without watermark">
        <span class="dl-tile-icon" aria-hidden="true">${c}</span>
        <span class="dl-tile-label">Without Watermark <strong>HD</strong></span>
        <span class="dl-proc-bar"></span>
      </button>`,E.innerHTML=`
    <div class="result-card animate-fade-in-up" role="region" aria-label="Download result">
      <div class="result-header">
        <div class="result-thumb-wrap">
          <img
            src="${u}"
            alt="Video thumbnail"
            class="result-thumb"
            loading="lazy"
            referrerpolicy="no-referrer"
            width="120"
            height="160"
            data-proxy="0"
            onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.closest('.result-thumb-wrap').classList.add('thumb-failed')}" />
          <span class="result-duration-badge text-caption-mono">${G(m||0)}</span>
        </div>
        <div class="result-info">
          <div class="result-actions">
        ${h}
      </div>
        </div>
      </div>
    </div>
  `;let f=document.getElementById("btn-dl-sd"),p=document.getElementById("btn-dl-hd"),v=document.getElementById("btn-dl-audio"),b=document.getElementById("btn-dl-story"),g=o;function s(l,t){t.classList.add("dl-tile-processing"),t.disabled=!0;let e=t.querySelector(".dl-tile-label"),a=e?.textContent||"";e&&(e.textContent="Processing\u2026 0%");let i=t.querySelector(".dl-proc-bar");i&&(i.style.transition="none",i.style.width="0%");let d=H(i,e,"Processing\u2026",{ceiling:85,intervalMs:250}),r=new XMLHttpRequest;_().then(y=>{let I=y?"&turnstileToken="+encodeURIComponent(y):"";r.open("GET",`/api/instagram-download?url=${encodeURIComponent(g)}&type=${w}&dl=${l}${I}`),r.responseType="blob",r.timeout=12e4,r.onprogress=function(x){if(x.lengthComputable&&i&&e){let L=Math.round(x.loaded/x.total*100);d.stop(L)}},r.onload=function(){if(d.stop(r.status===200?100:void 0),r.status===200){let x=r.response,L=URL.createObjectURL(x),$=document.createElement("a");$.href=L;let M=w==="audio";$.download=M?"tiksavehub-audio.mp3":"tiksavehub-reel.mp4",document.body.appendChild($),$.click(),document.body.removeChild($),setTimeout(()=>URL.revokeObjectURL(L),6e4),t.classList.add("dl-tile-done"),setTimeout(()=>t.classList.remove("dl-tile-done"),1500)}else{let x="Download failed. Please try again.";try{let L=JSON.parse(r.responseText);L.error&&(x=L.error)}catch{}B(x),t.classList.add("dl-tile-error"),setTimeout(()=>t.classList.remove("dl-tile-error"),2e3)}t.classList.remove("dl-tile-processing"),t.disabled=!1,e&&(e.textContent=a),i&&(i.style.width="0%")},r.onerror=function(){d.stop(),t.classList.add("dl-tile-error"),setTimeout(()=>t.classList.remove("dl-tile-error"),2e3),t.classList.remove("dl-tile-processing"),t.disabled=!1,e&&(e.textContent=a),i&&(i.style.width="0%")},r.ontimeout=function(){d.stop(),t.classList.add("dl-tile-error"),e&&(e.textContent="Timed out \u2014 try again"),setTimeout(()=>{t.classList.remove("dl-tile-error"),e&&(e.textContent=a)},2e3),t.classList.remove("dl-tile-processing"),t.disabled=!1,i&&(i.style.width="0%")},r.send()})}f?.addEventListener("click",()=>s("sd",f)),p?.addEventListener("click",()=>s("hd",p)),v?.addEventListener("click",()=>s("audio",v)),b?.addEventListener("click",()=>s("story",b))}function K(n){let o='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',u='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',m='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',c=n.length,h=`
    <div class="stories-header">
      <div class="stories-header-left">
        <span class="stories-count">${c} ${c===1?"Story":"Stories"} Found</span>
        <span class="stories-hint">Active stories from this account</span>
      </div>
      ${c>1?`
        <button class="stories-dl-all-btn" id="btn-dl-all" type="button" aria-label="Download all Instagram stories">
          ${u}
          <span class="stories-dl-all-label">Download All</span>
        </button>
      `:""}
    </div>`,f=n.map((s,l)=>{let t=s.isPhoto?'<span class="story-type-badge">Photo</span>':s.duration?`<span class="story-duration-badge">${Math.floor(s.duration/60)}:${(s.duration%60).toString().padStart(2,"0")}</span>`:"";return`
      <div class="story-tile" id="story-tile-${l}">
        <div class="story-thumb-wrap">
          <img src="${s.cover||""}" alt="Story ${l+1}" class="story-thumb" loading="lazy" width="110" height="195" referrerpolicy="no-referrer" data-proxy="0" onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.style.display='none'}" />
          ${t}
        </div>
        <button class="story-dl-btn" type="button" aria-label="Download story ${l+1}" data-index="${l}" data-story-url="${encodeURIComponent("/stories/"+(s.author?.unique_id||"user")+"/"+s.mediaId+"/")}" data-stream-url="${(s.downloadUrl||"").replace(/&/g,"&amp;")}" data-is-photo="${s.isPhoto?"1":"0"}">
          ${o}
        </button>
        <div class="story-dl-overlay" id="story-overlay-${l}" hidden>
          <div class="story-dl-spinner"></div>
        </div>
      </div>`}).join("");E.innerHTML=`
    <div class="result-card stories-card animate-fade-in-up" role="region" aria-label="Download stories">
      ${h}
      <div class="stories-status-msg" id="stories-status-msg" role="status" aria-live="polite">
        <p class="stories-status-text" id="stories-status-text">${c} active ${c===1?"story":"stories"} ready to download. Click <strong>Download All</strong> or tap any story to save it.</p>
      </div>
      <div class="stories-grid">${f}</div>
      <div class="stories-dl-all-status" id="dl-all-status" hidden>
        <div class="stories-dl-all-bar"><div class="stories-dl-all-bar-fill" id="dl-all-bar-fill"></div></div>
        <span class="stories-dl-all-text" id="dl-all-text"></span>
      </div>
    </div>
  `;async function p(s,l,t){let e;t?e=`/api/instagram-download?url=${encodeURIComponent(s)}&type=story&dl=story&stream=${encodeURIComponent(t)}`:e=`/api/instagram-download?url=${encodeURIComponent(s)}&type=story&dl=story`;let a=await fetch(e);if(!a.ok){let y=await a.json().catch(()=>null);throw new Error(y?.error||`Server returned ${a.status}`)}let i=await a.blob();if(i.size<1e3){let y=await i.text().catch(()=>"");if(y.includes('"error"')){let I=JSON.parse(y);throw new Error(I.error||"Download failed")}}let d=URL.createObjectURL(i),r=document.createElement("a");return r.href=d,r.download=l,document.body.appendChild(r),r.click(),document.body.removeChild(r),setTimeout(()=>URL.revokeObjectURL(d),6e4),!0}function v(s,l){let t=document.getElementById(`story-overlay-${s}`),e=E.querySelector(`.story-dl-btn[data-index="${s}"]`);l==="loading"?(t&&(t.hidden=!1,t.innerHTML='<div class="story-dl-spinner"></div>'),e&&(e.disabled=!0,e.classList.add("dl-tile-processing"))):l==="done"?(t&&(t.innerHTML=m),e&&(e.classList.remove("dl-tile-processing"),e.classList.add("dl-tile-done")),setTimeout(()=>{t&&(t.hidden=!0),e&&e.classList.remove("dl-tile-done")},2e3)):(t&&(t.hidden=!0),e&&(e.classList.remove("dl-tile-processing"),e.classList.add("dl-tile-error")),setTimeout(()=>{e&&e.classList.remove("dl-tile-error")},2e3))}function b(s,l,t){let e=document.getElementById("dl-all-bar-fill"),a=document.getElementById("dl-all-text");e&&(e.style.width=Math.round(s/l*100)+"%"),a&&(a.textContent=t)}E.querySelectorAll(".story-dl-btn").forEach(s=>{s.addEventListener("click",async()=>{let l=s,t=Number(l.getAttribute("data-index")||"0"),e=decodeURIComponent(l.getAttribute("data-story-url")||""),a=l.getAttribute("data-stream-url")||void 0,d=l.getAttribute("data-is-photo")==="1"?`tiksavehub-story-${t+1}.jpg`:`tiksavehub-story-${t+1}.mp4`;v(t,"loading");try{await p(e,d,a),v(t,"done")}catch{v(t,"error")}})});let g=document.getElementById("btn-dl-all");g&&c>1&&g.addEventListener("click",async()=>{g.disabled=!0,g.classList.add("dl-tile-processing");let s=g.querySelector(".stories-dl-all-label"),l=document.getElementById("dl-all-status"),t=document.getElementById("stories-status-text");l&&(l.hidden=!1);let e=Array.from(E.querySelectorAll(".story-dl-btn")),a=e.length,i=0,d=0;t&&(t.innerHTML=`<strong>Preparing ${a} stories for download\u2026</strong> Your videos are being fetched and saved in sequence.`),b(0,a,`Preparing ${a} downloads\u2026`);for(let r of e){let y=Number(r.getAttribute("data-index")||"0"),I=decodeURIComponent(r.getAttribute("data-story-url")||""),x=r.getAttribute("data-stream-url")||void 0,L=r.getAttribute("data-is-photo")==="1",$=L?`tiksavehub-story-${y+1}.jpg`:`tiksavehub-story-${y+1}.mp4`;v(y,"loading");let M=i+d+1;t&&(t.innerHTML=`<strong>Downloading story ${M} of ${a}\u2026</strong> ${L?"Photo":"Video"} ${M} is being processed and saved to your device.`),b(i+d,a,`Downloading ${M} of ${a}\u2026`);try{await p(I,$,x),i++,v(y,"done")}catch{d++,v(y,"error")}b(i+d,a,d>0?`${i} of ${a} downloaded (${d} failed)`:`Downloaded ${i} of ${a}\u2026`)}s&&(s.textContent=d>0?`${i} Done`:"All Done!"),t&&(t.innerHTML=d>0?`<strong>Download complete.</strong> ${i} of ${a} stories saved successfully${d>0?`, ${d} failed`:""}.`:`<strong>All ${a} stories downloaded!</strong> Your Instagram stories have been saved to your device without watermark.`),b(a,a,d>0?`Finished \u2014 ${i} downloaded, ${d} failed`:`All ${a} stories downloaded!`),setTimeout(()=>{g.disabled=!1,g.classList.remove("dl-tile-processing"),s&&(s.textContent="Download All"),l&&(l.hidden=!0);let r=document.getElementById("dl-all-bar-fill");r&&(r.style.width="0%"),t&&(t.innerHTML=`${c} active ${c===1?"story":"stories"} ready to download. Click <strong>Download All</strong> or tap any story to save it.`)},3e3)})}j?.addEventListener("submit",async n=>{n.preventDefault(),Y();let o=q.value.trim();if(!o){B(`Please paste an Instagram ${A} URL.`);return}if(!W[w].test(o)){let m=w==="video"?"https://www.instagram.com/p/\u2026":`https://www.instagram.com/${w==="audio"?"reel":w}/\u2026`;B(`Please enter a valid Instagram ${A} URL (e.g. ${m})`);return}if(P(!0),E.innerHTML="",w==="story"){E.innerHTML=`
      <div class="result-card stories-loading-card animate-fade-in-up" role="status" aria-live="polite">
        <div class="stories-loading-icon">
          <div class="stories-loading-ring"></div>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div class="stories-loading-text">
          <span class="stories-loading-title">Fetching stories\u2026</span>
          <span class="stories-loading-sub" id="loading-sub">Connecting to Instagram</span>
        </div>
        <div class="stories-loading-dots"><span></span><span></span><span></span></div>
      </div>
    `;let m=document.getElementById("loading-sub"),c=["Connecting to Instagram","Resolving account","Loading story tray","Preparing downloads"],h=0,f=setInterval(()=>{h=Math.min(h+1,c.length-1),m&&(m.textContent=c[h])},2e3);window.__igPhaseTimer=f}try{let m=await _(),c=m?"&turnstileToken="+encodeURIComponent(m):"",h=await fetch(`/api/instagram-download?url=${encodeURIComponent(o)}&type=${w}${c}`);window.__igPhaseTimer&&(clearInterval(window.__igPhaseTimer),delete window.__igPhaseTimer);let f=await h.text(),p;try{p=JSON.parse(f)}catch{throw new Error("Invalid Instagram link or API is busy. Please check the link and try again.")}if(!h.ok||!p.success)throw new Error(p.error||"Failed to fetch content. Please try again.");p.stories&&p.stories.length>0?K(p.stories):V(p.video,o)}catch(m){window.__igPhaseTimer&&(clearInterval(window.__igPhaseTimer),delete window.__igPhaseTimer),B(m.message||"Something went wrong. Please try again.")}finally{P(!1)}});
