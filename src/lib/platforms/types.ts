/**
 * Unified MediaMeta — the single output shape every platform normalizer targets.
 * Frontend and API routes consume this interface regardless of source platform.
 */
export interface MediaMeta {
  /** Platform identifier */
  platform: 'tiktok' | 'instagram' | 'facebook' | 'twitter' | 'snapchat';
  /** Content type */
  type: 'video' | 'reels' | 'story' | 'photo' | 'audio' | 'gif';
  /** Direct HD video URL (progressive MP4 when available) */
  hdUrl: string | null;
  /** Direct SD video URL */
  sdUrl: string | null;
  /** Watermarked / lower-quality video URL (kept as last-resort fallback) */
  wmUrl: string | null;
  /** Audio-only stream URL (for platforms that expose separate audio) */
  audioUrl: string | null;
  /** Thumbnail / cover image URL */
  cover: string | null;
  /** Video or post title / caption */
  title: string;
  /** Duration in seconds (0 if unknown) */
  duration: number;
  /** Author display name */
  authorName: string;
  /** Author profile image URL */
  authorAvatar: string | null;
  /** Author username / handle */
  authorUsername: string | null;
  /** Engagement counters (null when unavailable) */
  stats: {
    likes: number | null;
    comments: number | null;
    shares: number | null;
    views: number | null;
  };
  /** Original platform URL passed by the user */
  sourceUrl: string;
  /** Which API source ultimately produced this result (for logging) */
  resolvedBy: string;
  /** Total wall-clock ms spent across all attempted sources */
  resolvedMs: number;
}
