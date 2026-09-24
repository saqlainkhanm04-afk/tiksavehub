/**
 * Generic API Fallback / Failover System
 *
 * Try multiple API sources in order. Each source has its own fetcher and
 * normalizer so the caller always receives a unified response shape.
 * Supports per-source retries with exponential backoff and a circuit breaker
 * that temporarily skips sources that have failed repeatedly.
 */

export interface ApiSource<TInput, TOutput> {
  /** Human-readable name for logging (e.g. "TikWM", "Cobalt") */
  name: string;
  /**
   * Fetch raw data from this source.
   * Throw or return null/undefined to signal failure — the runner moves on.
   */
  fetch(input: TInput): Promise<any>;
  /**
   * Normalize raw response into the unified output shape.
   * Return null if the raw response is unusable (bad status, missing fields).
   */
  normalize(raw: any, input: TInput): TOutput | null;
  /** Optional timeout per attempt in ms (default 10 000) */
  timeoutMs?: number;
  /** Max retries for this specific source before moving to the next (default 1) */
  retries?: number;
  /** HTTP status codes that should NOT be retried (e.g. [404, 422]) */
  noRetryStatuses?: number[];
  /** Error message substrings that should NOT be retried (e.g. ["No turnstile token"]) */
  noRetryErrors?: string[];
}

