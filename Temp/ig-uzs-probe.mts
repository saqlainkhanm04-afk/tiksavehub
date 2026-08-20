import { resolveUserIdByUsername, fetchStoryTray, findStoryInTray } from '../src/lib/instagram.ts';

const username = 'uzs_tm';
const mediaId = '3967014837124863130';
try {
  const uid = await resolveUserIdByUsername(username);
  console.log(`uid(${username}) = ${uid} | media=${mediaId}`);
  const tray = await fetchStoryTray(uid);
  console.log(`tray length = ${tray.length}`);
  console.log('tray media_ids =', tray.map((t: any) => t.media_id || t.pk || t.id));
  const found = findStoryInTray(tray, mediaId);
  console.log('found =', found ? JSON.stringify(found, null, 0).slice(0, 200) : 'NOT FOUND');
  if (tray.length === 0) console.log('EMPTY TRAY — falling back (media/info + yt-dlp would both fail)');
} catch (err: any) {
  console.log('flow error:', err?.message, '| code:', err?.code || '');
}