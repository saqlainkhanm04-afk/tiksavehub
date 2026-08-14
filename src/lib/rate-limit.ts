const WINDOW_MS = 60_000;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);

let lastCleanup = Date.now();

export function clientIpFrom(request: Request): string {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (ip) return ip;
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

export function isRateLimited(ip: string, limitPerMin: number = RATE_LIMIT_PER_MIN): boolean {
  if (limitPerMin <= 0) return false;

  const now = Date.now();
  if (now - lastCleanup > WINDOW_MS) {
    cleanup();
    lastCleanup = now;
  }

  const hits = (rateMap.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= limitPerMin) {
    rateMap.set(ip, hits);
    return true;
  }

  hits.push(now);
  rateMap.set(ip, hits);
  return false;
}

const rateMap = new Map<string, number[]>();

function cleanup(): void {
  const now = Date.now();
  for (const [key, times] of rateMap) {
    const kept = times.filter((t) => now - t < WINDOW_MS);
    if (kept.length === 0) rateMap.delete(key);
    else rateMap.set(key, kept);
  }
}