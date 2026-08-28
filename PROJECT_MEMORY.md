# PROJECT_MEMORY.md — tiksavehub

> This file is the single source of truth for project context across all sessions.
> Read this FIRST at the start of every session. Update "Current Status" after every major fix/feature.

---

## 1. Project Identity

- **Name:** tiksavehub
- **Type:** Multi-platform Social Media Downloader (TikTok, Instagram, Facebook, X/Twitter, Snapchat)
- **Tech Stack:**
  - **Framework:** Astro 7 (SSR + static hybrid)
  - **Language:** TypeScript (strict)
  - **Styling:** TailwindCSS v4
  - **Adapter:** `@astrojs/cloudflare` (Edge runtime)
  - **Forms:** Vanilla JS in `.astro` `<script>` tags (no React)
- **Repo:** `https://github.com/saqlainkhanm04-afk/tiksavehub.git`

---

## 2. Strict Environment Constraints (CRITICAL)

| Constraint | Detail |
|---|---|
| **Hosting** | 100% FREE on Cloudflare Workers / Pages |
| **Runtime** | Cloudflare Edge (V8 isolates) |
| **NO Node.js modules** | No `node:fs`, `node:child_process`, `node:http`, `node:path`, `node:crypto` |
| **NO binaries** | No `ffmpeg`, no `yt-dlp`, no `python` |
| **NO VPS** | No Linux server, no SSH, no systemctl |
| **Deployment** | Local `npx wrangler deploy` OR GitHub auto-deploy to Cloudflare |
| **All `fetch()` calls** | Must use standard Web API `fetch()` — Edge compatible |
| **Caching** | Cloudflare KV (`SESSION` binding) + in-memory `memoSWR` |
| **Environment vars** | Set via Cloudflare Dashboard (Workers → Settings → Variables) |

**If any code uses forbidden modules, it WILL crash on Cloudflare Workers. Always verify Edge compatibility.**

---

## 3. Project Structure

```
src/
├── pages/
│   ├── api/
│   │   ├── download.ts          # TikTok video download
│   │   ├── download-mp3.ts      # TikTok audio/MP3 download
│   │   ├── instagram-download.ts # Instagram video/reels/stories
│   │   ├── facebook.ts          # Facebook video/story/photo download
│   │   └── x-download.ts        # X/Twitter video + audio download
│   ├── tiktok-video-downloader-without-watermark/
│   ├── tiktok-to-mp3/
│   ├── instagram-video-downloader-without-watermark/
│   ├── instagram-reels-downloader-without-watermark/
│   ├── instagram-story-downloader-without-watermark/
│   ├── instagram-audio-downloader/
│   ├── facebook-video-downloader/
│   ├── facebook-reels-downloader/     # Main FB brand tab
│   ├── facebook-story-downloader/
│   ├── facebook-photo-downloader/
│   ├── facebook-to-mp3/
│   ├── x-video-downloader/
│   ├── snapchat-downloader/
│   ├── snapchat-story-downloader/
│   ├── snapchat-to-mp3/
│   ├── blog/
│   ├── contact/
│   ├── privacy/
│   ├── terms/
│   └── dmca/
├── components/
│   ├── DownloadForm.astro       # TikTok form
│   ├── FacebookDownloadForm.astro
│   ├── InstagramDownloadForm.astro
│   ├── XDownloadForm.astro
│   ├── SnapchatDownloadForm.astro
│   ├── NavBar.astro
│   ├── Footer.astro
│   └── Layout.astro
├── lib/
│   ├── tiktok.ts                # TikTok extraction (page scrape, TikWM, cobalt)
│   ├── facebook.ts              # Facebook extraction (page, embed, reader proxy)
│   ├── facebook-url.ts          # FB URL parsing
│   ├── facebook-photo-quality.ts # Photo quality enforcement (LOCKED — do not weaken)
│   ├── instagram.ts             # Instagram extraction (session-based stories)
│   ├── x.ts                     # X/Twitter tweet page + embed extraction
│   ├── x-url.ts                 # X/Twitter URL parsing
│   ├── cobalt.ts                # Cobalt API wrapper (audio + video extraction)
│   ├── audio.ts                 # Audio helpers (delegates to cobalt)
│   ├── stream.ts                # Upstream CDN streaming (sequential + parallel chunks)
│   ├── cache.ts                 # In-memory memo/SWR cache
│   ├── media-cache.ts           # KV-backed media cache
│   ├── rate-limit.ts            # Per-IP rate limiter
│   ├── normalize.ts             # URL normalization
│   ├── ig-env.ts                # Instagram env var initialization
│   ├── pageSections.ts          # Page section data
│   └── ytdlp.ts                 # yt-dlp STUB (throws — not available on Edge)
└── layouts/
    └── Layout.astro
```

