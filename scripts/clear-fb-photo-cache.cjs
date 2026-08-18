const fs = require('fs');
const path = 'data/cache/media-cache.json';
let raw = fs.readFileSync(path, 'utf8');
if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
const db = JSON.parse(raw);
let removed = 0;
for (const k of Object.keys(db)) {
  if (k.startsWith('media:fb:photo')) { delete db[k]; removed++; }
}
fs.writeFileSync(path, JSON.stringify(db, null, 2));
console.log('removed keys:', removed);
