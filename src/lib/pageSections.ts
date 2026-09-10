// Pages that render the download form + section anchors (#download-form,
// #how-it-works, #features, #faq). Other routes fall back to the primary
// downloader page so nav/footer section links never point at a missing id.
export const TOOL_PAGES = [
  '/tiktok-video-downloader-without-watermark',
  '/tiktok-to-mp3',
  '/instagram-video-downloader-without-watermark',
  '/instagram-reels-downloader-without-watermark',
  '/instagram-story-downloader-without-watermark',
  '/instagram-audio-downloader',
  '/facebook-video-downloader',
  '/facebook-reels-downloader',
  '/facebook-to-mp3',
  '/facebook-story-downloader',
  '/facebook-photo-downloader',
  '/x-video-downloader',
  '/snapchat-downloader',
  '/snapchat-story-downloader',
  '/snapchat-to-mp3',
];

export const DEFAULT_TOOL_PAGE = '/tiktok-video-downloader-without-watermark';

const LANG_PREFIXES = ['', '/es', '/ja', '/fr', '/de', '/pt', '/ko', '/it'];

export function isToolPage(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return LANG_PREFIXES.some((lang) =>
    TOOL_PAGES.some((page) => path === `${lang}${page}`)
  );
}

export function sectionHref(pathname: string, anchor: string): string {
  if (isToolPage(pathname)) return `#${anchor}`;
  const langMatch = pathname.match(/^\/(es|ja|fr|de|pt|ko|it)(\/|$)/);
  const langPrefix = langMatch ? `/${langMatch[1]}` : '';
  return `${langPrefix}${DEFAULT_TOOL_PAGE}#${anchor}`;
}