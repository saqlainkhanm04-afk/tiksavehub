function I(t,e,a="Processing\u2026",n){let l=n?.ceiling??85,o=n?.intervalMs??250,r=0,s=!1,d={current:0,stop(i){s||(s=!0,clearInterval(c),i!=null&&t&&(t.style.transition="width 0.3s ease",t.style.width=i+"%"),e&&i!=null&&(e.textContent=a+" "+Math.round(i)+"%"))}},c=setInterval(()=>{if(s){clearInterval(c);return}let i=l-r,p=Math.max(.5,i*.08);r=Math.min(r+p,l),d.current=r,t&&(t.style.transition="none",t.style.width=r+"%"),e&&(e.textContent=a+" "+Math.round(r)+"%")},o);return d}var $=["Connecting to server","Extracting video data","Preparing download links"],J=`
/* Download loading card \u2014 injected once via download-progress.ts */
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
`,E=!1;function K(){if(E)return;E=!0;let t=document.createElement("style");t.textContent=J,document.head.appendChild(t)}function H(t,e){K();let a=e?.title??"Fetching your video\u2026",n=e?.phases??$,l=e?.icon??'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',o=document.createElement("div");o.className="tsh-loading-card",o.setAttribute("role","status"),o.setAttribute("aria-live","polite"),o.innerHTML=`
    <div class="tsh-loading-icon">
      <div class="tsh-loading-ring"></div>
      ${l}
    </div>
    <div class="tsh-loading-text">
      <span class="tsh-loading-title">${a}</span>
      <span class="tsh-loading-sub" id="tsh-loading-sub">${n[0]}</span>
    </div>
    <div class="tsh-loading-dots"><span></span><span></span><span></span></div>
  `,t.appendChild(o);let r=0,s=!1,d=o.querySelector(".tsh-loading-sub"),c=setInterval(()=>{if(s){clearInterval(c);return}r=Math.min(r+1,n.length-1),d&&(d.textContent=n[r])},2500);return{destroy(){s=!0,clearInterval(c),o.remove()},setSub(i){s=!0,clearInterval(c),d&&(d.textContent=i)}}}var W=document.getElementById("x-form"),y=document.getElementById("x-url"),P=document.getElementById("x-clear"),Z=document.getElementById("download-btn"),Q=document.getElementById("btn-label"),tt=document.getElementById("btn-spinner"),A=document.getElementById("error-msg"),et=document.getElementById("error-text"),m=document.getElementById("result-mount"),nt=/^(https?:\/\/)?(www\.|mobile\.|m\.|)?(twitter\.com|x\.com)\//i,j="0x4AAAAAAEl-ZmiorHhgs7jw",u=null,g=!1,x=null;function R(){if(x!==null&&typeof window.turnstile<"u"){try{window.turnstile.remove(x)}catch{}x=null}}function U(){if(typeof window.turnstile>"u"){setTimeout(U,500);return}let t=document.getElementById("cf-turnstile-container");t&&(R(),x=window.turnstile.render(t,{sitekey:j,appearance:"interaction-only",callback:e=>{u=e,g=!0},"error-callback":()=>{u=null,g=!1},"expired-callback":()=>{u=null,g=!1}}))}U();function _(){return new Promise(t=>{if(u&&g){t(u);return}let e=document.getElementById("cf-turnstile-container");if(!e||typeof window.turnstile>"u"){t(null);return}R(),e.innerHTML="",x=window.turnstile.render(e,{sitekey:j,appearance:"interaction-only",callback:a=>{u=a,g=!0,t(a)},"error-callback":()=>{u=null,g=!1,t(null)},"expired-callback":()=>{u=null,g=!1,t(null)}}),setTimeout(()=>t(u),8e3)})}function B(t){Z.disabled=t,Q.hidden=t,tt.hidden=!t;let e=document.getElementById("fetch-note");e&&(e.hidden=!t)}function ot(){let t=["Connecting to X","Extracting video data","Preparing download links"];window.__xLoadingCard=H(m,{title:"Fetching your video\u2026",phases:t,icon:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'})}function S(){let t=window.__xLoadingCard;t&&(t.destroy(),delete window.__xLoadingCard)}function v(t){et.textContent=t,A.removeAttribute("hidden"),m.innerHTML=""}function N(){A.setAttribute("hidden","")}function L(){P.hidden=!y.value.trim()}y.addEventListener("input",L);document.querySelectorAll(".paste-btn").forEach(t=>{t.addEventListener("click",async()=>{let e=document.getElementById(t.dataset.pasteTarget||"");if(!e)return;let a="";try{navigator.clipboard&&window.isSecureContext?a=await navigator.clipboard.readText():window.clipboardData&&window.clipboardData.getData&&(a=window.clipboardData.getData("Text"))}catch{}a?(e.value=a.trim(),e.focus(),L()):e.focus()})});P.addEventListener("click",()=>{y.value="",y.focus(),L(),N(),m.innerHTML=""});function at(t){let e=Math.floor(t/60),a=Math.floor(t%60);return e+":"+a.toString().padStart(2,"0")}function b(t){return t==null?"":t.toLocaleString("en-US")}var D='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',st='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',rt='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',it='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',lt='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';function dt(t,e){if(!t){v("No video data found. Please check the link and try again.");return}let{username:a,authorName:n,authorAvatar:l,text:o,thumbnail:r,duration:s,viewCount:d,likeCount:c,retweetCount:i,hdUrl:p,sdUrl:h}=t||{},w=n||a||"",k=a?"@"+a.replace(/^@/,""):"",O=r?'<img src="'+r+`" alt="Tweet media" class="x-result-thumb" loading="lazy" width="120" height="160" referrerpolicy="no-referrer" data-proxy="0" onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.closest('.x-result-thumb-wrap').classList.add('thumb-failed')}" />`:'<div class="x-result-thumb-fallback" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></div>',q=s?'<span class="x-result-duration-badge">'+at(s)+"</span>":"",z=l?'<img src="'+l+'" alt="'+(w||"Author")+`" class="x-result-author-avatar" width="40" height="40" referrerpolicy="no-referrer" onerror="this.style.display='none'" />`:"",f=[];d!=null&&f.push('<span class="x-result-stat">'+rt+" "+b(d)+" views</span>"),c!=null&&f.push('<span class="x-result-stat">'+it+" "+b(c)+"</span>"),i!=null&&f.push('<span class="x-result-stat">'+lt+" "+b(i)+"</span>");let T=!!p,C=!!h,F=T?'<button class="x-dl-tile" id="x-btn-dl-hd" type="button" data-dl="hd" data-url="'+encodeURIComponent(e)+'" aria-label="Download HD video"><span class="x-dl-tile-icon" aria-hidden="true">'+D+'</span><span class="x-dl-tile-label">Download <strong>HD Video</strong></span><span class="x-dl-badge" aria-hidden="true">HD</span><span class="x-dl-proc-bar"></span></button>':"",V=C?'<button class="x-dl-tile" id="x-btn-dl-sd" type="button" data-dl="sd" data-url="'+encodeURIComponent(e)+'" aria-label="Download SD video"><span class="x-dl-tile-icon" aria-hidden="true">'+D+'</span><span class="x-dl-tile-label">Download <strong>SD Video</strong></span><span class="x-dl-proc-bar"></span></button>':"",X='<button class="x-dl-tile x-dl-tile-audio" id="x-btn-dl-audio" type="button" data-dl="audio" data-url="'+encodeURIComponent(e)+'" aria-label="Download audio as MP3"><span class="x-dl-tile-icon" aria-hidden="true">'+st+'</span><span class="x-dl-tile-label">Download <strong>Audio (MP3)</strong></span><span class="x-dl-proc-bar"></span></button>',G=[F,V,X].filter(Boolean).join(""),Y=o?'<p class="x-result-tweet-text">'+o.replace(/</g,"&lt;").replace(/>/g,"&gt;")+"</p>":"";m.innerHTML='<div class="x-result-card animate-fade-in-up" role="region" aria-label="Download result"><div class="x-result-header"><div class="x-result-thumb-wrap">'+O+q+'</div><div class="x-result-info">'+(w?'<div class="x-result-author">'+z+'<div><p class="x-result-author-name">'+w.replace(/</g,"&lt;")+"</p>"+(k?'<p class="x-result-author-username">'+k.replace(/</g,"&lt;")+"</p>":"")+"</div></div>":"")+Y+(f.length?'<div class="x-result-stats">'+f.join("")+"</div>":"")+'<div class="x-result-actions">'+G+"</div></div></div></div>",!T&&!C&&v("No downloadable video found. The tweet may only contain a GIF or image."),m.querySelectorAll(".x-dl-tile").forEach(M=>{M.addEventListener("click",()=>ct(M))})}function ct(t){let e=t.dataset.dl,a=t.dataset.url;if(!e||!a)return;let n=t.querySelector(".x-dl-tile-label"),l=n?.textContent||"",o=t.querySelector(".x-dl-proc-bar");t.classList.add("x-dl-tile-processing"),t.disabled=!0,n&&(n.textContent="Processing\u2026 0%"),o&&(o.style.transition="none",o.style.width="0%");let r=I(o,n,"Processing\u2026",{ceiling:85,intervalMs:250}),s=new XMLHttpRequest;_().then(d=>{let c=d?"&turnstileToken="+encodeURIComponent(d):"";s.open("GET","/api/x-download?url="+decodeURIComponent(a)+"&dl="+e+c),s.responseType="blob",s.timeout=12e4,s.onprogress=function(i){if(i.lengthComputable&&o&&n){let p=Math.round(i.loaded/i.total*100);r.stop(p)}},s.onload=function(){if(r.stop(s.status===200?100:void 0),s.status===200){let i=s.response,p=URL.createObjectURL(i),h=document.createElement("a");h.href=p,h.download=e==="audio"?"tiksavehub-audio.mp3":"tiksavehub-video.mp4",document.body.appendChild(h),h.click(),document.body.removeChild(h),setTimeout(()=>URL.revokeObjectURL(p),6e4),t.classList.add("x-dl-tile-done"),n&&(n.innerHTML=l),setTimeout(()=>t.classList.remove("x-dl-tile-done"),1500)}else t.classList.add("x-dl-tile-error"),n&&(n.textContent="Download failed \u2014 try again"),setTimeout(()=>{t.classList.remove("x-dl-tile-error"),n&&(n.innerHTML=l)},2e3);t.classList.remove("x-dl-tile-processing"),t.disabled=!1,o&&(o.style.width="0%")},s.onerror=function(){r.stop(),t.classList.add("x-dl-tile-error"),n&&(n.textContent="Download failed \u2014 try again"),setTimeout(()=>{t.classList.remove("x-dl-tile-error"),n&&(n.innerHTML=l)},2e3),t.classList.remove("x-dl-tile-processing"),t.disabled=!1,o&&(o.style.width="0%")},s.ontimeout=function(){r.stop(),t.classList.add("x-dl-tile-error"),n&&(n.textContent="Timed out \u2014 try again"),setTimeout(()=>{t.classList.remove("x-dl-tile-error"),n&&(n.innerHTML=l)},2e3),t.classList.remove("x-dl-tile-processing"),t.disabled=!1,o&&(o.style.width="0%")},s.send()})}W?.addEventListener("submit",async t=>{t.preventDefault(),N();let e=y.value.trim();if(!e){v("Please paste an X or Twitter video URL.");return}if(!nt.test(e)){v("Please enter a valid X or Twitter video link (e.g. x.com/user/status/... or twitter.com/user/status/...).");return}B(!0),m.innerHTML="",ot();try{let a=await _(),n=await fetch("/api/x-download",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:e,turnstileToken:a||void 0})});S();let l=await n.text(),o;try{o=JSON.parse(l)}catch{throw new Error("Invalid X link or the API is busy. Please check the link and try again.")}if(!n.ok||!o.success)throw new Error(o.error||"Failed to fetch the video. Please try again.");dt(o.video,e)}catch(a){S(),v(a.message||"Something went wrong. Please try again.")}finally{B(!1)}});
