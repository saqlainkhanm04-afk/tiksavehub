import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let loaded = false;

function findEnvFile(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 7; i++) {
    const candidate = path.join(dir, '.env');
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // continue walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The Node runtime does NOT auto-load `.env` files: Astro/Vite only injects them
 * into import.meta.env, and the SSR handler reads process.env. Worse, a Vite
 * dev restart (e.g. after editing .env) spawns a fresh process that loses any
 * shell-injected env vars. This loader reads the project `.env` directly into
 * process.env (IG_* keys only, without overriding real process variables) so
 * the session is available to the server code in every dev/restart scenario.
 * Production (systemd EnvironmentFile) supplies true env vars, so this is a
 * dev-only safety net.
 */
export function ensureInstagramEnv(): void {
  if (loaded) return;
  loaded = true;
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const envPath = findEnvFile(here);
    if (!envPath) return;
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || !m[1].startsWith('IG_')) continue;
      const key = m[1];
      if (process.env[key] !== undefined && process.env[key] !== '') continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    // Initia trigger for modules that read vars lazily via memoised helpers.
  } catch {
    // not a dev environment or unreadable .env — process env is authoritative.
  }
}