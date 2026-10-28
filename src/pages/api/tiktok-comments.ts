import type { APIRoute } from 'astro';
import { isValidTikTokUrl } from '../../lib/tiktok';
import { normalizeTikTokUrl, resolveTikTokShortLink } from '../../lib/normalize';
import { clientIpFrom } from '../../lib/rate-limit';
import { thirdPartyApiHeaders } from '../../lib/platforms/headers';
import { cacheGet, cacheSet } from '../../lib/cache';

export const prerender = false;

const TIKWM_COMMENT_HOSTS = [
  'https://tikwm.com/api/comment/list',
  'https://www.tikwm.com/api/comment/list',
] as const;
const TIKTOK_MOBILE_COMMENTS = 'https://api22-normal-c-useast2a.tiktokv.com/aweme/v1/comment/list/';
const COMMENT_CACHE_TTL_MS = 5 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 8_000;
const READER_TIMEOUT_MS = 25_000;
const DEFAULT_COUNT = 50;
const MAX_COUNT = 50;
// A 5,000-comment export needs up to 100 paginated requests. The default
// 30/minute limit would cut it off at ~1,500 comments, so this route uses a
// dedicated ceiling that is still bounded per IP.
const COMMENT_REQUESTS_PER_MINUTE = 220;
const COMMENT_WINDOW_MS = 60_000;
const commentHits = new Map<string, number[]>();

function isCommentRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (commentHits.get(ip) || []).filter((time) => now - time < COMMENT_WINDOW_MS);
  if (hits.length >= COMMENT_REQUESTS_PER_MINUTE) {
    commentHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  commentHits.set(ip, hits);
  return false;
}

interface TikWMComment {
  id?: string;
  text?: string;
  create_time?: number;
  digg_count?: number;
  reply_total?: number;
  user?: {
    unique_id?: string;
    nickname?: string;
    avatar?: string;
    verified?: boolean;
  };
}

function videoIdFromUrl(value: string): string {
  const match = value.match(/\/video\/(\d{6,})/i);
  return match ? match[1] : '';
}

interface ProviderResult {
  payload: any | null;
  error: string;
}

function providerUrl(base: string, canonical: string, count: number, cursor: number): URL {
  const endpoint = new URL(base);
  endpoint.searchParams.set('url', canonical);
  endpoint.searchParams.set('count', String(count));
  endpoint.searchParams.set('cursor', String(cursor));
  return endpoint;
}

