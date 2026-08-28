import { defineMiddleware } from 'astro:middleware';

const STATIC_EXT_RE = /\.(ico|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|eot|otf|css|js|mjs|map|txt|xml|json|webmanifest|mp4|mp3|webm|ogg|wav)$/i;

export const onRequest = defineMiddleware((ctx, next) => {
  const { pathname } = ctx.url;

  if (pathname.startsWith('/_astro/') || STATIC_EXT_RE.test(pathname)) {
    return next();
  }

  try {
    return next();
  } catch (err) {
    console.error(`[middleware] Error rendering ${pathname}:`, err);
    return new Response('Internal Server Error', { status: 500 });
  }
});
