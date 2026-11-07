// Aggregated multilingual Snapchat blog posts.
// Each language file exports its own array (e.g. dePosts). This module
// flattens them into a single map keyed by language code for routing.
import { dePosts } from './de.js';
import { esPosts } from './es.js';
import { frPosts } from './fr.js';
import { itPosts } from './it.js';
import { jaPosts } from './ja.js';
import { koPosts } from './ko.js';
import { ptPosts } from './pt.js';

export const postsByLang = {
  de: dePosts,
  es: esPosts,
  fr: frPosts,
  it: itPosts,
  ja: jaPosts,
  ko: koPosts,
  pt: ptPosts,
};

export const blogLangs = Object.keys(postsByLang);

/** All localized posts as a flat array (each carries `lang`). */
export const allLocalizedPosts = blogLangs.flatMap((lang) => postsByLang[lang] ?? []);

/**
 * Build hreflang alternates for a localized post.
 * Maps each language's post (via enSlug) to its localized URL, plus the
 * English canonical post and x-default handled by Layout.
 */
export function postHreflangAlternates(post, site = 'https://tiksavehub.com') {
  const base = site.replace(/\/+$/, '');
  const alternates = [];
  for (const [lang, list] of Object.entries(postsByLang)) {
    const match = (list ?? []).find((p) => p.enSlug === post.enSlug || p.slug === post.slug);
    if (match) {
      alternates.push({ lang, href: `${base}/${lang}/blog/${match.slug}` });
    }
  }
  // English original
  if (post.enSlug) {
    alternates.push({ lang: 'en', href: `${base}/blog/${post.enSlug}` });
  }
  return alternates;
}
