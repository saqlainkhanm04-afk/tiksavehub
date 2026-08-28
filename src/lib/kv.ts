/**
 * KV adapter — uses Cloudflare KV bindings when available,
 * falls back to in-memory Map for local dev.
 *
 * In CF Workers, KV operations are async. The API is intentionally
 * identical to the old kv.ts so callers need minimal changes.
 */

export interface KvEntry<T> {
  value: T;
  exp: number;
}

let kvNamespace: KVNamespace | null = null;
const memStore = new Map<string, KvEntry<unknown>>();

/** Initialize with a KV binding (called once per request in CF Workers). */
export function kvInit(kv?: KVNamespace | null): void {
  kvNamespace = kv ?? null;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  if (kvNamespace) {
    const raw = await kvNamespace.get(key, 'json');
    if (!raw) return undefined;
    const entry = raw as KvEntry<T>;
    if (entry.exp <= Date.now()) {
      await kvNamespace.delete(key);
      return undefined;
    }
    return entry.value;
  }
  // In-memory fallback (dev)
  const entry = memStore.get(key) as KvEntry<T> | undefined;
  if (!entry) return undefined;
  if (entry.exp <= Date.now()) {
    memStore.delete(key);
    return undefined;
  }
  return entry.value;
}

export async function kvGetRaw<T>(key: string): Promise<KvEntry<T> | undefined> {
  if (kvNamespace) {
    const raw = await kvNamespace.get(key, 'json');
    if (!raw) return undefined;
    return raw as KvEntry<T>;
  }
  return memStore.get(key) as KvEntry<T> | undefined;
}

export async function kvSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  const entry: KvEntry<T> = { value, exp: Date.now() + ttlMs };
  if (kvNamespace) {
    const expirationTtl = Math.max(60, Math.floor(ttlMs / 1000));
    await kvNamespace.put(key, JSON.stringify(entry), { expirationTtl });
  } else {
    memStore.set(key, entry);
  }
}

export async function kvHas(key: string): Promise<boolean> {
  const v = await kvGet(key);
  return v !== undefined;
}

export async function kvDel(key: string): Promise<void> {
  if (kvNamespace) {
    await kvNamespace.delete(key);
  } else {
    memStore.delete(key);
  }
}

export async function kvSize(): Promise<number> {
  if (kvNamespace) {
    // KV doesn't support listing count efficiently; return 0
    return 0;
  }
  const now = Date.now();
  for (const [key, entry] of memStore) {
    if (entry.exp <= now) memStore.delete(key);
  }
  return memStore.size;
}

export function kvRemoteCount(): number {
  return memStore.size;
}

export async function kvMemo<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<T> {
  const cached = await kvGet<T>(key);
  if (cached !== undefined) return cached;

  const value = await loader();
  await kvSet(key, value, ttlMs);
  return value;
}
