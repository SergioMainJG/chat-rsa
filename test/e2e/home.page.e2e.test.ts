import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createServer } from '../../src/backend/shared/http/app.server.ts';

// The home page follows docs/design/home-page.md, and every page carries the icons from public/.

let server: ReturnType<typeof createServer>;

/** Sign-in and sign-up handlers; these tests only load pages and assets. */
async function unused(): Promise<Response> {
  return new Response(null, { status: 204 });
}

beforeAll(() => {
  server = createServer({ auth: { signIn: unused, signUp: unused }, port: 0 });
});

afterAll(async () => {
  await server.stop(true);
});

async function get(path: string): Promise<Response> {
  return fetch(new URL(path, server.url));
}

async function page(path: string): Promise<string> {
  const response = await get(path);
  expect(response.status).toBe(200);
  return response.text();
}

async function statusOf(path: string): Promise<number> {
  const response = await get(path);
  return response.status;
}

async function textOf(path: string): Promise<string> {
  const response = await get(path);
  return response.text();
}

describe('public icons', () => {
  test.each([
    ['/favicon.ico', 'image/'],
    ['/favicon.svg', 'image/svg+xml'],
    ['/favicon-16x16.png', 'image/png'],
    ['/favicon-32x32.png', 'image/png'],
    ['/apple-touch-icon.png', 'image/png'],
    ['/android-chrome-192x192.png', 'image/png'],
    ['/android-chrome-512x512.png', 'image/png'],
  ])('%s is served as %s', async (path, type) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type') ?? '').toStartWith(type);
    const body = await response.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
  });

  test('the web manifest names the app and uses the page colors', async () => {
    const response = await get('/site.webmanifest');
    expect(response.status).toBe(200);
    const manifest: { background_color: string; name: string; short_name: string; theme_color: string } =
      await response.json();
    expect(manifest.name).toBe('Komwasai');
    expect(manifest.short_name).toBe('Komwasai');
    expect(manifest.theme_color.toLowerCase()).toBe('#150e60');
    expect(manifest.background_color.toLowerCase()).toBe('#150e60');
  });

  test('the design mockup and the full-size logo are not published', async () => {
    expect(await statusOf('/design-landscape.png')).toBe(404);
    expect(await statusOf('/isotipo.png')).toBe(404);
  });

  test.each(['/', '/chat', '/sign-in', '/sign-up'])('%s links the favicons and the manifest', async (path) => {
    const html = await page(path);
    for (const [pattern, type] of [
      [/<link rel="icon" href="(?<href>[^"]+\.svg)" type="image\/svg\+xml"/u, 'image/svg+xml'],
      [/<link rel="icon" href="(?<href>[^"]+\.png)" type="image\/png" sizes="32x32"/u, 'image/png'],
      [/<link rel="apple-touch-icon" href="(?<href>[^"]+\.png)"/u, 'image/png'],
      [/<link rel="manifest" href="(?<href>[^"]+\.webmanifest)"/u, ''],
    ] as const) {
      const href = pattern.exec(html)?.groups?.href;
      expect(href).toBeDefined();
      // eslint-disable-next-line no-await-in-loop
      const response = await get(new URL(href ?? '', new URL(path, server.url)).pathname);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type') ?? '').toStartWith(type);
    }
  });
});

describe('home page (docs/design/home-page.md)', () => {
  test('is in Spanish and titled after the product', async () => {
    const html = await page('/');
    expect(html).toContain('<html lang="es">');
    expect(html).toMatch(/<title>Komwasai[^<]*<\/title>/u);
  });

  test('leads with the value statement as its only h1', async () => {
    const html = await page('/');
    expect(html.match(/<h1[\s>]/gu)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>\s*Solo tú y tus contactos pueden leer tus mensajes\.\s*<\/h1>/u);
  });

  test('offers one primary action, sign-up, and sign-in as a link', async () => {
    const html = await page('/');
    expect(html.match(/class="button-primary"/gu)).toHaveLength(1);
    expect(html).toMatch(/<a class="button-primary" href="\/es\/sign-up">Crear cuenta<\/a>/u);
    expect(html).toContain('href="/es/sign-in"');
    expect(html).not.toContain('Chatea ya');
  });

  test('shows how a message travels, and what the server can and cannot see', async () => {
    const html = await page('/');
    expect(html).toContain('<figure');
    expect(html).toContain('Cómo viaja un mensaje');
    expect(html).toContain('Qué ve nuestro servidor');
    expect(html).toContain('Lo que no puede ver');
    expect(html).toContain('Lo que sí ve');
    expect(html).toContain('Los nombres de las salas.');
  });

  test('makes none of the claims the backend contradicts', async () => {
    const served = await page('/');
    const html = served.toLowerCase();
    expect(html).not.toContain('no sabemos nada');
    expect(html).not.toContain('almacenamiento de claves');
    expect(html).not.toContain('todos los servicios protegidos');
    expect(html).not.toContain('rsa');
  });

  test('footer links only to pages that exist', async () => {
    const html = await page('/');
    const footer = /<footer[\s\S]*<\/footer>/u.exec(html)?.[0] ?? '';
    const hrefs = [...footer.matchAll(/href="(?<href>[^"]+)"/gu)].map((match) => match.groups?.href ?? '');
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      if (href.startsWith('#')) {
        expect(html).toContain(`id="${href.slice(1)}"`);
      } else {
        // eslint-disable-next-line no-await-in-loop
        expect(await statusOf(href)).toBe(200);
      }
    }
  });

  test('has no inline style attribute or inline script', async () => {
    const html = await page('/');
    expect(html).not.toMatch(/\sstyle="/u);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/u);
  });
});

