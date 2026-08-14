
Always Use:
atro, tailwind-4-docs, web-design-guidelines these 3 skills for this project
DESIGN.md for this project design

## WIP Status (last session: Facebook Video & Reels Downloader — embed path enriched, DONE)

Completed & verified:
- Full Facebook downloader module built: `src/lib/facebook-url.ts`, `src/lib/facebook.ts`, `src/lib/ytdlp.ts` (facebook helpers), `src/pages/api/facebook.ts` (POST metadata + GET dl=hd|sd|audio with ffmpeg MP3), `src/components/FacebookDownloadForm.astro`, `src/pages/facebook-video-downloader.astro` (SEO landing + JSON-LD).
- Wired into `astro.config.mjs` (sitemap), `NavBar.astro`, `Footer.astro`, `Layout.astro`, `src/lib/pageSections.ts`.
- `astro check`: 0 errors/hints. `npm run build`: green. Live API smoke tests pass.

Key implementation facts (IMPORTANT for future work):
- Extraction order: page JSON (`playable_url_quality_hd`/`playable_url`) → embed plugin page `"videoData"[{hd_src,sd_src}]` (works even on FB login-wall/IP-flagged shells; direct progressive MP4s) → yt-dlp fallback.
- Duration on embed path decoded from base64url `efg` payload in CDN stream URLs (`durationFromEmbedConfig`, regex `&efg=([A-Za-z0-9_-]+)`, padded `atob` decode, `duration_s` field).
- CDN streams need `Referer: https://www.facebook.com/` to download (verified 200, video/mp4).
- Test video used everywhere: `https://www.facebook.com/facebook/videos/10153231379946729/` (dur 74s).
- Dev machine IP gets FB "Error" shell (HTTP 400, ~3.6KB) on **mobile** page fetch, but the **desktop** page fetch returns the FULL page (status 200, ~950KB) with real `<title>`/`og:title`/`meta description` — yet NO `preferred_thumbnail`, NO `og:image`, NO `playable_url*` keys on this IP. Production IPs get the full JSON via the mobile page (title/cover/counts via `preferred_thumbnail`).
- Embed plugin page (previous session): title/author now extracted from its markup — anchor `watch/?ref=embed_video">TITLE</a>` and `/watch/{page}/?ref=embed_video` link text; page/author avatar at s40x40 is size-bumped via `s40x40→s320x320` in the CDN `stp` param.
- `graph.facebook.com/v26.0/oembed_video?url=` works WITHOUT auth on public videos (returns title/author/date in the `html` field; NO thumbnail). Not currently used in code.
- Public metadata probe `fetchDesktopPageMeta(url)` in `facebook.ts` runs in parallel with `fetchEmbed` and fills `cover` (via `preferred_thumbnail`) + page name when the desktop page is served even though the mobile page shelled. Never throws.

Known limitation (documented, no action planned):
- On the embed fallback path with a fully flagged IP (like this dev machine), `cover` is still empty — no source exposes an og:image/thumbnail for such IPs (desktop page has no preferred_thumbnail; oEmbed has no thumbnail; the ambiguous `t15.5256-10` preloads are related-reels images and are deliberately NOT used). Result card now shows a graceful icon placeholder instead of a broken `<img>` when cover is empty.
