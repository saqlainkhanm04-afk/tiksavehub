import type { APIRoute } from 'astro';
import { isValidTikTokUrl } from '../../lib/tiktok';
import { normalizeTikTokUrl, resolveTikTokShortLink } from '../../lib/normalize';
import { clientIpFrom } from '../../lib/rate-limit';
import { thirdPartyApiHeaders } from '../../lib/platforms/headers';

export const prerender = false;

const TIKWM_COMMENTS = 'https://tikwm.com/api/comment/list';
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
    const endpoint = new URL(TIKWM_COMMENTS);
    endpoint.searchParams.set('url', canonical);
    endpoint.searchParams.set('count', String(count));
    endpoint.searchParams.set('cursor', String(cursor));

    const response = await fetch(endpoint, {
      headers: thirdPartyApiHeaders('https://tikwm.com/'),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      console.error(`[TikSaveHub Comments] TikWM HTTP ${response.status} url=${canonical}`);
      return jsonResponse({ success: false, error: 'TikTok comments could not be loaded right now. Try again in a minute.' }, 502);
    }

    const payload = await response.json().catch(() => null) as any;
    if (!payload || payload.code !== 0) {
      const providerMessage = String(payload?.msg || 'Comment provider returned an error.');
      console.error(`[TikSaveHub Comments] provider error url=${canonical} message=${providerMessage}`);
      return jsonResponse({ success: false, error: 'TikTok did not return comments for this video. Make sure it is public and has comments enabled.' }, 502);
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
