import type { APIRoute } from 'astro';
import { tiktokSources } from '../../lib/platforms/tiktok';
import { tiktokDirectSource } from '../../lib/platforms/tiktok-direct';
import { tiktokWebHeaders, tiktokApiHeaders } from '../../lib/platforms/headers';
import { resolveTikTokShortLink, normalizeTikTokUrl } from '../../lib/normalize';
import { getEnv, initRequestEnv } from '../../lib/init-env';

export const prerender = false;

const TEST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function extractVideoId(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const patterns = [/\/video\/(\d{6,})/, /\/photo\/(\d{6,})/, /\/v\/(\d{6,})/, /\/embed\/v2\/(\d{6,})/];
    for (const p of patterns) {
      const m = pathname.match(p);
      if (m) return m[1];
    }
    const trailing = pathname.match(/(\d{15,})\/?$/);
    return trailing ? trailing[1] : null;
  } catch { return null; }
}

/* ── Individual source testers ─────────────────────────────────── */

async function testTikWM(url: string): Promise<any> {
  const start = Date.now();
  const hosts = ['https://tikwm.com/api/', 'https://www.tikwm.com/api/'];
  const attempts: any[] = [];
  for (const host of hosts) {
    try {
      const fetchUrl = `${host}?url=${encodeURIComponent(url)}&hd=1`;
      const resp = await fetch(fetchUrl, {
        headers: { 'User-Agent': TEST_UA, 'Accept': 'application/json', 'Referer': 'https://tikwm.com/' },
        signal: AbortSignal.timeout(5_000),
      });
      const body = await resp.text().catch(() => '<unreadable>');
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      const ok = resp.ok && parsed?.code === 0 && !!parsed?.data;
      attempts.push({
        host, status: resp.status, ok,
        code: parsed?.code, msg: parsed?.msg,
        title: parsed?.data?.title?.substring(0, 80) ?? null,
        hasPlay: !!parsed?.data?.play, hasHd: !!parsed?.data?.hdplay,
        bodySnippet: body.substring(0, 300),
      });
      if (ok) break;
    } catch (err: any) {
      attempts.push({ host, error: err?.message ?? String(err) });
    }
  }
  return { ms: Date.now() - start, attempts };
}

async function testTikTokDirect(url: string): Promise<any> {
  const start = Date.now();
  try {
    const headers = tiktokWebHeaders({ referer: 'https://www.tiktok.com/' });
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(12_000), redirect: 'follow' });
    const status = resp.status;
    const reader = resp.body?.getReader();
    if (!reader) return { ok: false, ms: Date.now() - start, status, error: 'No response body' };

    const decoder = new TextDecoder();
    let buffered = '';
    let bytesRead = 0;
    try {
      while (bytesRead < 512_000) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.length;
        buffered += decoder.decode(value, { stream: true });
        if (buffered.includes('</head>') || buffered.includes('SIGI_STATE') || buffered.includes('__NEXT_DATA__')) break;
      }
    } finally { reader.cancel().catch(() => {}); }

    const hasUniversal = buffered.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    const hasSigi = buffered.includes('SIGI_STATE');
    const hasNext = buffered.includes('__NEXT_DATA__');
    const hasPlayAddr = /"playAddr"\s*:\s*"(https?:[^"]+)"/.test(buffered);
    const hasDownloadAddr = /"downloadAddr"\s*:\s*"(https?:[^"]+)"/.test(buffered);
    const hasLoginRedirect = buffered.includes('/login') || buffered.includes('log into');
    const hasVideoDetail = buffered.includes('webapp.video-detail');

    let snippet = '';
    const idx = buffered.indexOf('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (idx > -1) snippet = buffered.substring(idx, idx + 300);

    return {
      ok: hasUniversal || hasSigi || hasNext || hasPlayAddr || hasDownloadAddr,
      status, bytesRead,
      hasUniversal, hasSigi, hasNext,
      hasPlayAddr, hasDownloadAddr,
      hasLoginRedirect, hasVideoDetail,
      snippet: snippet || buffered.substring(0, 500),
      ms: Date.now() - start,
    };
  } catch (err: any) {
    return { ok: false, ms: Date.now() - start, error: err?.message ?? String(err) };
  }
}

async function testCobalt(url: string): Promise<any> {
  const start = Date.now();
  let hasApiKey = false;
  try {
    const v = (import.meta as any).env?.COBALT_API_KEY
      || (typeof process !== 'undefined' && process.env?.COBALT_API_KEY);
    hasApiKey = !!(v && typeof v === 'string' && v.trim());
  } catch {}
  const attempts: any[] = [];

  // Test community instances directly (no auth needed)
  const INSTANCES = [
    'https://cobaltapi.cjs.nz',
    'https://cobaltapi.squair.xyz',
    'https://cobaltapi.kittycat.boo',
    'https://cobalt-api.lain.wtf',
    'https://cobalt-api.kwiatekmiki.com',
    'https://api.cobalt.best',
    'https://cobalt-api.hyper.lol',
  ];

  for (const base of INSTANCES) {
    try {
      const resp = await fetch(`${base}/`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, downloadMode: 'auto', videoQuality: '1080' }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await resp.text().catch(() => '<unreadable>');
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      const hasUrl = !!(parsed?.url || parsed?.tunnel?.length || parsed?.picker?.length);
      attempts.push({
        instance: base, status: resp.status, ok: resp.ok && hasUrl,
        errorCode: parsed?.error?.code ?? null,
        bodySnippet: body.substring(0, 200),
      });
      if (hasUrl) break;
    } catch (err: any) {
      attempts.push({ instance: base, error: err?.message ?? String(err) });
    }
  }

  return { hasApiKey, ms: Date.now() - start, attempts };
}

