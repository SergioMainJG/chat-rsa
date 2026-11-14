import { describe, expect, test } from 'bun:test';

import type { AuthSession } from '../application/user.session.ts';

import { ok } from '../../shared/domain/result.ts';
import { MAX_JSON_BODY_BYTES } from '../../shared/http/http.json-body.ts';
import { type AuthUseCase, createAuthController } from './user.controller.ts';

// bugs/security.bug.xml, lead 3: sign-in and sign-up read their JSON body with an uncapped
// request.json(), while every other JSON route refuses more than 64 KiB. Both auth routes are
// public, so the cap must hold before anything else reads the body.

const session: AuthSession = {
  expiresAt: new Date(1_800_000_000_000),
  token: 'jwt',
  user: { id: 1, name: 'alice' },
};
const TOO_LARGE = `Request body must be at most ${MAX_JSON_BODY_BYTES} bytes`;

function spyController(): {
  readonly calls: () => number;
  readonly controller: ReturnType<typeof createAuthController>;
} {
  let calls = 0;
  const spy: AuthUseCase = {
    execute: async () => {
      calls += 1;
      return ok(session);
    },
  };
  const controller = createAuthController(
    { signIn: spy, signUp: spy },
    {
      error: () => {
        // Nothing is logged for a refused body.
      },
    },
    3600,
  );
  return { calls: () => calls, controller };
}

/** A JSON object of exactly `bytes` bytes. */
function jsonOfSize(bytes: number): string {
  const frame = JSON.stringify({ name: 'alice', password: '' });
  return JSON.stringify({ name: 'alice', password: 'x'.repeat(bytes - frame.length) });
}

/** A body sent as a stream, without a Content-Length the server could check first. */
function streamed(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        controller.enqueue(bytes.slice(offset, offset + 8192));
      }
      controller.close();
    },
  });
}

describe.each(['signIn', 'signUp'] as const)('%s body cap', (route) => {
  test('a body one byte over 64 KiB is refused with 413 before the use case runs', async () => {
    const { calls, controller } = spyController();
    const body = jsonOfSize(MAX_JSON_BODY_BYTES + 1);

    const response = await controller[route](
      new Request('http://localhost/api/auth/x', {
        body,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ message: TOO_LARGE, statusCode: 413 });
    expect(calls()).toBe(0);
  });

  test('a streamed body with no Content-Length is cut off at the cap too', async () => {
    const { calls, controller } = spyController();

    const response = await controller[route](
      new Request('http://localhost/api/auth/x', {
        body: streamed(jsonOfSize(MAX_JSON_BODY_BYTES * 4)),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ message: TOO_LARGE, statusCode: 413 });
    expect(calls()).toBe(0);
  });

  test('a body of exactly 64 KiB is still read', async () => {
    const { calls, controller } = spyController();

    const response = await controller[route](
      new Request('http://localhost/api/auth/x', {
        body: jsonOfSize(MAX_JSON_BODY_BYTES),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(response.status).not.toBe(413);
    expect(calls()).toBe(1);
  });
});
