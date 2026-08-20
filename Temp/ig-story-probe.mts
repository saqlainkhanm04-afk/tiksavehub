import { fetchStoryByMediaId } from '../src/lib/instagram.ts';

try {
  const media = await fetchStoryByMediaId('1234567890123456789', 'instagram');
  console.log('MEDIA OK:', JSON.stringify(media).slice(0, 500));
} catch (err: any) {
  console.log('ERROR:', err?.message || String(err));
}