---

## 4. Backend Strategy

### Extraction Pipeline (per platform)

| Platform | Primary Source | Fallbacks | Session Required? |
|---|---|---|---|
| **TikTok** | Page HTML scrape | TikWM API → cobalt | No |
| **Instagram Reels/Posts** | Embed/GraphQL (anonymous) | yt-dlp | No |
| **Instagram Stories** | Session-based API (`IG_COOKIES`) | None | YES (full cookie jar) |
| **Facebook Video** | Page HTML + embed plugin (parallel) | cobalt video → CDN regex extraction | No |
| **Facebook Photos** | Page HTML → reader proxy (`r.jina.ai`) → per-photo `photo.php` | None | No |
| **Facebook Stories** | Story page variants → yt-dlp | reader proxy | Sometimes |
| **X/Twitter** | Tweet page HTML + embed plugin | cobalt (for audio) | No |
| **Snapchat** | Snap page scrape | cobalt | No |

### Audio/MP3 Strategy
- **TikTok MP3:** `music.play` URL from TikTok meta → stream directly
- **Facebook MP3:** cobalt API audio extraction
- **X/Twitter MP3:** cobalt API audio extraction
- **cobalt auth flow:** Client solves Cloudflare Turnstile → token sent to server → server exchanges for JWT Bearer → uses JWT for cobalt API
- **cobalt response handling:** Must handle `tunnel`, `redirect`, `local-processing` (tunnel[]), and `picker` (picker[]) status types

### Key Design Patterns
- **Parallel source racing:** Page fetch starts immediately; embed/yt-dlp start after 2s delay if page is slow; first usable result wins
- **MemoSWR caching:** 6h TTL, 6h stale — prevents hammering upstream APIs
- **Bounded reads:** `readBoundedText` caps HTML reads at 2.5MB to avoid downloading full multi-MB shells on flagged IPs
- **Reader proxy fallback:** `r.jina.ai/{url}` for flagged IPs that get login shells from Facebook/Instagram

---

## 5. Critical Invariants (DO NOT BREAK)

### Facebook Photo Quality Lock (`facebook-photo-quality.ts`)
- **Rule:** `enforcePhotoQuality()` is the LAST step of `fetchFacebookPhotoSet`
- Strips ALL `ctp=` size caps, drops sticker/emoji/avatar buckets, rejects thumb-only leftovers, dedupes by CDN path
- Regression test: `npm run test:fb-photo` (37 assertions) — **if test fails, fix pipeline, never the test**

### Instagram Session Engine
- Stories are 100% session-gated in 2026 — no anonymous endpoint exists
- `IG_COOKIES` must be the FULL cookie jar (device-bound, mobile Chrome fingerprint)
- `MOBILE_WEB_UA` = Pixel 7 / Android 13 / Chrome 151 — exact fingerprint required
- `apiGet` switches headers: session present → www host + mobile Chrome; anonymous → i.instagram.com + app UA

### Cloudflare Edge Compatibility
- `ytdlp.ts` is a STUB — always throws, never executes binary
- `audio.ts` delegates to cobalt — no ffmpeg
- All `fetch()` calls use standard Web API only

---

## 6. Current Status

### Last Updated: 2026-08-28 (Session: FB multi-layer fallback + X MP3 fix + FB private/deleted fix)

