/**
 * Instagram Cookie Health Checker
 *
 * Runs a lightweight periodic test against Instagram's API to verify each
 * cookie is still valid.  Tracks "last verified" timestamps in a JSON file
 * and sends Telegram alerts when:
 *   - A cookie fails the health check (expired / banned)
 *   - A cookie hasn't been verified in N days (approaching expiration)
 *
 * Env vars:
 *   COOKIE_HEALTH_CHECK_INTERVAL_MS  — how often to check (default 6h)
 *   COOKIE_WARN_DAYS                 — days since last OK to warn (default 75)
 *   COOKIE_CRITICAL_DAYS             — days since last OK to go critical (default 85)
 *   COOKIE_HEALTH_FILE               — path to the health state file
 *
 * Safe to import anywhere — the checker only starts when `startCookieHealthChecker()`
 * is called (typically from the server entrypoint).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { sendEmail, notificationsEnabled } from './notify';
import { ensureInstagramEnv } from './ig-env';

ensureInstagramEnv();

// ── Config ────────────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = Number(process.env.COOKIE_HEALTH_CHECK_INTERVAL_MS) || 6 * 60 * 60 * 1000; // 6h
const DAILY_REPORT_MS = Number(process.env.COOKIE_DAILY_REPORT_INTERVAL_MS) || 24 * 60 * 60 * 1000; // 24h
const WARN_DAYS = Number(process.env.COOKIE_WARN_DAYS) || 75;
const CRITICAL_DAYS = Number(process.env.COOKIE_CRITICAL_DAYS) || 85;

function healthFile(): string {
  return process.env.COOKIE_HEALTH_FILE || '';
}

// ── State file ────────────────────────────────────────────────────────────────

interface HealthState {
  /** ISO timestamp of last successful verification per cookie label. */
  lastOk: Record<string, string>;
  /** ISO timestamp of last alert sent per cookie label (avoids spam). */
  lastAlert: Record<string, string>;
}

let state: HealthState = { lastOk: {}, lastAlert: {} };

function loadState(): void {
  const file = healthFile();
  if (!file) return;
  try {
    if (existsSync(file)) {
      state = JSON.parse(readFileSync(file, 'utf8')) || state;
    }
  } catch {
    // corrupted — start fresh
  }
}

function saveState(): void {
  const file = healthFile();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[ig-health] Could not save state:', (err as Error)?.message ?? err);
  }
}

// ── Cookie source ─────────────────────────────────────────────────────────────

interface CookieSource {
  label: string;
  cookie: string;
}

function getCookieSources(): CookieSource[] {
  const sources: CookieSource[] = [];

  for (const envKey of ['IG_COOKIE_1', 'IG_COOKIE_2', 'IG_COOKIE_3', 'IG_COOKIE_4'] as const) {
    const val = process.env[envKey]?.trim();
    if (val) sources.push({ label: envKey, cookie: val });
  }

  if (sources.length === 0) {
    const full = process.env.IG_COOKIES?.trim();
    if (full) {
      sources.push({ label: 'IG_COOKIES', cookie: full });
    } else {
      const parts: string[] = [];
      if (process.env.IG_SESSIONID?.trim()) parts.push(`sessionid=${process.env.IG_SESSIONID.trim()}`);
      if (process.env.IG_DS_USER_ID?.trim()) parts.push(`ds_user_id=${process.env.IG_DS_USER_ID.trim()}`);
      if (process.env.IG_CSRF_TOKEN?.trim()) parts.push(`csrftoken=${process.env.IG_CSRF_TOKEN.trim()}`);
      if (parts.length > 0) sources.push({ label: 'IG_SESSIONID', cookie: parts.join('; ') });
    }
  }

  return sources;
}

// ── Health check ──────────────────────────────────────────────────────────────

/**
 * Test a cookie by hitting Instagram's web_profile_info endpoint (lightweight,
 * works with any valid session). Returns true if the session is alive.
 */
