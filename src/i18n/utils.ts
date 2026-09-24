import { ui, defaultLang, type Lang, type TranslationKey } from './ui';

export type { Lang } from './ui';

export function getLangFromUrl(url: URL): Lang {
  const [, lang] = url.pathname.split('/');
  if (lang && lang in ui) return lang as Lang;
  return defaultLang;
}

export function useTranslations(lang: Lang) {
  const localizedUI: Record<string, string> = ui[lang];
  return function t(key: TranslationKey): string {
    return key in localizedUI ? localizedUI[key] : ui[defaultLang][key];
  };
}

export function getLocalizedPath(path: string, lang: Lang): string {
  if (lang === defaultLang) return path;
  // Never double-prefix an already-localized path
  // (e.g. "/de/facebook-story-downloader" with lang "de" stays unchanged,
  // instead of becoming "/de/de/facebook-story-downloader").
  if (path.startsWith(`/${lang}/`) || path === `/${lang}`) return path;
  return `/${lang}${path}`;
}

export function getAlternateLangLinks(pathname: string, site: string): { lang: string; href: string }[] {
  const links: { lang: string; href: string }[] = [];
  const cleanPath = pathname.replace(/\/+$/, '') || '/';

  for (const lang of Object.keys(ui)) {
    const localizedPath = getLocalizedPath(cleanPath, lang as Lang);
    links.push({
      lang,
      href: `${site}${localizedPath}`,
    });
  }
  return links;
}