/** Every stylesheet a page links, concatenated as served. */
async function stylesheetsOf(path: string): Promise<string> {
  const html = await page(path);
  const hrefs = [...html.matchAll(/<link rel="stylesheet"[^>]*\shref="(?<href>[^"]+)"/gu)].map(
    (match) => match.groups?.href ?? '',
  );
  const bodies = await Promise.all(
    hrefs.map(async (href) => textOf(new URL(href, new URL(path, server.url)).pathname)),
  );
  return bodies.join('\n');
}

describe('shared visual system (odd/tasks/app-visual-system.md)', () => {
  test.each(['/', '/chat', '/sign-in', '/sign-up'])('%s uses the system font and loads no web font', async (path) => {
    const css = await stylesheetsOf(path);
    expect(css).toContain('system-ui');
    expect(css).not.toContain('@font-face');
    expect(css).not.toContain('woff2');
    expect(css).not.toContain('Space Grotesk');
  });

  test.each(['/', '/chat', '/sign-in', '/sign-up'])(
    '%s opts in to cross-document view transitions, and out of them for reduced motion',
    async (path) => {
      // Bun serves the CSS minified, so compare without whitespace.
      const css = await stylesheetsOf(path).then((text) => text.replaceAll(/\s+/gu, ''));
      expect(css).toContain('@view-transition{navigation:auto;}');
      expect(css).toMatch(/@media\(prefers-reduced-motion:reduce\)\{[^@]*@view-transition\{navigation:none;\}/u);
      expect(css).toContain('view-transition-name:brand');
    },
  );

  test.each(['/', '/chat', '/sign-in', '/sign-up'])(
    '%s blocks the first render until an element it names has been parsed',
    async (path) => {
      const html = await page(path);
      const id = /<link rel="expect" href="#(?<id>[^"]+)" blocking="render"/u.exec(html)?.groups?.id;
      expect(id).toBeDefined();
      expect(html).toContain(`id="${id ?? ''}"`);
    },
  );

  test.each(['/', '/chat', '/sign-in', '/sign-up'])(
    '%s has one site header whose brand links home (the element that morphs between pages)',
    async (path) => {
      const html = await page(path);
      const header = /<header class="site-header[^"]*"[\s\S]*?<\/header>/u.exec(html)?.[0] ?? '';
      expect(html.match(/<header class="site-header/gu)).toHaveLength(1);
      // `fetch` follows the redirect to the default locale, Spanish.
      expect(header).toMatch(/<a class="brand" href="\/es"/u);
      expect(header).toContain('Komwasai');
    },
  );
});

describe('search engines and keyboard users', () => {
  test('robots.txt keeps crawlers out of the chat and the API', async () => {
    const response = await get('/robots.txt');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type') ?? '').toStartWith('text/plain');
    const text = await response.text();
    expect(text).toContain('User-agent: *');
    expect(text).toContain('Disallow: /chat');
    expect(text).toContain('Disallow: /api/');
  });

  test.each(['/', '/chat', '/sign-in', '/sign-up'])('%s has a description', async (path) => {
    expect(await textOf(path)).toMatch(/<meta\s+name="description"\s+content="[^"]{40,}"/u);
  });

  test('only the chat asks not to be indexed', async () => {
    expect(await textOf('/chat')).toMatch(/<meta\s+name="robots"\s+content="noindex"/u);
    for (const path of ['/', '/sign-in', '/sign-up']) {
      // eslint-disable-next-line no-await-in-loop -- three pages, checked one by one
      expect(await textOf(path)).not.toContain('noindex');
    }
  });

  test.each([
    ['/', '#main', 'id="main"'],
    ['/sign-in', '#main', 'id="main"'],
    ['/sign-up', '#main', 'id="main"'],
    ['/chat', '#composer-text', 'id="composer-text"'],
  ])('%s opens with a skip link to %s', async (path, href, target) => {
    const html = await textOf(path);
    const body = html.slice(html.indexOf('<body'));
    // The first link in the body, before the header.
    expect(/<a\s[^>]*>/u.exec(body)?.[0]).toContain(`href="${href}"`);
    expect(/<a\s[^>]*>/u.exec(body)?.[0]).toContain('class="skip-link"');
    expect(html).toContain(target);
  });

  test.each(['/', '/chat', '/sign-in', '/sign-up'])('%s shows the logo as a square WebP', async (path) => {
    const html = await textOf(path);
    const logo = /<img\s[^>]*class="brand-mark"[^>]*>/u.exec(html)?.[0] ?? '';
    expect(logo).toMatch(/src="[^"]+\.webp"/u);
    expect(logo).not.toContain('.png');
  });
});
