/**
 * yt-dlp wrapper — stubbed out.
 * Audio/video extraction now uses cobalt.tools API (see cobalt.ts).
 * This file exists only to prevent import errors from any lingering references.
 */

export async function isYtDlpAvailable(): Promise<boolean> {
  return false;
}

export async function fetchFacebookWithYtDlp(_url: string): Promise<any> {
  throw new Error('yt-dlp is not available. Use cobalt.ts for extraction.');
}

export async function extractAudioWithYtDlp(_url: string): Promise<{ url: string; ext: string } | null> {
  return null;
}