async function testTikTokItemDetail(url: string): Promise<any> {
  const start = Date.now();
  const videoId = extractVideoId(url);
  if (!videoId) return { ok: false, error: 'Cannot extract video ID', ms: Date.now() - start };
  try {
    const headers = tiktokApiHeaders();
    const fetchUrl = `https://www.tiktok.com/api/item/detail/?itemId=${videoId}&aid=1988`;
    const resp = await fetch(fetchUrl, { headers, signal: AbortSignal.timeout(8_000) });
    const body = await resp.text().catch(() => '<unreadable>');
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    const hasItem = !!parsed?.itemInfo?.itemStruct;
    return {
      ok: resp.ok && hasItem, status: resp.status, hasItem,
      ua: headers['User-Agent']?.substring(0, 50),
      bodySnippet: body.substring(0, 800),
      ms: Date.now() - start,
    };
  } catch (err: any) {
    return { ok: false, ms: Date.now() - start, error: err?.message ?? String(err) };
  }
}

async function testTikTokDownbloder(url: string): Promise<any> {
  const start = Date.now();
  try {
    const fetchUrl = `https://tiktok-downbloder.vercel.app/?url=${encodeURIComponent(url)}`;
    const resp = await fetch(fetchUrl, {
      headers: { 'User-Agent': TEST_UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await resp.text().catch(() => '<unreadable>');
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    const result = parsed?.result?.raw?.result;
    return {
      ok: !!parsed?.success && !!result?.video,
      status: resp.status,
      hasVideo: !!result?.video,
      videoUrl: result?.video?.substring(0, 120) ?? null,
      hasMusic: !!result?.music,
      desc: result?.desc?.substring(0, 100) ?? null,
      author: result?.author?.nickname ?? null,
      bodySnippet: body.substring(0, 500),
      ms: Date.now() - start,
    };
  } catch (err: any) {
    return { ok: false, ms: Date.now() - start, error: err?.message ?? String(err) };
  }
}

async function testOembed(url: string): Promise<any> {
  const start = Date.now();
  try {
    const resp = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': TEST_UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    const body = await resp.text().catch(() => '<unreadable>');
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    return { ok: resp.ok, status: resp.status, hasTitle: !!parsed?.title, bodySnippet: body.substring(0, 500), ms: Date.now() - start };
  } catch (err: any) {
    return { ok: false, ms: Date.now() - start, error: err?.message ?? String(err) };
  }
}

/* ── Source chain summary ─────────────────────────────────────── */

function getSourceChainSummary(): any {
  const sources = tiktokSources('dummy-turnstile');
  return sources.map((s, i) => ({
    order: i + 1,
    name: s.name,
    timeoutMs: s.timeoutMs,
    retries: s.retries,
    noRetryStatuses: s.noRetryStatuses,
    noRetryErrors: s.noRetryErrors,
  }));
}

/* ── Route handler ────────────────────────────────────────────── */

export const GET: APIRoute = async (ctx) => {
  const { url } = ctx;
  initRequestEnv(getEnv(ctx));

  const videoUrl = url.searchParams.get('url');
  if (!videoUrl) {
    return new Response(JSON.stringify({ error: 'Missing ?url param' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  let canonical: string;
  try {
    canonical = await resolveTikTokShortLink(normalizeTikTokUrl(videoUrl));
  } catch {
    canonical = videoUrl;
  }

  const videoId = extractVideoId(new URL(canonical).pathname);
  const results = {
    input: videoUrl,
    canonical,
    videoId,
    timestamp: new Date().toISOString(),
    sourceChain: getSourceChainSummary(),
    tests: {} as Record<string, any>,
  };

  // Run all tests in parallel
  const [tikwm, direct, cobalt, downbloder, itemDetail, oembed] = await Promise.allSettled([
    testTikWM(canonical),
    testTikTokDirect(canonical),
    testCobalt(canonical),
    testTikTokDownbloder(canonical),
    testTikTokItemDetail(canonical),
    testOembed(canonical),
  ]);

  results.tests = {
    tikwm: tikwm.status === 'fulfilled' ? tikwm.value : { error: tikwm.reason?.message ?? String(tikwm.reason) },
    tiktokDirect: direct.status === 'fulfilled' ? direct.value : { error: direct.reason?.message ?? String(direct.reason) },
    cobalt: cobalt.status === 'fulfilled' ? cobalt.value : { error: cobalt.reason?.message ?? String(cobalt.reason) },
    tiktokDownbloder: downbloder.status === 'fulfilled' ? downbloder.value : { error: downbloder.reason?.message ?? String(downbloder.reason) },
    tiktokItemDetail: itemDetail.status === 'fulfilled' ? itemDetail.value : { error: itemDetail.reason?.message ?? String(itemDetail.reason) },
    oembed: oembed.status === 'fulfilled' ? oembed.value : { error: oembed.reason?.message ?? String(oembed.reason) },
  };

  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
