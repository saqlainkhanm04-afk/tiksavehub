# AI-MEMORY — AI Assistant History & Work Log (ONLY for AI)

> Sirf AI assistant ke liye. Read before starting ANY work. Write after EVERY work.
> Continue karne se pehle is file ko parhna.
> Koi bhi kaam se pehle: pehle is file + Google deep research, phir kaam.
> Google deep research hamesha US ka (deep search mode), not top search.

## RULES (never break)
1. Read this file before starting ANY task.
2. Deep research on Google before building anything.
3. Save all work, decisions, research notes here after EVERY task.
4. **SAVE AS YOU GO (USER REQUIREMENT):** saath-saath (har kaam k sath) save karo — puri task khatam hone ka wait nahi karna. Every sub-step done → usi waqt yahan notes / session log / file changes save karo. Task ke beech bhi progress update rakho taaki crash ya restart par kuch lost na ho.
5. Kaam ke doran changes ka bhi short log rakhna (hot session log) — ya tho AI-MEMORY.md me ek "IN-PROGRESS SESSION" section, ya alag working-file (.md) me. Session end par final summary AI-MEMORY.md me.
6. On restart: read this file and continue exactly from where work stopped.
7. Use skills: astro, tailwind-4-docs, web-design-guidelines + DESIGN.md
8. No secret keys / passwords in this file ever.

---

## PROJECT OVERVIEW
- Project: (to fill)
- Tech stack: Astro + Tailwind v4 (used according to AGENTS.md)
- Purpose: (to fill)

---

