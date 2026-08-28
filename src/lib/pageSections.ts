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

export function isToolPage(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return TOOL_PAGES.some((page) => path === page);
}

export function sectionHref(pathname: string, anchor: string): string {
  return isToolPage(pathname) ? `#${anchor}` : `${DEFAULT_TOOL_PAGE}#${anchor}`;
}