async function testCookie(cookie: string): Promise<boolean> {
  try {
    const resp = await fetch('https://www.instagram.com/api/v1/accounts/current_user/', {
      method: 'GET',
      headers: {
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
        'X-IG-App-ID': '936619743392459',
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(15_000),
    });
    // 200 with "status":"ok" = alive; 401/403/expired = dead
    if (resp.status === 200) {
      const body = await resp.json().catch(() => null);
      return body?.status === 'ok';
    }
    return false;
  } catch {
    return false;
  }
}

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

async function runCheck(): Promise<void> {
  const sources = getCookieSources();
  if (sources.length === 0) return;

  const now = new Date().toISOString();
  let anyAlert = false;

  for (const src of sources) {
    const ok = await testCookie(src.cookie);

    if (ok) {
      state.lastOk[src.label] = now;
      saveState();
      continue;
    }

    // Cookie failed
    const lastOk = state.lastOk[src.label];
    const days = lastOk ? daysSince(lastOk) : 'unknown';

    console.warn(`[ig-health] Cookie "${src.label}" FAILED health check (last OK: ${days}d ago)`);

    // Avoid alert spam — max one alert per cookie per 12h
    const lastAlert = state.lastAlert[src.label];
    if (lastAlert && daysSince(lastAlert) < 1) continue;

    state.lastAlert[src.label] = now;
    saveState();

    const subject = `🔴 TikSaveHub: Instagram Cookie Expired — ${src.label}`;
    const html = [
      `<h2 style="color:#e11d48">Instagram Cookie Expired</h2>`,
      `<table style="border-collapse:collapse;font-family:sans-serif">`,
      `<tr><td style="padding:4px 12px 4px 0;font-weight:600">Cookie:</td><td><code>${src.label}</code></td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;font-weight:600">Status:</td><td>Failed health check</td></tr>`,
      lastOk ? `<tr><td style="padding:4px 12px 4px 0;font-weight:600">Last verified:</td><td>${days}d ago</td></tr>` : '',
      `</table>`,
      `<br>`,
      `<p style="color:#b91c1c;font-weight:600">⚠️ Stories and reels downloads will not work until refreshed.</p>`,
      `<p>To fix: log into Instagram → DevTools → Network → Copy as cURL → update the cookie in your server's <code>.env</code> file → restart server.</p>`,
    ].join('');

    await sendEmail(subject, html);
    anyAlert = true;
  }

  // Check for approaching expiration (only for cookies that are still OK)
  for (const src of sources) {
    const lastOk = state.lastOk[src.label];
    if (!lastOk) continue;

    const days = daysSince(lastOk);
    if (days < CRITICAL_DAYS) continue;

    // Already sent a failure alert above? Skip.
    if (state.lastAlert[src.label] && daysSince(state.lastAlert[src.label]) < 1) continue;

    state.lastAlert[src.label] = now;
    saveState();

    const subject = `🟡 TikSaveHub: Instagram Cookie Expiring Soon — ${src.label}`;
    const html = [
      `<h2 style="color:#d97706">Instagram Cookie Expiring Soon</h2>`,
      `<table style="border-collapse:collapse;font-family:sans-serif">`,
      `<tr><td style="padding:4px 12px 4px 0;font-weight:600">Cookie:</td><td><code>${src.label}</code></td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;font-weight:600">Last verified:</td><td>${days}d ago</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;font-weight:600">Critical at:</td><td>${CRITICAL_DAYS}d</td></tr>`,
      `</table>`,
      `<br>`,
      `<p style="color:#92400e;font-weight:600">⏰ Please refresh this cookie soon to avoid download interruptions.</p>`,
      `<p>To fix: log into Instagram → DevTools → Network → Copy as cURL → update the cookie in your server's <code>.env</code> file → restart server.</p>`,
    ].join('');

    await sendEmail(subject, html);
    anyAlert = true;
  }

  if (!anyAlert) {
    console.log(`[ig-health] All ${sources.length} cookie(s) OK`);
  }
}

// ── Daily report (runs every 24h, always sends email) ────────────────────────

function buildDailyReportHtml(): { subject: string; html: string } {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const sources = getCookieSources();
  const rows: string[] = [];
  let healthy = 0;
  let failed = 0;

  for (const src of sources) {
    const lastOk = state.lastOk[src.label];
    const days = lastOk ? daysSince(lastOk) : null;

    // Check if currently working (last OK < 24h = probably still good)
    const isHealthy = days !== null && days < CRITICAL_DAYS;
    if (isHealthy) healthy++; else failed++;

    const emoji = isHealthy ? '\u2705' : '\u274C';
    const statusColor = isHealthy ? '#16a34a' : '#dc2626';
    const lastVerified = days !== null ? days + 'd ago' : 'never';
    const warn = isHealthy && days !== null && days >= WARN_DAYS
      ? ' <span style="color:#d97706;font-weight:600">(refresh soon)</span>'
      : '';

    rows.push(
      '<tr>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600">' + src.label + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:' + statusColor + ';font-weight:600">' + emoji + ' ' + (isHealthy ? 'Healthy' : 'FAILED') + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">' + lastVerified + warn + '</td>' +
      '</tr>'
    );
  }

  saveState();

  const overallEmoji = failed > 0 ? '\uD83D\uDD34' : '\uD83D\uDFE2';
  const overallText = failed > 0 ? failed + ' cookie(s) need attention' : 'All cookies healthy';
  const tipRow = failed > 0
    ? '<p style="color:#b91c1c;font-weight:600">\u26A0\uFE0F Update the failed cookie(s) in .env and restart the server.</p>'
    : '<p style="color:#16a34a">\uD83D\uDE0E Everything looks good. No action needed.</p>';

  const subject = overallEmoji + ' TikSaveHub Daily Report \u2014 ' + (failed > 0 ? failed + ' cookie(s) failed' : 'All OK');

  const html = [
    '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">',
    '<h2 style="color:#1e293b;margin-bottom:4px">TikSaveHub \u2014 Cookie Health Report</h2>',
    '<p style="color:#64748b;margin-top:0">' + dateStr + ' at ' + timeStr + '</p>',
    '<div style="background:' + (failed > 0 ? '#fef2f2' : '#f0fdf4') + ';border:1px solid ' + (failed > 0 ? '#fecaca' : '#bbf7d0') + ';border-radius:8px;padding:12px 16px;margin-bottom:16px">',
    '<strong style="font-size:16px;color:' + (failed > 0 ? '#dc2626' : '#16a34a') + '">' + overallEmoji + ' ' + overallText + '</strong>',
    '</div>',
    '<table style="border-collapse:collapse;width:100%;font-family:sans-serif">',
    '<thead><tr style="background:#f8fafc">',
    '<th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Cookie</th>',
    '<th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Status</th>',
    '<th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0">Last Verified</th>',
    '</tr></thead>',
    '<tbody>' + rows.join('') + '</tbody>',
    '</table>',
    tipRow,
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">',
    '<p style="color:#94a3b8;font-size:12px">Auto-generated by TikSaveHub cookie health checker.</p>',
    '</div>',
  ].join('');

  return { subject, html };
}

let dailyTimer: NodeJS.Timeout | null = null;

async function runDailyReport(): Promise<void> {
  const sources = getCookieSources();
  if (sources.length === 0) return;

  // Test all cookies first (updates state.lastOk)
  const now = new Date().toISOString();
  for (const src of sources) {
    const ok = await testCookie(src.cookie);
    if (ok) state.lastOk[src.label] = now;
  }
  saveState();

  const { subject, html } = buildDailyReportHtml();
  await sendEmail(subject, html);
  console.log('[ig-health] Daily report sent');
}

// ── Public API ────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

/**
 * Start the periodic cookie health checker.
 * Call once from the server entrypoint. Safe to call multiple times (no-op).
 */
export function startCookieHealthChecker(): void {
  if (timer) return;
  if (!notificationsEnabled()) {
    console.log('[ig-health] Email notifications not configured — health checker disabled');
    return;
  }

  loadState();

  // Run first check after 30s (let server finish booting)
  setTimeout(() => {
    runCheck().catch((err) => {
      console.error('[ig-health] Check failed:', (err as Error)?.message ?? err);
    });
  }, 30_000);

  // Then every CHECK_INTERVAL_MS
  timer = setInterval(() => {
    runCheck().catch((err) => {
      console.error('[ig-health] Check failed:', (err as Error)?.message ?? err);
    });
  }, CHECK_INTERVAL_MS);

  console.log(`[ig-health] Alert checks every ${CHECK_INTERVAL_MS / 3600_000}h, daily report every ${DAILY_REPORT_MS / 3600_000}h`);

  // Daily report — first one after 60s, then every 24h
  setTimeout(() => {
    runDailyReport().catch((err) => {
      console.error('[ig-health] Daily report failed:', (err as Error)?.message ?? err);
    });
  }, 60_000);

  dailyTimer = setInterval(() => {
    runDailyReport().catch((err) => {
      console.error('[ig-health] Daily report failed:', (err as Error)?.message ?? err);
    });
  }, DAILY_REPORT_MS);
}

/**
 * Manually trigger a health check (e.g. from an admin API endpoint).
 */
export async function checkCookieHealthNow(): Promise<void> {
  loadState();
  await runCheck();
}

export async function checkCookieHealthDailyNow(): Promise<void> {
  loadState();
  await runDailyReport();
}
