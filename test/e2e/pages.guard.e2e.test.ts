import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createServer } from '../../src/backend/shared/http/app.server.ts';

// The route guard hides guarded pages before the first paint. That only works when the hiding rule
// is inline in the served HTML: an external stylesheet may load after the browser has painted.

const GUARD_ATTRIBUTE = /<html[^>]*\bdata-guard="pending"/u;
const INLINE_GUARD_RULE = /<style>[^<]*html\[data-guard='pending'\] body\s*\{\s*visibility:\s*hidden;/u;

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

async function page(path: string): Promise<string> {
  const response = await fetch(new URL(path, server.url));
  expect(response.status).toBe(200);
  return response.text();
}

describe('guarded pages', () => {
  test.each(['/es/chat', '/en/chat', '/es/sign-in', '/en/sign-in', '/es/sign-up', '/en/sign-up'])(
    '%s ships hidden, with the hiding rule inline',
    async (path) => {
      const html = await page(path);

      expect(html).toMatch(GUARD_ATTRIBUTE);
      expect(html).toMatch(INLINE_GUARD_RULE);
      expect(html.indexOf('<style>')).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
    },
  );

  test('the public home page is not guarded', async () => {
    expect(await page('/es')).not.toMatch(GUARD_ATTRIBUTE);
    expect(await page('/en')).not.toMatch(GUARD_ATTRIBUTE);
  });
});
