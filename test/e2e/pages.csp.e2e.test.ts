import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createServer } from '../../src/backend/shared/http/app.server.ts';

// Every page carries a Content-Security-Policy <meta> (route handlers cannot return HTML imports,
// so it cannot be a header). The only inline code is the route guard's <style>, allowed by hash.

const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"\s+content="(?<policy>[^"]*)"\s*\/?>/u;
const INLINE_STYLE = /<style>(?<css>[\s\S]*?)<\/style>/u;

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

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('base64');
}

/** The hash of the inline guard style exactly as /chat serves it (every guarded page shares it). */
async function guardStyleHash(): Promise<string> {
  const css = INLINE_STYLE.exec(await page('/chat'))?.groups?.css;
  if (css === undefined) {
    throw new Error('/chat has no inline style');
  }
  return sha256(css);
}

function policy(hash: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'sha256-${hash}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

describe('Content-Security-Policy', () => {
  test.each(['/', '/chat', '/sign-in', '/sign-up'])('%s carries the policy in a <meta>', async (path) => {
    const html = await page(path);
    const meta = CSP_META.exec(html);

    expect(meta?.groups?.policy).toBe(policy(await guardStyleHash()));
    // Before anything it governs: stylesheets, scripts and the inline style.
    expect(html.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(html.indexOf('<link'));
  });

  test.each(['/chat', '/sign-in', '/sign-up'])('the hash matches the inline style %s serves', async (path) => {
    const html = await page(path);
    const css = INLINE_STYLE.exec(html)?.groups?.css ?? '';

    expect(css).toContain("html[data-guard='pending'] body");
    expect(CSP_META.exec(html)?.groups?.policy).toContain(`'sha256-${sha256(css)}'`);
    // No other inline style or script the policy would block.
    expect(html.match(/<style>/gu)).toHaveLength(1);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u);
    expect(html).not.toMatch(/\sstyle="/u);
  });
});