### Recently Completed
- **Facebook multi-layer fallback system** — 4-layer extraction pipeline: (1) page HTML + embed plugin parallel, (2) cobalt.tools video extraction, (3) direct CDN regex extraction from page HTML, (4) graceful error with descriptive message. Each layer has try/catch self-healing. Error messages now distinguish private/restricted videos from rate-limited requests.
- **X/Twitter MP3 fix** — audio extraction was blocked by video URL validation; cobalt response handling updated for v11 (local-processing/picker types); error logging added
- **Facebook "private or deleted" fix** — pageTask no longer re-throws NOT_AVAILABLE/LOGIN_REQUIRED; embed/yt-dlp fallbacks now run even when page says "content isn't available"; page rejection checks embed result before throwing
- **FB photo quality ctp-cap unlock** — permanent quality enforcement via locked module
- **IG story session engine** — full cookie jar + mobile Chrome fingerprint for device-bound sessions
- **FB story login-wall honesty** — honest error messages for private/restricted accounts
- **FB video pipeline parallelization** — page + embed run in parallel (10.6s → 8.2s on flagged IP)
- **FB photo reader proxy** — `r.jina.ai` recovery for flagged IPs
- **TikTok item-detail quality probe** — higher quality via TikTok's own API
- **Cross-site cover audit** — all tools return cover/thumbnail URLs

### Known Limitations (Documented, No Fix Planned)
- Dev machine IP gets FB "Error" shell (mobile) — production IPs work fine
- IG stories require session cookies — no anonymous endpoint exists
- cobalt API (`api.cobalt.tools`) requires auth — turnstile or API key
- Facebook cover often empty on flagged embed path — no source exposes thumbnail

### Next Focus Areas
- On-page SEO improvements
- Micro-tool expansions
- Minor edge case fixes
- UI polish

---

## 7. Standard Operating Procedure (SOP)

1. **ALWAYS read this file first** at the start of every session
2. **NEVER give Linux/VPS/SSH/systemctl commands** — deployment is `npx wrangler deploy` or GitHub auto-deploy
3. **NEVER use `node:fs`, `child_process`, or binary-dependent code** — Edge-only
4. **After every major fix/feature**, update the "Current Status" section in this file
5. **Run `astro check`** after every change — must be 0 new errors (pre-existing Layout.astro + tiktok.ts errors are ignored)
6. **Test artifacts go to temp dir** (`C:\Users\ARTHUR~1\AppData\Local\Temp\opencode\`) — never inside workspace
7. **Photo quality lock** — never weaken `facebook-photo-quality.ts` invariants
8. **Always use skills:** `atro`, `tailwind-4-docs`, `web-design-guidelines`

---

## 8. Git Conventions

- **Branch:** `main` (single branch)
- **Commit messages:** `<type>: <description>` (e.g. `fix:`, `feat:`, `chore:`)
- **Deploy:** Push to `main` → auto-deploys to Cloudflare (or manual `wrangler deploy`)
- **Pre-commit:** `astro check` must pass (0 new errors)

---

## 9. Environment Variables (Key Ones)

| Variable | Purpose | Required? |
|---|---|---|
| `COBALT_API_KEY` | Cobalt API auth (alternative to turnstile) | Optional |
| `COBALT_API_URL` | Cobalt instance URL (default: api.cobalt.tools) | Optional |
| `IG_COOKIES` | Full Instagram cookie jar for stories | Required for IG stories |
| `IG_SESSIONID` | Instagram session ID (legacy, prefer IG_COOKIES) | For IG stories |
| `IG_DS_USER_ID` | Instagram user ID | For IG stories |
| `IG_CSRF_TOKEN` | Instagram CSRF token | For IG stories |
| `CACHE_FILE` | Path for media cache (production only) | Optional |
| `RATE_LIMIT_WINDOW` | Rate limiter window in ms | Optional |
| `RATE_LIMIT_MAX` | Max requests per window | Optional |

---

## 10. Testing

| Command | What it tests |
|---|---|
| `astro check` | TypeScript + Astro diagnostics (0 new errors) |
| `npm run build` | Full production build (must succeed) |
| `npm run test:fb-photo` | Facebook photo quality lock (37 assertions) |
| Live API smoke | POST/GET to API endpoints on dev IP |

---

*This file was created on 2026-08-28. Update it after every significant session.*