function parseProviderJson(text: string): any | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{"code"');
  if (start < 0) return null;
  const end = trimmed.lastIndexOf('}');
  if (end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeMobilePayload(payload: any): any {
  const raw = Array.isArray(payload?.comments) ? payload.comments : [];
  const comments = raw.map((comment: any) => {
    const avatar = comment?.user?.avatar_thumb?.url_list?.[0]
      || comment?.user?.avatar?.url_list?.[0]
      || '';
    return {
      id: comment?.cid,
      text: comment?.text,
      create_time: comment?.create_time,
      digg_count: comment?.digg_count,
      reply_total: comment?.reply_comment_total
        ?? comment?.reply_comment?.reply_comment_total
        ?? 0,
      user: {
        unique_id: comment?.user?.unique_id,
        nickname: comment?.user?.nickname,
        avatar,
        verified: Boolean(comment?.user?.custom_verify),
      },
    };
  });
  return {
    code: 0,
    data: {
      comments,
      cursor: payload?.cursor,
      hasMore: Boolean(payload?.has_more),
      total: payload?.total,
    },
  };
}

async function fetchGoogleCommentPage(canonical: string, count: number, cursor: number): Promise<ProviderResult> {
  try {
    const source = providerUrl(TIKWM_COMMENT_HOSTS[1], canonical, count, cursor);
    const endpoint = new URL(source.toString());
    endpoint.hostname = `${endpoint.hostname.replace(/\./g, '-')}.translate.goog`;
    endpoint.searchParams.set('_x_tr_sl', 'auto');
    endpoint.searchParams.set('_x_tr_tl', 'en');
    endpoint.searchParams.set('_x_tr_hl', 'en');

    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { payload: null, error: `Google Reader HTTP ${response.status}` };
    }
    const payload = await response.json().catch(() => null) as any;
    if (!payload) {
      return { payload: null, error: 'Google Reader returned invalid JSON.' };
    }
    if (payload.code !== 0) {
      return { payload: null, error: String(payload.msg || 'Google Reader provider returned an error.') };
    }
    return { payload, error: '' };
  } catch (err) {
    return { payload: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchMobileCommentPage(canonical: string, count: number, cursor: number): Promise<ProviderResult> {
  const videoId = videoIdFromUrl(canonical);
  if (!videoId) return { payload: null, error: 'Video ID missing for mobile provider.' };

  try {
    const endpoint = new URL(TIKTOK_MOBILE_COMMENTS);
    endpoint.searchParams.set('aweme_id', videoId);
    endpoint.searchParams.set('count', String(count));
    endpoint.searchParams.set('cursor', String(cursor));
    endpoint.searchParams.set('aid', '1988');
    endpoint.searchParams.set('app_name', 'musical_ly');
    endpoint.searchParams.set('version_code', '300904');
    endpoint.searchParams.set('device_platform', 'android');
    endpoint.searchParams.set('device_type', 'Pixel 7');
    endpoint.searchParams.set('os_version', '13');

    const response = await fetch(endpoint, {
      headers: {
        'User-Agent': 'com.ss.android.ugc.trill/300904 (Linux; U; Android 13; en_US; Pixel 7; Build/TQ3A.230805.001)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { payload: null, error: `TikTok mobile HTTP ${response.status}` };
    }
    const payload = await response.json().catch(() => null) as any;
    if (!payload) {
      return { payload: null, error: 'TikTok mobile returned invalid JSON.' };
    }
    if (payload.status_code !== 0 || !Array.isArray(payload.comments)) {
      return {
        payload: null,
        error: `TikTok mobile status ${payload.status_code ?? 'unknown'}: ${payload.status_msg || 'no comments returned'}`,
      };
    }
    return { payload: normalizeMobilePayload(payload), error: '' };
  } catch (err) {
    return { payload: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchCommentPage(canonical: string, count: number, cursor: number): Promise<ProviderResult> {
  let lastError = 'Comment provider returned an empty response.';

  for (let i = 0; i < TIKWM_COMMENT_HOSTS.length; i++) {
    // The sibling host is rate-limited to one request per second. Give the
    // first host's failed request time to expire before trying it.
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1_100));
    try {
      const endpoint = providerUrl(TIKWM_COMMENT_HOSTS[i], canonical, count, cursor);
      const response = await fetch(endpoint, {
        headers: thirdPartyApiHeaders(i === 0 ? 'https://tikwm.com/' : 'https://www.tikwm.com/'),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!response.ok) {
        lastError = `TikWM HTTP ${response.status}`;
        continue;
      }
      const payload = await response.json().catch(() => null) as any;
      if (!payload) {
        lastError = 'TikWM returned invalid JSON.';
        continue;
      }
      if (payload.code !== 0) {
        lastError = String(payload.msg || 'Comment provider returned an error.');
        continue;
      }
      return { payload, error: '' };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  const google = await fetchGoogleCommentPage(canonical, count, cursor);
  if (google.payload) return google;
  lastError = google.error || lastError;

  const mobile = await fetchMobileCommentPage(canonical, count, cursor);
  if (mobile.payload) return mobile;
  lastError = mobile.error || lastError;

  // Cloudflare's shared egress IP frequently exhausts TikWM's free daily
  // quota. Jina Reader uses a different egress and returns the raw JSON body
  // wrapped in a small title header, so it is a useful last-resort provider.
  try {
    const source = providerUrl(TIKWM_COMMENT_HOSTS[1], canonical, count, cursor);
    const response = await fetch(`https://r.jina.ai/${source.toString()}`, {
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { payload: null, error: `Reader HTTP ${response.status}` };
    }
    const payload = parseProviderJson(await response.text());
    if (!payload) {
      return { payload: null, error: 'Reader returned an unreadable response.' };
    }
    if (payload.code !== 0) {
      return { payload: null, error: String(payload.msg || 'Reader provider returned an error.') };
    }
    return { payload, error: '' };
  } catch (err) {
    return { payload: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': status === 200
        ? 'public, max-age=120, s-maxage=300, stale-while-revalidate=600'
        : 'no-store',
    },
  });
}

export const GET: APIRoute = async ({ url, request }) => {
  const rawUrl = url.searchParams.get('url') || '';
  const countRaw = Number.parseInt(url.searchParams.get('count') || String(DEFAULT_COUNT), 10);
  const cursorRaw = Number.parseInt(url.searchParams.get('cursor') || '0', 10);
  const count = Number.isFinite(countRaw) ? Math.min(MAX_COUNT, Math.max(1, countRaw)) : DEFAULT_COUNT;
  const cursor = Number.isFinite(cursorRaw) ? Math.max(0, cursorRaw) : 0;

  if (!rawUrl) {
    return jsonResponse({ success: false, error: 'Missing "url" query parameter.' }, 400);
  }
  if (!isValidTikTokUrl(rawUrl)) {
    return jsonResponse({ success: false, error: 'Enter a valid public TikTok video link.' }, 422);
  }
  if (isCommentRateLimited(clientIpFrom(request))) {
    return jsonResponse({ success: false, error: 'Too many requests. Try again in a minute.' }, 429);
  }

  let canonical: string;
  try {
    canonical = await resolveTikTokShortLink(normalizeTikTokUrl(rawUrl));
  } catch {
    canonical = normalizeTikTokUrl(rawUrl);
  }

  try {
    const cacheKey = `comments:${canonical}:${cursor}:${count}`;
    const cached = cacheGet<ProviderResult>(cacheKey);
    const provider: ProviderResult = cached ?? (await fetchCommentPage(canonical, count, cursor));
    if (!cached && provider.payload) {
      cacheSet(cacheKey, provider, COMMENT_CACHE_TTL_MS);
    }

    const payload = provider.payload;
    if (!payload) {
      const providerMessage = provider.error || 'Comment provider returned an error.';
      console.error(`[TikSaveHub Comments] provider error url=${canonical} message=${providerMessage}`);
      const providerLimited = /limit|rate|too many|busy/i.test(providerMessage);
      return jsonResponse({
        success: false,
        error: providerLimited
          ? 'The comment provider is busy right now. Try again in a few minutes.'
          : 'TikTok did not return comments for this video. Make sure it is public and has comments enabled.',
      }, providerLimited ? 503 : 502);
    }

    const rawComments = Array.isArray(payload?.data?.comments) ? payload.data.comments as TikWMComment[] : [];
    const comments = rawComments
      .map((comment) => {
        const id = String(comment.id || '').trim();
        if (!id) return null;
        return {
          id,
          text: String(comment.text || ''),
          likes: Number.isFinite(Number(comment.digg_count)) ? Number(comment.digg_count) : 0,
          replies: Number.isFinite(Number(comment.reply_total)) ? Number(comment.reply_total) : 0,
          createdAt: Number.isFinite(Number(comment.create_time)) ? Number(comment.create_time) : null,
          username: String(comment.user?.unique_id || ''),
          displayName: String(comment.user?.nickname || ''),
          avatar: String(comment.user?.avatar || ''),
          verified: Boolean(comment.user?.verified),
        };
      })
      .filter((comment): comment is NonNullable<typeof comment> => comment !== null);

    const nextCursorRaw = Number(payload?.data?.cursor);
    const nextCursor = Number.isFinite(nextCursorRaw)
      ? nextCursorRaw
      : cursor + comments.length;
    const hasMore = Boolean(payload?.data?.hasMore) && comments.length > 0;
    const totalRaw = Number(payload?.data?.total);

    return jsonResponse({
      success: true,
      videoId: videoIdFromUrl(canonical),
      comments,
      total: Number.isFinite(totalRaw) ? totalRaw : null,
      nextCursor: hasMore ? nextCursor : null,
      hasMore,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[TikSaveHub Comments] url=${canonical} error=${message}`);
    return jsonResponse({ success: false, error: 'TikTok comments could not be loaded right now. Try again in a minute.' }, 502);
  }
};
