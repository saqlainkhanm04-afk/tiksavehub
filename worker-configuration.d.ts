// Cloudflare Workers environment types for TikSaveHub
// Generated for @astrojs/cloudflare compatibility

interface CloudflareEnv {
  // Environment variables
  PROCESSOR_BACKEND_URL: string;
  IG_COOKIES?: string;
  IG_SESSIONID?: string;
  IG_DS_USER_ID?: string;
  IG_CSRF_TOKEN?: string;
  RATE_LIMIT_PER_MIN?: string;
  CACHE_MAX_ENTRIES?: string;
  MEDIA_TTL_MS?: string;
  INSTAGRAM_MEDIA_TTL_MS?: string;
  YTDLP_TTL_MS?: string;
  MAX_CACHE_AGE_MS?: string;
  YTDLP_PATH?: string;
  NODE_ENV?: string;

  // KV namespace bindings
  CACHE: KVNamespace;

  // Durable Objects (if used)
  RATE_LIMITER: DurableObjectNamespace;
}

type CloudflareVars = Partial<CloudflareEnv>;
