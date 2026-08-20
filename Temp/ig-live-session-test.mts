const { fetchStoryByMediaId, getBestVideoUrl, getThumbnailUrl, isImageOnlyMedia } = await import('../src/lib/instagram.ts');

const cases: Array<[string, string, string]> = [
  ['bilal_khalidofficial', '3967329176939992715', 'story (video, from tray)'],
  ['bilal_khalidofficial', '0000000000000000000', 'story (nonexistent id)'],
];
let pass = 0, fail = 0;
for (const [username, mediaId, label] of cases) {
  try {
    const started = Date.now();
    const media = await fetchStoryByMediaId(mediaId, username);
    const video = getBestVideoUrl(media);
    const thumb = getThumbnailUrl(media);
    const imageOnly = isImageOnlyMedia(media);
    console.log(`PASS [${label}] ${(Date.now() - started)}ms | type=${imageOnly ? 'IMAGE' : 'VIDEO'} | video=${video ? video.slice(0, 90) : 'null'} | thumb=${thumb ? thumb.slice(0, 90) : 'null'}`);
    pass++;
  } catch (err: any) {
    fail++;
    console.log(`FAIL [${label}] ${err?.message} | code=${err?.code || ''}`);
  }
}
console.log(`\nRESULT: ${pass}/${pass + fail} PASS`);