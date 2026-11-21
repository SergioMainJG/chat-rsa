import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createServer } from '../../src/backend/shared/http/app.server.ts';
import { SECURITY_HEADERS } from '../../src/backend/shared/http/security-headers.ts';
import { buildPages, PAGE_SOURCES } from '../../src/backend/shared/http/static-pages.ts';

// Production serves the pages bundled by buildPages: security headers, precompressed text, ETag
// revalidation, immutable hashed assets, and no request for an empty script.

let server: ReturnType<typeof createServer>;

/** Sign-in and sign-up handlers; these tests only load pages and assets. */
async function unused(): Promise<Response> {
  return new Response(null, { status: 204 });
}

beforeAll(async () => {
  server = createServer({
    auth: { signIn: unused, signUp: unused },
    pages: await buildPages('https://chat.example.com/'),
    port: 0,
  });
});

afterAll(async () => {
  await server.stop(true);
});

function expectSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(response.headers.get(name)).toBe(value);
  }
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(new URL(path, server.url), { decompress: false, headers });
}

/** Every same-origin script and stylesheet the page references. */
function assetsOf(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="(?<path>\/[^"#]+\.(?:js|css))"/gu)].map((match) => match.groups?.path ?? '');
}

describe('production pages', () => {
  test.each(Object.keys(PAGE_SOURCES))('%s carries the security headers and revalidates', async (path) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/html');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expectSecurityHeaders(response);
    // The page's own CSP stays in its <meta>.
    expect(await response.text()).toContain('http-equiv="Content-Security-Policy"');
  });

  test('a page is sent with brotli, gzip or as is, as the client asks', async () => {
    const br = await get('/chat', { 'accept-encoding': 'gzip, br' });
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('vary')).toBe('Accept-Encoding');
    const gzip = await get('/chat', { 'accept-encoding': 'gzip' });
    expect(gzip.headers.get('content-encoding')).toBe('gzip');
    const plain = await get('/chat', { 'accept-encoding': 'identity' });
    expect(plain.headers.get('content-encoding')).toBeNull();
    const html = await plain.text();
    expect(Bun.gunzipSync(new Uint8Array(await gzip.arrayBuffer()))).toEqual(new TextEncoder().encode(html));
  });

  test('an unchanged page answers 304 to its ETag', async () => {
    const first = await get('/sign-in');
    const etag = first.headers.get('etag');
    expect(etag).not.toBeNull();
    const again = await get('/sign-in', { 'if-none-match': etag ?? '' });
    expect(again.status).toBe(304);
    expectSecurityHeaders(again);
  });

  test('scripts and styles are cached forever and carry the security headers', async () => {
    const chat = await get('/chat');
    const assets = assetsOf(await chat.text());
    expect(assets.length).toBeGreaterThanOrEqual(2);
    for (const asset of assets) {
      // eslint-disable-next-line no-await-in-loop -- a handful of assets, checked one by one
      const response = await get(asset);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expectSecurityHeaders(response);
    }
  });

  test('the home page, which has no script, requests none', async () => {
    const home = await get('/');
    const html = await home.text();
    expect(html).not.toContain('<script');
  });

  test('the API and unknown routes carry the security headers too', async () => {
    expectSecurityHeaders(await get('/api/nope'));
    expectSecurityHeaders(await get('/favicon.ico'));
  });
});

describe('search engine links', () => {
  test.each([
    ['/es', '/es', '/en', '/'],
    ['/en/sign-in', '/en/sign-in', '/es/sign-in', '/sign-in'],
    ['/es/sign-up', '/es/sign-up', '/en/sign-up', '/sign-up'],
  ])('%s names its canonical URL and every locale, absolute', async (path, canonical, other, unprefixed) => {
    const response = await get(path, { 'accept-encoding': 'identity' });
    const html = await response.text();
    const origin = 'https://chat.example.com';
    expect(html).toContain(`<link rel="canonical" href="${origin}${canonical}">`);
    expect(html).toContain(`href="${origin}${canonical}">`);
    expect(html).toContain(`href="${origin}${other}">`);
    expect(html).toContain(`<link rel="alternate" hreflang="x-default" href="${origin}${unprefixed}">`);
    expect(html.match(/<link rel="alternate" hreflang="(?:es|en)"/gu)).toHaveLength(2);
  });

  test('the chat, which is not indexed, names none', async () => {
    const response = await get('/es/chat', { 'accept-encoding': 'identity' });
    const html = await response.text();
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('rel="alternate"');
  });
});
