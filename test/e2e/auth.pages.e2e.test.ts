import { afterAll, describe, expect, test } from 'bun:test';

import { createServer } from '../../src/backend/shared/http/app.server.ts';

// The pages are static HTML imports; the API is not exercised here, so a fake controller is enough.
const unused = async (): Promise<Response> => new Response(null, { status: 500 });
const server = createServer({ auth: { signIn: unused, signUp: unused }, port: 0 });

afterAll(async () => {
  await server.stop(true);
});

async function page(path: string): Promise<{ readonly html: string; readonly response: Response }> {
  const response = await fetch(new URL(path, server.url));
  return { html: await response.text(), response };
}

const TOGGLE = {
  en: { hide: 'Hide password', show: 'Show password' },
  es: { hide: 'Ocultar contraseña', show: 'Mostrar contraseña' },
} as const;

describe.each([
  ['/en/sign-in', '/api/auth/sign-in', 'current-password', 'Sign in', 'en'],
  ['/en/sign-up', '/api/auth/sign-up', 'new-password', 'Create account', 'en'],
  ['/es/sign-in', '/api/auth/sign-in', 'current-password', 'Entrar', 'es'],
  ['/es/sign-up', '/api/auth/sign-up', 'new-password', 'Crear cuenta', 'es'],
] as const)('GET %s', (path, action, passwordAutocomplete, heading, locale) => {
  test('serves an HTML page', async () => {
    const { response } = await page(path);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/html');
  });

  test('has a form that posts to its API route with native validation matching the server rules', async () => {
    const { html } = await page(path);

    expect(html).toContain(`<h1>${heading}</h1>`);
    expect(html).toMatch(new RegExp(`<form[^>]*action="${action}"`, 'u'));
    expect(html).toMatch(/<input[^>]*name="name"[^>]*required/u);
    expect(html).toMatch(/<input[^>]*name="name"[^>]*maxlength="64"/u);
    expect(html).toMatch(/<input[^>]*name="name"[^>]*autocomplete="username"/u);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*name="password"[^>]*required/u);
    expect(html).toMatch(/<input[^>]*name="password"[^>]*maxlength="256"/u);
    expect(html).toMatch(new RegExp(`<input[^>]*name="password"[^>]*autocomplete="${passwordAutocomplete}"`, 'u'));
  });

  test('has an accessible visibility toggle for the password field, hidden by default', async () => {
    const { html } = await page(path);

    expect(html).toMatch(/<input[^>]*type="password"[^>]*name="password"/u);
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*aria-controls="password"[^>]*aria-pressed="false"[^>]*data-password-toggle/u,
    );
    expect(html).toMatch(
      new RegExp(`data-password-toggle[^>]*>\\s*<span class="when-hidden">${TOGGLE[locale].show}</span>`, 'u'),
    );
    expect(html).toContain(`<span class="when-shown">${TOGGLE[locale].hide}</span>`);
  });

  test('loads the bundled form script as a module', async () => {
    const { html } = await page(path);

    expect(html).toMatch(/<script type="module"[^>]*src="[^"]+\.js"/u);
  });
});

test.each(['en', 'es'])('the %s sign-in and sign-up pages link to each other', async (locale) => {
  const signIn = await page(`/${locale}/sign-in`);
  const signUp = await page(`/${locale}/sign-up`);

  expect(signIn.html).toContain(`href="/${locale}/sign-up"`);
  expect(signUp.html).toContain(`href="/${locale}/sign-in"`);
});
