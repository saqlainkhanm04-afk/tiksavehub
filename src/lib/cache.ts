type Entry<T> = { value: T; expiresAt: number };

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

const MAX_ENTRIES = 3000;
const CLEANUP_INTERVAL_MS = 60_000;

let lastCleanup = Date.now();

function cleanup(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  if (store.size > MAX_ENTRIES) {
    const entries = [...store.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    store.clear();
    for (const [key, entry] of entries.slice(-Math.floor(MAX_ENTRIES * 0.8))) {
      store.set(key, entry);
    }
    return;
  }

  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (store.size > MAX_ENTRIES) cleanup();
}

export async function memo<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== undefined) return cached;

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = loader()
    .then((value) => {
      cacheSet(key, value, ttlMs);
      inflight.delete(key);
      return value;
    })
    .catch((error) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, promise);
  return promise;
}

export async function memoSWR<T>(
  key: string,
  ttlMs: number,
  staleMs: number,
  loader: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const entry = store.get(key) as Entry<T> | undefined;

  if (entry && entry.expiresAt <= now + staleMs) {
    if (entry.expiresAt > now) return entry.value;

    if (!inflight.has(key)) {
      const promise = loader()
        .then((value) => {
          cacheSet(key, value, ttlMs);
          inflight.delete(key);
          return value;
        })
        .catch(() => {
          inflight.delete(key);
        });
      inflight.set(key, promise);
    }
    return entry.value;
  }

  return memo(key, ttlMs, loader);
}
