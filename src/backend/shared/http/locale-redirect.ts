// Unprefixed page paths (`/`, `/sign-in`, `/sign-up`, `/chat`) redirect to the visitor's locale:
// the `lang` cookie, else `Accept-Language`, else Spanish. The header switcher links here with
// `?lang=<locale>`, which saves that choice in the cookie first.
import {
  isLocale,
  LOCALE_COOKIE,
  LOCALE_QUERY,
  localePath,
  negotiateLocale,
  type Page,
  PAGE_PATHS,
  PAGES,
} from '../../../shared/i18n/i18n.locale.ts';
import { cookieOf } from './http.cookies.ts';
import { SECURITY_HEADERS } from './security-headers.ts';

const ONE_YEAR_SECONDS = 31_536_000;

function redirectTo(page: Page): (request: Request) => Response {
  return (request) => {
    const url = new URL(request.url);
    const chosen = url.searchParams.get(LOCALE_QUERY);
    url.searchParams.delete(LOCALE_QUERY);
    const locale = isLocale(chosen)
      ? chosen
      : negotiateLocale(cookieOf(request, LOCALE_COOKIE), request.headers.get('accept-language'));
    const headers = new Headers({
      ...SECURITY_HEADERS,
      // The answer depends on the cookie and the browser language: never cache it.
      'Cache-Control': 'no-store',
      Location: `${localePath(locale, page)}${url.search}`,
      Vary: 'Cookie, Accept-Language',
    });
    if (isLocale(chosen)) {
      // Not HttpOnly or Strict: it is only a preference, read on top-level navigations.
      headers.set(
        'Set-Cookie',
        `${LOCALE_COOKIE}=${chosen}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; Secure; SameSite=Lax`,
      );
    }
    return new Response(null, { headers, status: 302 });
  };
}

/** One redirect route per page, at its unprefixed path (`/` for the home page). */
export function localeRedirectRoutes(): Record<string, (request: Request) => Response> {
  return Object.fromEntries(
    PAGES.map((page) => [PAGE_PATHS[page] === '' ? '/' : PAGE_PATHS[page], redirectTo(page)]),
  );
}
