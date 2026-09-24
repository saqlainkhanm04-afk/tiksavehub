/**
 * Platform modules — barrel export.
 *
 * Each platform module exports:
 *  - source factory functions (return ApiSource<string, MediaMeta>[])
 *  - individual named sources for direct use
 *
 * Usage:
 *   import { runWithFallback } from '../api-fallback';
 *   import { tiktokSources } from './platforms/tiktok';
 *   const result = await runWithFallback(url, tiktokSources(turnstileToken));
 *   // result.data is MediaMeta
 */

// Types
export type { MediaMeta } from './types';

// TikTok
export { tiktokSources, tikwmSource, cobaltSource as tiktokCobaltSource, tiktokItemDetailSource, tiktokDirectSource, tiktokDownbloderSource, tiktokCdnDirectSource } from './tiktok';

// Instagram
export { instagramSources, igMultiApiSource, igGraphqlSource, igEmbedSource, igLegacySource } from './instagram';

// Facebook
export { facebookSources, fbMultiApiSource, fbPageSource, fbEmbedSource, fbCobaltSource, fbCdnRegexSource } from './facebook';

// Twitter/X
export { twitterSources, xTweetPageSource, xEmbedSource } from './twitter';

// Snapchat
export { snapchatSources, scPageDataSource, scCobaltSource, scPageHtmlSource } from './snapchat';
