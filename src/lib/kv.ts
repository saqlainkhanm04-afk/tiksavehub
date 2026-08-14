import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface KvEntry<T> {
  value: T;
  exp: number;
}

const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 2000);
const SNAPSHOT_INTERVAL_MS = 60_000;
const FLUSH_INTERVAL_MS = 5_000;

const store = new Map<string, KvEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

let cacheFile = process.env.CACHE_FILE;
let lastFlush = Date.now();
let scheduled = false;
let snapTimer: NodeJS.Timeout | null = null;

function defaultCacheFile(): string {
  return join(process.cwd(), 'data', 'cache', 'media-cache.json');
}

function ensureFile(): string {
  if (!cacheFile) cacheFile = defaultCacheFile();
  return cacheFile;
}

function makeSnapshot(): void {
  const now = Date.now();
  if (now - lastFlush < FLUSH_INTERVAL_MS) return;
  lastFlush = now;
  try {
    const file = ensureFile();
    mkdirSync(dirname(file), { recursive: true });
    const payload: Record<string, KvEntry<unknown>> = {};
    for (const [key, entry] of store) {
      if (entry.exp > now) payload[key] = entry;
      else store.delete(key);
    }
    writeFileSync(file, JSON.stringify(payload), 'utf8');
  } catch (err) {
    console.error('[KV] snapshot failed:', (err as Error)?.message ?? err);
  }
}

function loadSnapshot(): void {
  if (store.size > 0) return;
  const file = ensureFile();
  if (!existsSync(file)) return;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, KvEntry<unknown>>;
    if (typeof parsed !== 'object' || parsed === null) return;
    for (const [key, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.exp === 'number' && entry.exp > Date.now()) {
        store.set(key, entry);
      }
    }
  } catch (err) {
    console.error('[KV] Could not load KV snapshot:', (err as Error)?.message ?? err);
  }
}

function scheduleFlush(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    if (store.size > 0) makeSnapshot();
  }, FLUSH_INTERVAL_MS);
}

export function kvGet<T>(key: string): T | undefined {
  const entry = store.get(key) as KvEntry<T> | undefined;
  if (!entry) return undefined;
  if (entry.exp <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function kvGetRaw<T>(key: string): KvEntry<T> | undefined {
  const entry = store.get(key) as KvEntry<T> | undefined;
  if (!entry) return undefined;
  if (entry.exp <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

export function kvSet<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, exp: Date.now() + ttlMs });
  if (store.size > MAX_ENTRIES) evictOldest();
  scheduleFlush();
}

export function kvHas(key: string): boolean {
  return kvGet(key) !== undefined;
}

export function kvDel(key: string): void {
  store.delete(key);
  scheduleFlush();
}

export function kvSize(): number {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.exp <= now) store.delete(key);
  }
  return store.size;
}

export function kvRemoteCount(): number {
  return store.size;
}

function evictOldest(): void {
  let entries = [...store.entries()].sort((a, b) => a[1].exp - b[1].exp);
  const limit = Math.max(100, Math.floor(MAX_ENTRIES * 0.8));
  while (entries.length > limit) {
    const [key] = entries[0];
    store.delete(key);
    entries = entries.slice(1);
  }
}

export async function kvMemo<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<T> {
  const cached = kvGet<T>(key);
  if (cached !== undefined) return cached;

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = loader()
    .then((value) => {
      kvSet(key, value, ttlMs);
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

export function kvStart(): void {
  loadSnapshot();
  if (snapTimer) return;
  snapTimer = setInterval(() => makeSnapshot(), SNAPSHOT_INTERVAL_MS);
  snapTimer.unref?.();
}

if (typeof process !== 'undefined') {
  process.on('exit', () => makeSnapshot());
  process.on('SIGTERM', () => {
    makeSnapshot();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    makeSnapshot();
    process.exit(0);
  });
}