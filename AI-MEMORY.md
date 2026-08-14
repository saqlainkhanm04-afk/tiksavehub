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

## LAST SAVE / PAUSE POINT (2026-08-11)

> **IS WAHIN PAR RUKA — yahan se resume karna hai.**
> READ ye section, phir neeche WORK SESSIONS, phir kaam shuru.

- **Kya hua:** Instagram aur TikTok dono downloader audits complete; verdict = **YES / production-ready**.
- **Bug fix (committed in code, NOT git):** `src/lib/tiktok.ts` `raceFirstSuccess` deadlock fixed (pending===0 check) — invalid TikTok IDs ab hang nahi hote (pehle forever hang karte the). `npx astro check` = 0 errors.
- **Dev server:** port 3000 par chal raha hai (node PID ~15088 family, restarted 12:55). Agar nahi hai to: `npm run dev`.
- **Subtle note:** `src/lib/tiktok.ts` ka change ka saved nahi hua git; agar git commit karna ho to baad me.
- **Aage ka kaam aur kya ho sakta hai:**
  - [ ] Other downloader/pages audit: tiktok-to-mp3, instagram-audio, instagram story/reels pages — sirf agar user bole.
  - [ ] IG_SESSIONID / production env setup
  - [ ] Git commit (optionally) — repo me abhi bhi "No commits yet".
- **Resume kaise:** FILE READ → dev server check → neeche sessions padho → user se pucho aage kya karna hai.

---

## CURRENT STATUS / NEXT STEPS
- [x] Instagram downloader audit completed → verdict YES
- [x] TikTok downloader audit completed → verdict YES (script fix: tiktok.ts raceFirstSuccess deadlock)
- [ ] Other downloader flows audit (tikwm/tiktok API, mp3 flow) — only if user asks
- [ ] Consider IG_SESSIONID setup for production
- [ ] Resolve anything GitHub says at commit time

---

## OPEN QUESTIONS / TODOS
- [ ] User se poochna: is website/extension ka exact purpose kya hai
- [ ] Production env vars: IG_SESSIONID? YTDLP_PATH?