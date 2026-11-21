// Locales and page paths shared by the server (which redirects unprefixed paths) and the pages
// (which link to each other and redirect in script). Every page lives under its locale prefix.

export const LOCALES = ['es', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'es';

/** Cookie holding the language the visitor picked with the switcher. */
export const LOCALE_COOKIE = 'lang';

/** Query parameter of the switcher links: `/sign-in?lang=en` saves `en` and opens `/en/sign-in`. */
export const LOCALE_QUERY = 'lang';

/** Each page's path after the locale prefix. */
export const PAGE_PATHS = {
  chat: '/chat',
  home: '',
  'sign-in': '/sign-in',
  'sign-up': '/sign-up',
} as const;

export type Page = keyof typeof PAGE_PATHS;

export const PAGES: readonly Page[] = ['home', 'sign-in', 'sign-up', 'chat'];

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

export function localePath(locale: Locale, page: Page): string {
  return `/${locale}${PAGE_PATHS[page]}`;
}

/** The locale prefix of `pathname` (`/en/chat` → `en`), or null without a supported one. */
export function localeOfPath(pathname: string): Locale | null {
  const prefix = pathname.split('/')[1] ?? '';
  return isLocale(prefix) ? prefix : null;
}

/**
 * The visitor's locale: the `lang` cookie when it names a supported locale, else the best-ranked
 * supported language of `Accept-Language` (by primary subtag, `q=0` refuses), else Spanish.
 */
export function negotiateLocale(cookie: null | string, acceptLanguage: null | string): Locale {
  if (isLocale(cookie)) {
    return cookie;
  }
  const ranked = (acceptLanguage ?? '')
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.split(';');
      const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
      return {
        index,
        language: tag.trim().toLowerCase().split('-')[0] ?? '',
        quality: q === undefined ? 1 : Number(q.slice(2)),
      };
    })
    .filter(({ quality }) => quality > 0)
    .toSorted((a, b) => b.quality - a.quality || a.index - b.index);
  return (
    ranked.map(({ language }) => language).find((language) => isLocale(language)) ?? DEFAULT_LOCALE
  );
}
