import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createServer } from '../../src/backend/shared/http/app.server.ts';
import { SECURITY_HEADERS } from '../../src/backend/shared/http/security-headers.ts';

// Every page lives under a locale prefix; unprefixed paths redirect to the visitor's locale.

let server: ReturnType<typeof createServer>;

/** Sign-in and sign-up handlers; these tests only load pages. */
async function unused(): Promise<Response> {
  return new Response(null, { status: 204 });
}

beforeAll(() => {
  server = createServer({ auth: { signIn: unused, signUp: unused }, port: 0 });
});

afterAll(async () => {
  await server.stop(true);
});

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(new URL(path, server.url), { headers, redirect: 'manual' });
}

const UNPREFIXED = [
  ['/', ''],
  ['/sign-in', '/sign-in'],
  ['/sign-up', '/sign-up'],
  ['/chat', '/chat'],
] as const;

describe('unprefixed paths', () => {
  test.each(UNPREFIXED)('%s redirects to Spanish by default', async (path, page) => {
    const response = await get(path);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/es${page}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Cookie, Accept-Language');
    expect(response.headers.get('set-cookie')).toBeNull();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  test.each(UNPREFIXED)('%s follows the browser language', async (path, page) => {
    const response = await get(path, { 'accept-language': 'en-US,en;q=0.9,es;q=0.5' });
    expect(response.headers.get('location')).toBe(`/en${page}`);
  });

  test('the lang cookie wins over the browser language', async () => {
    const response = await get('/chat', { 'accept-language': 'en', cookie: 'other=1; lang=es' });
    expect(response.headers.get('location')).toBe('/es/chat');
  });

  test('?lang= saves the choice for a year and opens that locale', async () => {
    const response = await get('/sign-in?lang=en', { 'accept-language': 'es', cookie: 'lang=es' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/en/sign-in');
    expect(response.headers.get('set-cookie')).toBe('lang=en; Path=/; Max-Age=31536000; Secure; SameSite=Lax');
  });

  test('an unknown ?lang= is ignored', async () => {
    const response = await get('/?lang=fr', { 'accept-language': 'en' });
    expect(response.headers.get('location')).toBe('/en');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  test('other query parameters are kept', async () => {
    const response = await get('/chat?lang=en&room=1');
    expect(response.headers.get('location')).toBe('/en/chat?room=1');
  });
});

describe('prefixed pages', () => {
  test.each(['/es', '/en', '/es/sign-in', '/en/sign-in', '/es/sign-up', '/en/sign-up', '/es/chat', '/en/chat'])(
    '%s is a page',
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') ?? '').toStartWith('text/html');
    },
  );

  test('an unsupported locale is not a page', async () => {
    const response = await get('/fr/chat');
    expect(response.status).toBe(404);
  });
});

async function textOf(path: string): Promise<string> {
  const response = await get(path);
  return response.text();
}

/** The header's language switcher link. */
function switcher(html: string): string {
  return /<a\s[^>]*data-lang-switch[^>]*>[^<]*<\/a\s*>/u.exec(html)?.[0] ?? '';
}

/** Attributes that carry structure; texts, links and labels are expected to differ by locale. */
const STRUCTURAL =
  /^(?:id|class|name|type|for|required|pattern|maxlength|autocomplete|tabindex|role|hidden|popover|popovertarget|aria-controls|aria-describedby|aria-live|data-[\w-]+)$/u;

/** Every element, in order, with its structural attributes. */
async function structureOf(html: string): Promise<string[]> {
  const elements: string[] = [];
  const rewriter = new HTMLRewriter().on('*', {
    element: (element) => {
      const attributes = [...element.attributes]
        .filter(([name]) => STRUCTURAL.test(name))
        .map(([name, value]) => `${name}=${value}`)
        .toSorted();
      elements.push(`${element.tagName}[${attributes.join(' ')}]`);
    },
  });
  await rewriter.transform(new Response(html)).text();
  return elements;
}

const PAGES = [
  ['home', '', '/'],
  ['sign-in', '/sign-in', '/sign-in'],
  ['sign-up', '/sign-up', '/sign-up'],
  ['chat', '/chat', '/chat'],
] as const;

describe('both locales of a page', () => {
  test.each(PAGES)('%s keeps the same structure in Spanish and English', async (_page, path) => {
    const spanish = await get(`/es${path}`);
    const english = await get(`/en${path}`);
    expect(await structureOf(await english.text())).toEqual(await structureOf(await spanish.text()));
  });

  test.each(PAGES)('%s declares its language', async (_page, path) => {
    const spanish = await get(`/es${path}`);
    const english = await get(`/en${path}`);
    expect(await spanish.text()).toContain('<html lang="es"');
    expect(await english.text()).toContain('<html lang="en"');
  });

  test.each(PAGES)('%s links to its other locale through the switcher', async (_page, path, unprefixed) => {
    const spanish = await textOf(`/es${path}`);
    const english = await textOf(`/en${path}`);
    expect(switcher(spanish)).toContain(`href="${unprefixed}?lang=en"`);
    expect(switcher(spanish)).toContain('hreflang="en"');
    expect(switcher(spanish)).toMatch(/>English<\/a/u);
    expect(switcher(english)).toContain(`href="${unprefixed}?lang=es"`);
    expect(switcher(english)).toContain('hreflang="es"');
    expect(switcher(english)).toMatch(/>Español<\/a/u);
  });

  test.each(PAGES)('%s links only to pages of its own locale', async (_page, path) => {
    for (const locale of ['es', 'en']) {
      // eslint-disable-next-line no-await-in-loop -- two locales, one after the other
      const response = await get(`/${locale}${path}`);
      // eslint-disable-next-line no-await-in-loop -- same
      const html = await response.text();
      const links = [...html.matchAll(/<a\s(?<attributes>[^>]*)>/gu)]
        .map((match) => match.groups?.attributes ?? '')
        .filter((attributes) => !attributes.includes('data-lang-switch') && !attributes.includes('class="skip-link"'))
        .map((attributes) => /href="(?<href>[^"#]*)/u.exec(attributes)?.groups?.href ?? '')
        .filter((href) => href !== '');
      for (const href of links) {
        expect(href === `/${locale}` || href.startsWith(`/${locale}/`), href).toBe(true);
      }
    }
  });
});