export interface FallbackResult<TOutput> {
  data: TOutput;
  source: string;
  attemptMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 1;
const BACKOFF_BASE_MS = 400;
const BACKOFF_MAX_MS = 3_000;

/* ------------------------------------------------------------------ */
/*  Circuit Breaker — skip sources that fail repeatedly               */
/* ------------------------------------------------------------------ */
interface CircuitEntry { failCount: number; openUntil: number; }
const circuitStore = new Map<string, CircuitEntry>();
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;

function circuitIsOpen(name: string): boolean {
  const e = circuitStore.get(name);
  if (!e) return false;
  if (Date.now() < e.openUntil) return true;
  circuitStore.delete(name);
  return false;
}

function circuitRecordFailure(name: string): void {
  const prev = circuitStore.get(name);
  const count = (prev?.failCount ?? 0) + 1;
  if (count >= CIRCUIT_THRESHOLD) {
    circuitStore.set(name, { failCount: count, openUntil: Date.now() + CIRCUIT_COOLDOWN_MS });
    console.log(`[api-fallback] Circuit OPEN for ${name} — skipping for ${CIRCUIT_COOLDOWN_MS / 1000}s`);
  } else {
    circuitStore.set(name, { failCount: count, openUntil: 0 });
  }
}

function circuitRecordSuccess(name: string): void {
  circuitStore.delete(name);
}

/* ------------------------------------------------------------------ */
/*  Main runner                                                       */
/* ------------------------------------------------------------------ */

/**
 * Try each source in order (with per-source retries). Returns the first
 * successful normalized result. Throws a single error only after ALL
 * sources have been exhausted.
 */
interface SourceError {
  source: string;
  message: string;
  httpStatus?: number;  // extracted from error message when available
}

export async function runWithFallback<TInput, TOutput>(
  input: TInput,
  sources: ApiSource<TInput, TOutput>[],
): Promise<FallbackResult<TOutput>> {
  const errors: SourceError[] = [];
  let totalMs = 0;

  for (const source of sources) {
    if (circuitIsOpen(source.name)) {
      console.log(`[api-fallback] ${source.name} skipped (circuit breaker open)`);
      errors.push({ source: source.name, message: 'Circuit breaker open — skipped' });
      continue;
    }

    const maxRetries = source.retries ?? DEFAULT_RETRIES;
    let lastErr: string = '';
    let lastHttpStatus: number | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const start = Date.now();
      try {
        const raw = await withTimeout(source.fetch(input), source.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const normalized = source.normalize(raw, input);
        const elapsed = Date.now() - start;
        totalMs += elapsed;

        if (normalized) {
          circuitRecordSuccess(source.name);
          console.log(`[api-fallback] ${source.name} SUCCESS in ${elapsed}ms${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);
          return { data: normalized, source: source.name, attemptMs: totalMs };
        }

        lastErr = 'Returned unusable data';
        console.log(`[api-fallback] ${source.name} returned unusable data (${elapsed}ms)`);
      } catch (err: any) {
        const elapsed = Date.now() - start;
        totalMs += elapsed;

        const msg = err?.name === 'TimeoutError' || err?.name === 'AbortError'
          ? `Timeout after ${source.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
          : err?.message ?? String(err);

        // Extract HTTP status code from error message patterns like "returned 403" or "→429"
        const statusMatch = msg.match(/returned (\d{3})|→(\d{3})|HTTP (\d{3})|status[= :]+(\d{3})/);
        const status = statusMatch ? parseInt(statusMatch[1] || statusMatch[2] || statusMatch[3] || statusMatch[4]) : 0;
        if (status) lastHttpStatus = status;

        // Check for non-retryable HTTP status
        if (source.noRetryStatuses?.includes(status)) {
          lastErr = msg;
          console.log(`[api-fallback] ${source.name} non-retryable HTTP ${status} (${elapsed}ms)`);
          break; // skip retries, move to next source
        }

        // Check for non-retryable application errors
        if (source.noRetryErrors?.some((pat) => msg.toLowerCase().includes(pat.toLowerCase()))) {
          lastErr = msg;
          console.log(`[api-fallback] ${source.name} non-retryable error: ${msg} (${elapsed}ms)`);
          break;
        }

        lastErr = msg;
        console.log(`[api-fallback] ${source.name} attempt ${attempt + 1}/${maxRetries + 1} FAILED: ${msg} (${elapsed}ms)`);

        // Backoff before retry (skip on last attempt)
        if (attempt < maxRetries) {
          const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);
          await sleep(delay);
        }
      }
    }

    // All retries for this source exhausted
    circuitRecordFailure(source.name);
    errors.push({ source: source.name, message: lastErr || 'Unknown error', httpStatus: lastHttpStatus });
  }

  // Build detailed error summary with HTTP status codes
  const summary = errors.map((e) =>
    e.httpStatus ? `${e.source}: HTTP ${e.httpStatus} — ${e.message}` : `${e.source}: ${e.message}`
  ).join(' | ');
  throw new Error(`All ${sources.length} API sources failed (${totalMs}ms) — ${summary}`);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Race a promise against a timeout. Rejects with TimeoutError on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException(`Timed out after ${ms}ms`, 'TimeoutError')), ms);
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/*  Race runner — try multiple sources in parallel, first wins          */
/* ------------------------------------------------------------------ */

/**
 * Run multiple sources in parallel. The first successful normalized result
 * wins. Losers are canceled/ignored. Much faster than sequential fallback
 * when the first source in the chain is slow or unreliable.
 */
export async function runWithRace<TInput, TOutput>(
  input: TInput,
  sources: ApiSource<TInput, TOutput>[],
): Promise<FallbackResult<TOutput>> {
  const errors: SourceError[] = [];
  const startAll = Date.now();

  return new Promise<FallbackResult<TOutput>>((resolve, reject) => {
    let settled = false;
    let remaining = sources.length;

    for (const source of sources) {
      if (circuitIsOpen(source.name)) {
        errors.push({ source: source.name, message: 'Circuit breaker open — skipped' });
        remaining--;
        if (remaining <= 0 && !settled) {
          settled = true;
          reject(buildRaceError(errors, startAll));
        }
        continue;
      }

      const maxRetries = source.retries ?? 0; // race uses 0 retries by default (fast fail)

      (async () => {
        let lastErr = '';
        let lastHttpStatus: number | undefined;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          const start = Date.now();
          try {
            const raw = await withTimeout(source.fetch(input), source.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            const normalized = source.normalize(raw, input);
            const elapsed = Date.now() - start;

            if (normalized) {
              circuitRecordSuccess(source.name);
              if (!settled) {
                settled = true;
                console.log(`[api-fallback:race] ${source.name} WON in ${elapsed}ms${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);
                resolve({ data: normalized, source: source.name, attemptMs: Date.now() - startAll });
              }
              return;
            }

            lastErr = 'Returned unusable data';
          } catch (err: any) {
            const elapsed = Date.now() - start;
            const msg = err?.name === 'TimeoutError' || err?.name === 'AbortError'
              ? `Timeout after ${source.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
              : err?.message ?? String(err);

            const statusMatch = msg.match(/returned (\d{3})|→(\d{3})|HTTP (\d{3})|status[= :]+(\d{3})/);
            const status = statusMatch ? parseInt(statusMatch[1] || statusMatch[2] || statusMatch[3] || statusMatch[4]) : 0;
            if (status) lastHttpStatus = status;

            if (source.noRetryStatuses?.includes(status)) {
              lastErr = msg;
              break;
            }
            if (source.noRetryErrors?.some((pat) => msg.toLowerCase().includes(pat.toLowerCase()))) {
              lastErr = msg;
              break;
            }

            lastErr = msg;

            if (attempt < maxRetries) {
              const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);
              await sleep(delay);
            }
          }
        }

        circuitRecordFailure(source.name);
        errors.push({ source: source.name, message: lastErr || 'Unknown error', httpStatus: lastHttpStatus });
        remaining--;
        if (remaining <= 0 && !settled) {
          settled = true;
          reject(buildRaceError(errors, startAll));
        }
      })();
    }
  });
}

function buildRaceError(errors: SourceError[], startAll: number): Error {
  const summary = errors.map((e) =>
    e.httpStatus ? `${e.source}: HTTP ${e.httpStatus} — ${e.message}` : `${e.source}: ${e.message}`
  ).join(' | ');
  return new Error(`All ${errors.length} API sources failed (${Date.now() - startAll}ms) — ${summary}`);
}