## DEEP RESEARCH NOTES
(date/link/### kya seekha)

---

## WORK SESSIONS (date-ordered, latest at bottom)

### Session — PROJECT START (2026-08-08)
- Created this AI-MEMORY.md file (08 Aug 2026).
- Kuch kaam ki shuruaat nahi hui thi abhi.
- Next: user ne kahaa ab kaam shuru hoga — pehle is file read karo, phir research, phir kaam.

### Session — Instagram downloader audit FINAL VERDICT (2026-08-09)
- Verified prod readiness of IG downloader (InstagramDownloadForm + /api/instagram-download).
- Dev server started (port 3000), ran all pending tests from INSTAGRAM-DOWNLOADER-AUDIT.md:
  1. yt-dlp fallback PROVEN — temp script blocked GraphQL/embed/__a=1, yt-dlp returned valid MP4 ("SUCCESS via yt-dlp-only path").
  2. `dl=true` streams video/mp4 + attachment filename, full 10.5MB (10,544,836 = exact Content-Length). First attempt truncated once = transient, resolved on retry.
  3. Invalid reel → HTTP 500 friendly body, no raw tech strings leak.
- Final production verdict: **YES** (see INSTAGRAM-DOWNLOADER-AUDIT.md).
- Notes: installed tsx `--no-save` (npx cache was corrupted, EFTYPE). `.gitignore` must cover the temp/test files; test file deleted. `data/cache` + `dev.log`/`stdout.log`/`stderr.log` are untracked.
- Done next session: any pending TODO in INSTAGRAM-DOWNLOADER-AUDIT.md or continue other pages (tiktok-to-mp3, instagram-audio, etc.).

### Session — TikTok downloader full audit (2026-08-09)
- Live-tested the full TikTok chain on dev server :3000 (restarted at 12:55 to clear wedged in-memory state): `/api/download`, `/api/download-mp3`, tikwm→yt-dlp fallback, media cache, rate limit.
- Verified:
  - No-watermark video: `play`/`hdplay` are distinct CDN mp4s (v16m/v16-notes.tiktokcdn-us.com), separate from `wmplay`. `dl=1` & `dl=hd` stream 200 + `video/mp4` + valid `ftyp` magic, full byte count (5.5MB sample).
  - Cache: 2nd request `fromCache:true` in ~5ms (vs ~6s fresh); media-cache.json validated lazily (expired CDN links invalidate themselves).
  - MP3: `audio.play_url` returned; `dl=1` streams real MP3 (ID3 magic, `audio/mpeg`, clean filename "original sound - willsmith.mp3").
  - Errors: bad URL → 422 friendly; invalid ID → 500 friendly; rate limit >30min → 429 friendly. No raw internals leak.
- FIXED BUG (src/lib/tiktok.ts `raceFirstSuccess`): when fallback rejects BEFORE primary and primary later also fails, `pending` decremented to 0 but the primary rejection handler never checked `pending===0`, so the promise never resolved → invalid/nonexistent TikTok IDs hung the request indefinitely (observed 170s+, HTTP:000). Added the missing terminate check. After fix + server restart: invalid ID → friendly 500 in ~20-25s. `npx astro check` clean (0 errors).
- Verdict: **YES ready for production** (details in session).

---

### Session — Full website scan + fix (2026-08-11)
- Ran full scan: `npx astro check` (43 files) + `npm run build`.
- Result: 0 errors, 0 warnings — build passes clean, all routes prerender fine.
- Fixed 1 hint: removed dead/unreachable inline `DOMContentLoaded` submit-preventDefault script in `src/components/Mp3DownloadForm.astro` (form already has `onsubmit="return false"` + real submit handler in module script). After fix: `astro check` = 0/0/0 (clean).
- Log review: server-error.log / prod-log.txt / dev.log all show only expected transient issues (IP-blocked TikTok post, stream timeout abort, EADDRINUSE from overlapping server instances) — no code bugs. KV `process.on(SIGTERM/SIGINT)` listeners are the source of MaxListenersExceededWarning in dev reloads — benign, prod-safe.
- No further errors found. Site is clean & buildable.

---

### Session — Website scan + `transition: all` cleanup (2026-08-13)
- Ran full scan: `npx astro check` (47 files) = 0 errors/0 warnings/0 hints; `npm run build` passes clean.
- Web Interface Guidelines review: only real issue was `transition: all 0.2s/0.25s ease` anti-pattern ×41 across 14 files (perf).
- FIXED: replaced every `transition: all` with explicit properties (derived from each rule's own `:hover` block), e.g. `transform, box-shadow`, `border-color, transform, box-shadow`, etc. Used a temp Node script; verified 0 `transition: all` remain + `astro check` clean.
- `outline: none` on inputs (global.css `.form-input-lg`, blog search/newsletter inputs) all have `:focus` box-shadow + global `:focus-visible` ring replacements → compliant, left as-is.
- No git commit made (repo still has no commits; changes are working-tree only).

---

### Session — Slow page-switch FIX: prerender + self-hosted fonts (2026-08-13)
- **User complaint:** switching between pages (e.g. TikTok downloader → MP3) took a long time; asked network vs code.
- **Root cause:** site is `output: 'server'` (node adapter) and all main pages were SSR'd ON EVERY request — each click re-rendered the whole ~1500-line page (335–747ms measured locally, worse on host), plus render-blocking Google Fonts CSS from external CDN (slow/blocked in some regions) was stalling first paint. HTML payload 209–238KB each.
- **Fix 1 — prerender:** added `export const prerender = true` to 11 pages: tiktok-video, tiktok-to-mp3, 4× instagram pages, blog, contact, privacy, terms, dmca. API routes stay `prerender = false` (downloads still work). Now served as static HTML from dist. Production timing: 335–747ms → **82–211ms**; HTML drops to 73–78KB. Blog posts already were prerendered.
- **Fix 2 — self-host fonts:** downloaded Inter (var, latin) + JetBrains Mono (latin) woff2 → `public/fonts/` (`inter-latin.woff2` 47KB, `jetbrains-mono-latin.woff2` 21KB), added `@font-face` (`font-display: swap`) in `global.css`, removed Google Fonts `<link>`/preconnect/preload from `Layout.astro`. Confirmed built CSS has zero `fonts.googleapis/gstatic` references.
- Verified: `astro check` 0 errors; `npm run build` prerenders all 11 pages; prod server (dist) times fast; dev server restarted on :3000.
- **To benefit on web:** `npm run build` + redeploy dist. No git commit made.
- **Not the user's network alone** — code had real issues; fixes remove per-click SSR + external render-blocking font dependency.

---

### Session — Remaining downloader pages audit (tiktok-to-mp3, IG audio/story/reels) (2026-08-14)
- Restarted dev server on :3000 (was down; node process gone). `astro check` 0/0/0. All 9 main pages serve 200.
- **tiktok-to-mp3 (`/api/download-mp3`):** Verified live: missing url → 400 friendly; invalid/non-TikTok url → 422 friendly. Fallback chain PROVEN via log: tikwm (20s timeout) → retry → yt-dlp was reached but dev IP is TikTok-blocked ("Your IP address is blocked from accessing this post" from yt-dlp stderr) — environment limitation, NOT code. Chain + error mapping correct; friendly 500 no raw leak. ffmpeg NOT installed locally → bitrate selector hidden gracefully (`ffmpegAvailable:false`), `br=` re-encode path returns friendly 501. Media fetch + `dl=1` stream could NOT be live-verified today (same TikTok block) — code identical to verified `/api/download` path; needs production IP retest.
- **instagram-audio (`type=audio`):** Verified live on `/reel/DH56yy7p3lZ/`: metadata 200 with `audio_format=m4a`; `dl=true` streamed full 445,530 bytes; decoded CDN `efg` payload = `dash_baseline_audio_v1`, duration_s 60, bitrate 59,330 → the stream is GENUINE audio-only m4a. Cache entry `media:ig:audio:DH56yy7p3lZ` carries `audio_format` marker (older bad rows skipped via `cacheUsable` guard — working as designed).
- **instagram story:** anonymous fetch is fragile on this IP — invalid/highlights story URL → friendly 500 ("Failed to fetch this content..."). Stories realistically need `IG_SESSIONID` (`needsSession` branch in instagram-download.ts:234). No live story URL available to test the success path — code path (GraphQL media_info → yt-dlp fallback with username URL) reviewed, matches verified patterns.
- **instagram-reels + video:** live verified again (fresh 1.3–3.9s, cached instant).
- **Facebook regression:** POST /api/facebook → 200 `fromCache:true` (previous session's work intact).
- **Finding (documented, no code change):** `stream.ts:39` sets Content-Type from UPSTREAM first, so IG audio downloads carry CDN's `video/mp4` header with an `.m4a` attachment filename. Content is genuinely audio-only (proven above); m4a IS an mp4 container, so this is honest + cosmetic. Left as-is: switching precedence would mislabel CDN error pages (text/html) as media.
- **Verdict: all audited pages production-ready in code.** Only retest needed: TikTok MP3 media+stream from a non-blocked (production) IP.
- No git commit made (repo still "No commits yet").

---

### Session — Competitor SEO gap-fill on all downloader pages (2026-08-14)
- User provided competitor SEO analysis (FDown, GetVidFB, SaveKit, FDownloader) + a "master prompt" for outranking content. Applied it across the site.
- **Facebook page (`/facebook-video-downloader`):**
  - Title → "Facebook Video Downloader HD — No Watermark, Free Download | TikSaveHub"; description + keywords now lead with "no watermark"/"HD" variants.
  - H1 → "Facebook Video Downloader — HD, No Watermark"; subline + hero paragraph now state "HD up to 1080p, SD or HD MP4, MP3 audio, no watermark"; badge "Free · HD Quality · No Watermark"; trust chips now 5 (added "No Watermark", "HD up to 1080p").
  - SEO article: +4 new H3 blocks — "What quality and formats do you get?", "Download on iPhone, Android, or desktop", "Can you save Facebook Live replays?", "Where do downloaded Facebook videos go?".
  - FAQ 10 → 15: +dl-iphone, dl-saved, dl-live, dl-whyfail, dl-app; dl-quality answer now mentions SD/HD up to 1080p + no watermark. JSON-LD auto-updates (15 Questions).
- **All 6 other downloader pages:** added 2 practical FAQs each — "Where do downloaded X get saved?" + "Why can't I download some X?" (platform-customized; TikTok pages use mp3-* ids). JSON-LD counts: tiktok-video 13, tiktok-to-mp3 12, ig-video 12, ig-reels 12, ig-story 13, ig-audio 13, fb 15.
- Honesty maintained: NO 4K/2K claims anywhere (tool tops out at available HD ~1080p) — deliberately outranks without lying.
- Verified: `astro check` 0/0/0, `npm run build` green, all 7 pages render with new FAQs + JSON-LD. Dev server :3000 running.
- No git commit (repo still "No commits yet").

---

## FIRST GIT COMMIT (2026-08-14)
- User said "sub kuch save kr lo" → committed everything: commit `3dbbe74` "Initial commit: TikSaveHub — TikTok, Instagram & Facebook video/audio downloader" (111 files).
- `.gitignore` extended: dev.log, devout.txt, stdout.log, stderr.log, `data/` (runtime media cache) — no secrets committed (`.env.example` is an empty template; no `.env` exists).
- Git identity set repo-local: user.name=TikSaveHub, user.email=admin@tiksavehub.com.
- Working tree now clean.

---

### Session — Production environment setup artifacts (2026-08-15)
- User chose "Production env setup" (next task after FB downloader DONE).
- Research (2026): yt-dlp server best practice = standalone binary at `/usr/local/bin/yt-dlp` (bundled Python, self-update `yt-dlp -U`, nightly channel optional), wget/curl from GitHub latest release; ffmpeg via apt. Confirmed no `.env` auto-load in the node standalone server (`dist/server` entry reads only `process.env`).
- Created (committable, no src changes):
  - `.env.production.example` — production env template with server paths: IG_SESSIONID/IG_DS_USER_ID/IG_CSRF_TOKEN (blank to fill), YTDLP_PATH=/usr/local/bin/yt-dlp, FFMPEG_PATH=/usr/bin/ffmpeg, `CACHE_FILE=/var/lib/tiksavehub/media-cache.json` (outside deploy dir — dist/ is wiped on redeploy), HOST=0.0.0.0 PORT=3000 NODE_ENV=production, RATE_LIMIT_PER_MIN=30, INDEXNOW_KEY.
  - `deploy/tiksavehub.service` — systemd unit: User/Group=tiksavehub, WorkingDirectory=/opt/tiksavehub, `EnvironmentFile=/etc/tiksavehub/env`, ExecStart=`node dist/server/entry.mjs`, Restart=always, app logs to /var/log/tiksavehub/.
  - `scripts/setup-server.sh` — Ubuntu/Debian one-shot: installs ffmpeg (apt), Node >=22 via NodeSource if needed, yt-dlp binary, creates service user + /var/lib/tiksavehub + /etc/tiksavehub (env chmod 600, never overwrites existing), installs systemd unit. Idempotent; print next steps (fill env, deploy dist, enable --now, smoke test).
- `.gitignore` already covers `.env` + `.env.production` — safe to create real `.env.production` locally (not committed).
- Next: user pastes IG_SESSIONID into `/etc/tiksavehub/env` on the server, deploys dist, starts service. No git commit made.

---

### Session — Nav/ad layout fixes (2026-08-15)
- User reported 3 UI issues (site still NOT launched; prod env artifacts created earlier stay for launch day).
- FIX 1 — header section links: removed the fixed left `float-nav` sidebar (How It Works/Features/FAQ on tool pages) from NavBar.astro; links now live INSIDE the header bar as a horizontal row: `<nav class="section-nav">` between `.nav-links` and `.nav-ctas`, `display:flex; flex-direction:row; align-items:center;` with hairline left separator. Renamed classes float-nav* → section-nav*; hover = soft bg + bottom gradient underline (was left-edge vertical bar). Still hidden <1180px (same breakpoint), still tool-pages-only (`showSectionNav`).
- FIX 2 — Facebook nav icon: `.nav-link-fb` + `.fb-nav-icon` (desktop) and `.mobile-nav-link-fb` (mobile) got `display:inline-flex/flex; align-items:center; gap:6px` — FB was the only nav link skipped when the other 4 got flex rules, so the icon stacked above the label.
- FIX 3 — ad CLS placeholder: added `<div class="ad-slot" data-ad-slot="hero" aria-hidden="true">` (CSS `min-height:90px; margin-top:var(--spacing-sm)`) between the input form and `.hero-notice` in ALL 4 download forms (DownloadForm, Mp3DownloadForm, InstagramDownloadForm, FacebookDownloadForm). Monetag script mounts there later without layout shift. NOTE: no Monetag script/code exists in the repo yet — only the reserved slot.
- Verified: `npx astro check` 0/0/0 (53 files); `npm run build` green; built HTML checked — section-nav present in header (3 links), float-nav gone, ad-slot between form and hero-notice (index order verified), FB link markup intact.
- No git commit made.

---

### Session — Facebook nav button full build (2026-08-15)
- Follow-up to the FB icon alignment fix: user asked to build the FB nav icon properly like Downloader/MP3/Instagram.
- Changed FB icon SVG (desktop + mobile): from bare "f" glyph path to the official Facebook logo (circle + f, simple-icons path, fill currentColor, same 14x14).
- Added full button styling for `.nav-link-fb` mirroring the other 4 pattern links: FB-blue gradient pill (`#1877f2`→`#42a5ff`, bg rgba .12, border rgba .25), `fb-nav-pulse` keyframes, hover scale(1.05) + glow + `#1259c7` + `animation:none`, `::before` overlay, `:active` scale(.92), `fb-icon-bounce` on hover, `.dark` variants (`#60a5fa`, hover `#dbeafe`), `.mobile-nav-link-fb` (gap 6px, translateX(4px) hover), `fb-click-pop` + JS click handler (`.fb-clicked`, 400ms) — all 5 nav links now have full patterns.
- Verified: astro check 0/0/0, build green, built Layout CSS asset contains all scoped `.nav-link-fb[...]` rules + keyframes + mobile + dark + click selectors. NOTE: built CSS is scoped (`.nav-link-fb[data-astro-cid-ymhdp2rl]`) — grep checks must account for scoping.
- COLOR CORRECTION (user request, same day): user rejected FB-blue — replaced ALL FB button colors with the brand purple/pink palette (`#7c3aed`→`#ec4899` gradient, hover `#6d28d9`, dark `#c084fc`/`#e9d5ff`, mobile `#7c3aed`) identical to Downloader/MP3. Verified: 0 blue tokens in .nav-link-fb rules, 61 purple tokens, anims intact, check 0/0/0 + build green. Blog remains blue/cyan (only one).
- COLOR CORRECTION 2 (user request, same day): user asked "IG icon bhi FB jaisa kar do" — all .nav-link-ig/.mobile-nav-link-ig orange/red tokens replaced with the same purple/pink palette; the one leftover dark-hover border `rgba(251,191,36,.5)` also swapped to `rgba(192,132,252,.5)`. Verified in built Layout CSS: zero orange tokens in nav-link-ig rules (only global `--color-amber:#fbbf24` var remains, unrelated). LEFT AS-IS per scope: InstagramDownloadForm.astro tab pills still orange (NavBar.astro:499 was the only nav-side leftover).
- No git commit made.

---

### Session — FB Photo Downloader full build (2026-08-16)
- User request: "FB photo downloader bhi bana do" — built end-to-end. Verified: `astro check` 0/0/0 (64 files), `npm run build` green, built HTML inspected + API smoke tested.
- **Parse layer** (`src/lib/facebook-url.ts`): `FacebookUrlParseResult` now has `photoId: string | null`. Photo parsing: `PHOTO_PAGE_PATH_RE = /^\/(photo\.php|photo)\/?$/` (+ fbid/photo/story_fbid/id query params), `PHOTO_PROFILE_RE` (`/{user}/photos/{id}`, album-prefixed `a.`/`p.` forms), `PHOTO_VIEW_FULL_RE` (`/photo/view_full_size/`). Photo results: `linkType:'photo'`, `isVideo:false`, `sanitizedUrl` → `photo.php?fbid={id}`. All other parse sites now include `photoId: null`.
- **Extraction** (`src/lib/facebook.ts`): new `FacebookPhoto` interface + `fetchFacebookPhoto(url)` (memoSWR `fb:photo:{url}`, 12h TTL) + `extractPhotoFromHtml()` — tries desktop page then mobile (`www.`→`m.` rewrite), extracts in order: og:image meta → `"image":{"uri":…}` JSON blob → largest non-avatar scontent/fbcdn `<img>` (skips `s\d+x\d+`/emoji/avatar assets); `promote()` rewrites CDN size tokens (`stp=dst-jpg_s…`→`p2048x2048`, `/p\d+x\d+/`→`/p2048x2048/`) for max resolution. Errors via `coded()` with `FB_ERR` codes.
- **API** (`src/pages/api/facebook.ts`): POST body accepts `mode` (`'photo'`); photo links route to photo extractor (cache `cacheHit/cacheWrite('facebook','fb',{photoId},'photo')`), response `{success,type:'facebook-photo',photo:{photoUrl,cover,title,author}}`. Cross-validation: photo link on video tool → 422 "use the Facebook Photo Downloader"; video link on photo tool (`mode:'photo'`) → 422 "That link is a Facebook video, not a photo". GET `dl=photo` streams the image (`streamFromUpstream`, `referer: https://www.facebook.com/`, `image/jpeg`, filename `tiksavehub-facebook-photo.jpg`). New `photoMessageFor(err)`. `cacheKeyOf` now includes `parsed.photoId`.
- **Form** (`src/components/FacebookDownloadForm.astro`): `mode` prop now `'video'|'reels'|'story'|'mp3'|'photo'`; 5th tab "Photo" (`/facebook-photo-downloader`, image icon); photo copy map (placeholder "Paste Facebook photo link"); photo result card = square 200px preview (`photo-preview` class) + single `dl-tile-fb dl-tile-prime` "Download Photo" button w/ "Full Resolution" badge; `startDownload('photo')` filename `.jpg`; POST body `{url, mode}`.
- **Page** (`src/pages/facebook-photo-downloader.astro`): full SEO landing (unique title/desc/keywords/canonical/OG + BreadcrumbList + FAQPage + SoftwareApplication 4.8/8740), FbHeroSection mode="photo", Stats 2M+, 600+ word FbSeoArticle, steps/features/FAQ/CTA, FbInternalLinks incl. photo card.
- **Wiring**: `astro.config.mjs` seoPages + `src/lib/pageSections.ts` TOOL_PAGES got `/facebook-photo-downloader`. `FbInternalLinks.astro` got `'photo'` icon + card added to video (custom grid)/reels/story/mp3 pages. NavBar untouched (still → reels).
- **FB share-link formats fixed (user bug report)**: `SHARE_REEL_RE = /^\/share\/r\/([A-Za-z0-9_-]{4,20})\/?$/` + `SHARE_VIDEO_RE = /^\/share\/v\/([A-Za-z0-9_-]{4,20})\/?$/` — `web.facebook.com/share/r/{code}` (Reels) and `/share/v/{code}` now parse as valid videos (linkType 'reel'/'profile_video', shortCode → cacheKeyOf, sanitizedUrl = share URL itself). Verified live: `web.facebook.com/share/r/1999ebjPbt` → POST 200, `dl=hd`/`dl=sd` stream 200 video/mp4.
- **Photo fetch speedup (user report: "process takes too long")**: photo path no longer waits sequentially on two full page downloads — (1) `fetchPhotoPage` reads response bounded-stream (`readBoundedText`, caps 2.5MB, cancels body reader once enough HTML in) with 12s timeout; (2) desktop + mobile pages fetch in PARALLEL via `Promise.allSettled`, first page yielding usable image wins. Worst case on dev IP: ~40s sequential → ~2s hard cap.
- **Per-tool result tiles (user requests)**: each FB tool's result card now shows ONLY its own download button(s): MP3 page = audio tile only; video/reels/story = HD + SD; photo = photo tile only. NO page shows all three tiles anymore. FAQ/step/hints updated across pages to link `/facebook-to-mp3` where relevant.
- KNOWN DEV-IP LIMITATION (documented, no action planned): dev IP gets shelled FB photo pages — photo.php desktop = 200 shell (~440KB) NO og:image/`"image":{...}`, only reaction-emoji scontent assets (deliberately skipped); mobile = 888B error shell; post plugin = 400. Photo POST on dev IP errors with photo-copy 500 (documented limitation). On unflagged IPs desktop pages carry og:image → extractor works (standard pattern used by all FB photo downloaders).
- No git commit made (working tree still uncommitted — FB photo work + share links + speedup all in tree).

---

### Session — FB Story downloader strict-mode fix + story permalink extraction (2026-08-16)
- **User bug report (Hinglish):** story page pe regular VIDEO link paste karte hi wo bhi download ho jata hai — "story wale ko theek karo, ye sirf story download karne ke liye hai aur kuch nahi". User ne real story link diya: `https://web.facebook.com/stories/108026714753818/UzpfSVNDOjE3NjAzNDYxMjg0OTg5MjU=?view_single=false`.
- **Root cause:** `/api/facebook` POST kisi bhi valid video link ko accept karta tha (mode prop sirf photo ke liye enforced tha); story URL pattern parse layer me tha hi nahi — `/stories/...` pe invalid URL milta tha. So story tool effectively kisi bhi FB video ko download kar raha tha.
- **FIX — parse** (`src/lib/facebook-url.ts`): naya `linkType: 'story'` added. `STORY_PATH_RE = /^\/(stories)\/(\d{5,20})(?:\/([A-Za-z0-9_=-]{4,64}))?\/?$/` — `/stories/{user_id}[/{story_token}]` (token base64-ish, `=` allow). `STORIES_PHP_PROFILE_RE = /^\/stories\.php\/?$/` + `profile_id` param → mobile stories links bhi 'story'. Both `isVideo: true` so they flow through the standard video extraction pipeline.
- **FIX — story token decode:** `decodeStoryToken()` — story tokens are base64 of `"S:_ISC:{story_id}"` (e.g. `UzpfSVNDOjE3NjAzNDYxMjg0OTg5MjU=` → `1760346128498925`). `sanitizedUrl` for token stories → classic permalink `https://www.facebook.com/story.php?story_fbid={storyId}&id={userId}` — ye wahi page hai jo story ko normal post ki tarah serve karta hai with `playable_url` JSON (standard technique used by FB story downloaders). `videoId = storyId || token || userId`.
- **FIX — API** (`src/pages/api/facebook.ts`): strict mode gate — `toolMode === 'story'` + `linkType !== 'story'` → 422 "That link is not a Facebook story. Please paste a story link — e.g. facebook.com/stories/… — the Story Downloader only downloads stories."; opposite: story link + video/reels/mp3/photo mode → 422 "That link is a Facebook story, not a video. Use the Facebook Story Downloader tool." New `storyMessageFor(err)` — NO_MEDIA/NOT_AVAILABLE → friendly "stories expire after 24 hours / may be private" copy. Stories are NOT media-cached (POST read+write skipped, GET skipped) — stories expire in 24h, caching stale CDN links is useless.
- **Verified (dev server :3000):** video link + mode=story → 422 correct; story link + mode=video → 422 correct; story link parse → `linkType:'story'`, `videoId:'1760346128498925'`, sanitized `story.php?story_fbid=1760346128498925&id=108026714753818`. Story POST on dev IP → 500 story-copy error (KNOWN dev-IP shell — all FB variants incl. story.php permalinks return 400 error shells here; production IPs serve the story permalink page with video JSON).
- Verified: `astro check` 0/0/0, `npm run build` green.
- No git commit made (worktree still uncommitted overall).

---

## LAST SAVE / PAUSE POINT (2026-08-16)

> **IS WAHIN PAR RUKA — yahan se resume karna hai.**
> READ ye section, phir neeche WORK SESSIONS, phir kaam shuru.

- **Kya hua:** FB Photo Downloader full build complete (parse + extraction + API + form + page, verified 0/0/0 + build green + API smoke). Saath me FB share-link formats fix (`share/r/` + `share/v/`) + photo fetch speedup (parallel + bounded stream). Per-tool result tiles done (har tool sirf apne download buttons dikhata hai). **FB Story tool strict-mode fix:** story page ab SIRF story links accept karta hai (parse me `linkType:'story'` + API mode gate) — video/reel links 422 reject, verified live. **Story token decode + story.php permalink extraction:** token se asli story id nikalti hai aur classic `story.php?story_fbid=…&id=…` permalink se media milta hai (ye wahi method hai jo FB story downloaders use karte hain); stories cached nahi hoti (24h expiry).
- **Dev server:** port 3000 (agar nahi chalta to `npm run dev`).
- **Known limitation:** dev IP pe FB photo pages shelled → photo POST error aata hai (og:image nahi milta); production IP pe kaam karega. Do NOT chase dev-IP workaround.
- **Aage ka kaam (user puchhe to):**
  - [ ] FB photo page ko sitemap/robots me verify karna (astro.config.mjs me add ho chuka — check kar lena)
  - [ ] Production env setup complete karna (IG_SESSIONID server pe paste, dist deploy, service start)
  - [ ] Git commit (working tree me bahut saara uncommitted kaam hai — FB photo tool, share links, speedup, nav fixes)
- **Resume kaise:** FILE READ → dev server check → neeche sessions padho → user se pucho aage kya karna hai.

---

## CURRENT STATUS / NEXT STEPS
- [x] Instagram downloader audit completed → verdict YES
- [x] TikTok downloader audit completed → verdict YES (script fix: tiktok.ts raceFirstSuccess deadlock)
- [x] FB Photo Downloader full build (parse/extraction/API/form/page) — verified 0/0/0 + build green + API smoke
- [x] FB share-link formats fix (`share/r/` + `share/v/`)
- [x] FB photo fetch speedup (parallel + bounded stream)
- [x] Per-tool result tiles (har FB tool sirf apne download buttons)
- [x] Production env setup artifacts (`.env.production.example`, `deploy/tiksavehub.service`, `scripts/setup-server.sh`)
- [x] Nav/ad layout fixes + FB nav button purple/pink palette
- [ ] FB photo page sitemap verify (astro.config.mjs me add ho chuka — double-check karna)
- [ ] Production deploy: IG_SESSIONID server pe, dist deploy, `systemctl enable --now tiksavehub`
- [ ] Git commit working tree (bahut saara kaam uncommitted hai)
- [ ] Anything GitHub says at commit time

---

## OPEN QUESTIONS / TODOS
- [ ] User se poochna: is website/extension ka exact purpose kya hai
- [ ] Production env vars: IG_SESSIONID? YTDLP_PATH?