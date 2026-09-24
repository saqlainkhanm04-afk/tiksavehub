function N(t,e,o="Processing\u2026",h){let I=h?.ceiling??85,M=h?.intervalMs??250,y=0,p=!1,B={current:0,stop(b){p||(p=!0,clearInterval(k),b!=null&&t&&(t.style.transition="width 0.3s ease",t.style.width=b+"%"),e&&b!=null&&(e.textContent=o+" "+Math.round(b)+"%"))}},k=setInterval(()=>{if(p){clearInterval(k);return}let b=I-y,F=Math.max(.5,b*.08);y=Math.min(y+F,I),B.current=y,t&&(t.style.transition="none",t.style.width=y+"%"),e&&(e.textContent=o+" "+Math.round(y)+"%")},M);return B}var Y=document.getElementById("facebook-form"),P=document.getElementById("facebook-url"),G=document.getElementById("facebook-clear"),nt=document.getElementById("download-btn"),ot=document.getElementById("btn-label"),st=document.getElementById("btn-spinner"),z=document.getElementById("error-msg"),it=document.getElementById("error-text"),T=document.getElementById("result-mount"),lt=/^(https?:\/\/)?(www\.|m\.|mbasic\.|web\.|touch\.)?(facebook\.com|fb\.com)\//i,at=/^(https?:\/\/)?fb\.watch\//i;function q(t){nt.disabled=t,ot.hidden=t,st.hidden=!t;let e=document.getElementById("fetch-note");e&&(e.hidden=!t)}function U(t,e=null){it.textContent=t,z.removeAttribute("hidden"),T.innerHTML="";let o=document.getElementById("retry-btn");if(o&&o.remove(),e==="timeout"||e===null){let h=document.createElement("button");h.id="retry-btn",h.className="error-retry-btn",h.type="button",h.textContent="Try Again",h.addEventListener("click",()=>{O(),Y?.dispatchEvent(new Event("submit",{cancelable:!0}))}),z.appendChild(h)}}function O(){z.setAttribute("hidden","")}function V(){G.hidden=!P.value.trim()}P.addEventListener("input",V);document.querySelectorAll(".paste-btn").forEach(t=>{t.addEventListener("click",async()=>{let e=document.getElementById(t.dataset.pasteTarget||"");if(!e)return;let o="";try{navigator.clipboard&&window.isSecureContext?o=await navigator.clipboard.readText():window.clipboardData&&window.clipboardData.getData&&(o=window.clipboardData.getData("Text"))}catch{}o?(e.value=o.trim(),e.focus(),V()):e.focus()})});G.addEventListener("click",()=>{P.value="",P.focus(),V(),O(),T.innerHTML=""});function Z(t){let e=Math.floor(t/60),o=t%60;return`${e}:${o.toString().padStart(2,"0")}`}var L='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',rt='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',j=document.getElementById("download-form")?.dataset.mode||"video",R=j==="mp3",C=j==="photo",H=j==="story",J="0x4AAAAAAEl-ZmiorHhgs7jw",x=null,$=!1,D=null;function W(){if(D!==null&&typeof window.turnstile<"u"){try{window.turnstile.remove(D)}catch{}D=null}}function K(){if(typeof window.turnstile>"u"){setTimeout(K,500);return}let t=document.getElementById("cf-turnstile-container");t&&(W(),D=window.turnstile.render(t,{sitekey:J,appearance:"interaction-only",callback:e=>{x=e,$=!0},"error-callback":()=>{x=null,$=!1},"expired-callback":()=>{x=null,$=!1}}))}K();function X(){return new Promise(t=>{if(x&&$){t(x);return}let e=document.getElementById("cf-turnstile-container");if(!e||typeof window.turnstile>"u"){t(null);return}W(),e.innerHTML="",D=window.turnstile.render(e,{sitekey:J,appearance:"interaction-only",callback:o=>{x=o,$=!0,t(o)},"error-callback":()=>{x=null,$=!1,t(null)},"expired-callback":()=>{x=null,$=!1,t(null)}}),setTimeout(()=>t(x),8e3)})}function dt(t,e){let{cover:o,duration:h,title:I,hdplay:M,sdplay:y,play:p}=t||{},B=M||p||"",k=y||p||"",b=I||(R?"Facebook Audio":C?"Facebook Photo":"Facebook Video");if(H){let d=Array.isArray(t.segments)?t.segments:[],n=d.length,l=t.title||b;if(!n){U("This story has no downloadable media.");return}let a=n>1?`
        <button class="dl-tile dl-tile-fb dl-tile-prime" id="btn-dl-zip" type="button" aria-label="Download all ${n} media files as ZIP">
          <span class="dl-tile-icon" aria-hidden="true">${L}</span>
          <span class="dl-tile-label">Download <strong>All Media</strong> (${n} items)</span>
          <span class="dl-tile-badge">ZIP</span>
          <span class="dl-proc-bar"></span>
        </button>`:"",v=d.map((i,s)=>{let f=i.kind==="video",c=i.title||(f?`Story Video ${s+1}`:`Story Photo ${s+1}`),m=i.cover||"",u=m?`<img src="${m}" alt="${c}" class="story-seg-thumb" loading="lazy" width="56" height="56" referrerpolicy="no-referrer" data-proxy="0" onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.closest('.story-seg-thumb-wrap').classList.add('thumb-failed')}">`:`<div class="story-seg-thumb story-seg-thumb-fallback" aria-hidden="true">
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
            </div>`,g=f?`
            <button class="dl-tile dl-tile-fb" id="btn-dl-hd-${s}" type="button" aria-label="Download HD video ${s+1}">
              <span class="dl-tile-icon" aria-hidden="true">${L}</span>
              <span class="dl-tile-label">Download <strong>HD Video</strong></span>
              <span class="dl-hd-badge" aria-hidden="true">HD</span>
              <span class="dl-proc-bar"></span>
            </button>
            <button class="dl-tile" id="btn-dl-sd-${s}" type="button" aria-label="Download SD video ${s+1}">
              <span class="dl-tile-icon" aria-hidden="true">${L}</span>
              <span class="dl-tile-label">Download <strong>SD Video</strong></span>
              <span class="dl-proc-bar"></span>
            </button>`:`
            <button class="dl-tile dl-tile-fb" id="btn-dl-photo-${s}" type="button" aria-label="Download photo ${s+1}">
              <span class="dl-tile-icon" aria-hidden="true">${L}</span>
              <span class="dl-tile-label">Download <strong>Photo</strong></span>
              <span class="dl-proc-bar"></span>
            </button>`;return`
          <div class="story-seg" role="group" aria-label="${c}">
            <div class="story-seg-head">
              <div class="story-seg-thumb-wrap">
                ${u}
                ${f&&i.duration?`<span class="result-duration-badge">${Z(i.duration)}</span>`:""}
              </div>
              <div class="story-seg-meta">
                <p class="story-seg-title">${c}</p>
                <p class="story-seg-type">${f?"Video":"Photo"} ${s+1} of ${n}</p>
              </div>
            </div>
            <div class="result-actions">
              ${g}
            </div>
          </div>`}).join("");T.innerHTML=`
      <div class="result-card animate-fade-in-up" role="region" aria-label="Download result">
        <div class="result-header">
          <div class="result-thumb-wrap">
            <img
              src="${o||""}"
              alt="Story thumbnail"
              class="result-thumb"
              loading="lazy"
              width="120"
              height="160"
              referrerpolicy="no-referrer"
              data-proxy="0"
              onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.closest('.result-thumb-wrap').classList.add('thumb-failed')}"
              ${o?"":"hidden"} />
            ${o?"":`<div class="result-thumb-fallback" aria-hidden="true">
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
            </div>`}
          </div>
          <div class="result-info">
            <div class="result-meta">
              <p class="result-title">${l}</p>
              ${n>1?`<p class="photo-count">${n} items found in this story</p>`:""}
            </div>
            <div class="result-actions">
              ${a}
            </div>
          </div>
        </div>
        ${v}
      </div>
    `;let r=document.getElementById("btn-dl-zip");r?.addEventListener("click",()=>w("zip",r));for(let i=0;i<d.length;i++){let s=d[i],f=s.kind==="video",c=document.getElementById(`btn-dl-hd-${i}`),m=document.getElementById(`btn-dl-sd-${i}`),u=document.getElementById(`btn-dl-photo-${i}`);if(c?.addEventListener("click",()=>w("hd",c,i)),m?.addEventListener("click",()=>w("sd",m,i)),u?.addEventListener("click",()=>w("photo",u,i)),!f)continue;let g=!!(s.hdplay||s.sdplay),E=!!(s.sdplay||s.hdplay);g||c?.setAttribute("disabled",""),E||m?.setAttribute("disabled","")}return}if(C){let d=Array.isArray(t.photos)&&t.photos.length?t.photos:t.photoUrl?[t]:[],n=d[0]&&(d[0].photoUrl||d[0].cover)||"",l=d.length,a=t.totalPhotoCount||l,v=5,r=l>1?`<div class="photo-grid" role="list" aria-label="Photos found in this post">
            ${d.map((u,g)=>`<img class="photo-grid-item${g>=v?" photo-grid-hidden":""}" src="${u.cover||u.photoUrl||""}" alt="Facebook photo ${g+1} of ${l}" loading="lazy" width="120" height="120" referrerpolicy="no-referrer" data-proxy="0" onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.style.display='none'}">`).join("")}
            ${l>v?`<button type="button" class="photo-grid-item photo-grid-more" id="btn-grid-more" aria-label="Show all ${l} photos">+${l-v}</button>`:""}
          </div>`:"",i=l>1?"Download <strong>All Photos</strong>":"Download <strong>Photo</strong>",s=l>1?'<span class="dl-tile-badge">'+l+" Photos \xB7 ZIP</span>":'<span class="dl-tile-badge">Full Resolution</span>',f=a>l?`<p class="photo-count-extra">This post has ${a} photos. Showing ${l} available for download. The remaining ${a-l} photos require Facebook login to access.</p>`:"";T.innerHTML=`
      <div class="result-card animate-fade-in-up" role="region" aria-label="Download result">
        <div class="result-header">
          <div class="result-thumb-wrap photo-preview">
            <img
              src="${o||n||""}"
              alt="Facebook photo preview"
              class="result-thumb"
              loading="lazy"
              width="200"
              height="200"
              referrerpolicy="no-referrer"
              data-proxy="0"
              onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.closest('.result-thumb-wrap').classList.add('thumb-failed')}"
              ${!o&&!n?"hidden":""} />
            ${!o&&!n?`<div class="result-thumb-fallback" aria-hidden="true">
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
            </div>`:""}
          </div>
          <div class="result-info">
            <div class="result-meta">
              <p class="result-title">${b}</p>
              ${l>1?`<p class="photo-count">${l} photos found in this post</p>`:""}
              ${f}
            </div>
            <div class="result-actions">
              <button class="dl-tile dl-tile-fb dl-tile-prime" id="btn-dl-photo" type="button" aria-label="Download Facebook photos">
                <span class="dl-tile-icon" aria-hidden="true">${L}</span>
                <span class="dl-tile-label">${i}</span>
                ${s}
                <span class="dl-proc-bar"></span>
              </button>
            </div>
          </div>
        </div>
        ${r}
      </div>
    `;let c=document.getElementById("btn-dl-photo");if(!c)return;n?c.addEventListener("click",()=>w(l>1?"zip":"photo",c)):c.setAttribute("disabled","");let m=document.getElementById("btn-grid-more");m?.addEventListener("click",()=>{T.querySelectorAll(".photo-grid-hidden").forEach(u=>u.classList.remove("photo-grid-hidden")),m.remove()});return}let F=`
    <button class="dl-tile dl-tile-fb" id="btn-dl-hd" type="button" aria-label="Download HD video">
      <span class="dl-tile-icon" aria-hidden="true">${L}</span>
      <span class="dl-tile-label">Download <strong>HD Video</strong></span>
      <span class="dl-hd-badge" aria-hidden="true">HD</span>
      <span class="dl-proc-bar"></span>
    </button>`,Q=`
    <button class="dl-tile" id="btn-dl-sd" type="button" aria-label="Download SD video">
      <span class="dl-tile-icon" aria-hidden="true">${L}</span>
      <span class="dl-tile-label">Download <strong>SD Video</strong></span>
      <span class="dl-proc-bar"></span>
    </button>`,tt=`
    <button class="dl-tile dl-tile-audio${R?" dl-tile-prime":""}" id="btn-dl-audio" type="button" aria-label="Download audio as MP3">
      <span class="dl-tile-icon" aria-hidden="true">${rt}</span>
      <span class="dl-tile-label">Download <strong>Audio (MP3)</strong></span>
      ${R?'<span class="dl-tile-badge">Recommended</span>':""}
      <span class="dl-proc-bar"></span>
    </button>`,et=R?[tt]:[F,Q];T.innerHTML=`
    <div class="result-card animate-fade-in-up" role="region" aria-label="Download result">
      <div class="result-header">
        <div class="result-thumb-wrap">
          <img
            src="${o||""}"
            alt="Video thumbnail"
            class="result-thumb"
            loading="lazy"
            width="120"
            height="160"
            referrerpolicy="no-referrer"
            data-proxy="0"
            onerror="if(this.dataset.proxy==='0'){this.dataset.proxy='1';this.src='/api/proxy-image?url='+encodeURIComponent(this.src)}else{this.closest('.result-thumb-wrap').classList.add('thumb-failed')}"
            ${o?"":"hidden"} />
          ${o?"":`<div class="result-thumb-fallback" aria-hidden="true">
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
          </div>`}
          <span class="result-duration-badge text-caption-mono">${Z(h||0)}</span>
        </div>
        <div class="result-info">
          <div class="result-meta">
            <p class="result-title">${b}</p>
          </div>
          <div class="result-actions">
            ${et.join("")}
          </div>
        </div>
      </div>
    </div>
  `;let S=document.getElementById("btn-dl-hd"),A=document.getElementById("btn-dl-sd"),_=document.getElementById("btn-dl-audio");(!B||!S)&&S?.setAttribute("disabled",""),(!k||!A)&&A?.setAttribute("disabled","");function w(d,n,l){if(!n)return;n.classList.add("dl-tile-processing"),n.disabled=!0;let a=n.querySelector(".dl-tile-label"),v=a?.textContent||"";a&&(a.textContent="Processing\u2026 0%");let r=n.querySelector(".dl-proc-bar");r&&(r.style.transition="none",r.style.width="0%");let i=N(r,a,"Processing\u2026",{ceiling:85,intervalMs:250}),s=new XMLHttpRequest,f=typeof l=="number"&&l>=0?`&idx=${l}`:"";X().then(c=>{let m=c?"&turnstileToken="+encodeURIComponent(c):"";s.open("GET",`/api/facebook?url=${encodeURIComponent(e)}&dl=${d}${f}${m}`),s.responseType="blob",s.timeout=12e4,s.onprogress=function(u){if(u.lengthComputable&&r&&a){let g=Math.round(u.loaded/u.total*100);i.stop(g)}},s.onload=function(){if(i.stop(s.status===200?100:void 0),s.status===200){let u=s.response,g=URL.createObjectURL(u),E=document.createElement("a");E.href=g,E.download=d==="audio"?"tiksavehub-facebook-audio.mp3":d==="photo"?"tiksavehub-facebook-photo.jpg":d==="zip"?H?"tiksavehub-facebook-story.zip":"tiksavehub-facebook-photos.zip":"tiksavehub-facebook-video.mp4",document.body.appendChild(E),E.click(),document.body.removeChild(E),setTimeout(()=>URL.revokeObjectURL(g),6e4),n.classList.add("dl-tile-done"),setTimeout(()=>n.classList.remove("dl-tile-done"),1500)}else n.classList.add("dl-tile-error"),setTimeout(()=>n.classList.remove("dl-tile-error"),2e3);n.classList.remove("dl-tile-processing"),n.disabled=!1,a&&(a.textContent=v),r&&(r.style.width="0%")},s.onerror=function(){i.stop(),n.classList.add("dl-tile-error"),setTimeout(()=>n.classList.remove("dl-tile-error"),2e3),n.classList.remove("dl-tile-processing"),n.disabled=!1,a&&(a.textContent=v),r&&(r.style.width="0%")},s.ontimeout=function(){i.stop(),n.classList.add("dl-tile-error"),a&&(a.textContent="Timed out \u2014 try again"),setTimeout(()=>{n.classList.remove("dl-tile-error"),a&&(a.textContent=v)},2e3),n.classList.remove("dl-tile-processing"),n.disabled=!1,r&&(r.style.width="0%")},s.send()})}S?.addEventListener("click",()=>w("hd",S)),A?.addEventListener("click",()=>w("sd",A)),_?.addEventListener("click",()=>w("audio",_))}Y?.addEventListener("submit",async t=>{t.preventDefault(),O();let e=P.value.trim();if(!e){U(C?"Please paste a Facebook photo URL.":"Please paste a Facebook video URL.");return}if(!lt.test(e)&&!at.test(e)){U(C?"Please enter a valid Facebook photo link (e.g. facebook.com/photo.php?fbid=\u2026, facebook.com/share/p/\u2026 or facebook.com/{profile}/posts/\u2026).":"Please enter a valid Facebook video link (e.g. facebook.com/username/videos/\u2026 or fb.watch/\u2026).");return}q(!0),T.innerHTML="";try{let o=await X(),M=await fetch(H?"/api/facebook-story":"/api/facebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(H?{url:e}:{url:e,mode:j,turnstileToken:o||void 0})}),y=await M.text(),p;try{p=JSON.parse(y)}catch{throw new Error("Invalid Facebook link or the API is busy. Please check the link and try again.")}if(!M.ok||!p.success){let k=new Error(p.error||"Failed to fetch the video. Please try again.");throw k.errorType=p.errorType||null,k}let B=H?p.data:C?p.photo:p.video;dt(B,e)}catch(o){U(o.message||"Something went wrong. Please try again.",o.errorType||null)}finally{q(!1)}});
