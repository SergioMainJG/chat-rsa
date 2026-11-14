import { afterEach, describe, expect, test } from 'bun:test';

import {
  BEARER_PREFIX,
  CloseCode,
  SOCKET_PATH,
  SOCKET_PROTOCOL,
} from '../../../shared/contracts/messaging.socket.contract.ts';
import {
  ALICE,
  APP_ORIGIN,
  closeCode,
  connect,
  connectWithCookie,
  HOUR,
  SIGNED_OUT_MEMORY_MS,
  START,
  start,
  stopHarness,
  upgradeRequest,
} from './messaging.socket.harness.test-support.ts';

// S4: browsers authenticate the socket with the session cookie, and a REST refresh renews it.
// S6: a socket of a session that was already signed out is closed as soon as it opens.

afterEach(stopHarness);

describe('cookie authentication at upgrade', () => {
  test('a browser socket with only chat-rsa.v1, the session cookie and an allowed Origin opens', async () => {
    const harness = start();
    const alice = await connectWithCookie(harness, 'alice');

    expect(await alice.next('ready')).toMatchObject({ type: 'ready', userId: ALICE });
    expect(alice.socket.protocol).toBe(SOCKET_PROTOCOL);
    expect(harness.gateway.connectionCount()).toBe(1);
  });

  test.each([
    ['without Origin', {}],
    ['with a foreign Origin', { origin: 'https://evil.example' }],
  ])('a cookie upgrade %s answers 403 and opens nothing', async (_case, extra) => {
    const harness = start();
    const response = await harness.gateway.upgrade(
      upgradeRequest(harness, SOCKET_PROTOCOL, { cookie: 'chat_rsa_session=alice', ...extra }),
      harness.server,
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ path: SOCKET_PATH, statusCode: 403 });
    expect(harness.gateway.connectionCount()).toBe(0);
  });

  test('a cookie with an invalid token answers 401, even from an allowed Origin', async () => {
    const harness = start();
    const response = await harness.gateway.upgrade(
      upgradeRequest(harness, SOCKET_PROTOCOL, {
        cookie: 'chat_rsa_session=forged',
        origin: APP_ORIGIN,
      }),
      harness.server,
    );

    expect(response?.status).toBe(401);
  });

  test('a bearer subprotocol still opens without Origin, and wins over a cookie', async () => {
    const harness = start();
    const response = await harness.gateway.upgrade(
      upgradeRequest(harness, `${SOCKET_PROTOCOL}, ${BEARER_PREFIX}forged`, {
        cookie: 'chat_rsa_session=alice',
        origin: APP_ORIGIN,
      }),
      harness.server,
    );
    const bob = await connect(harness, 'bob');

    expect(response?.status).toBe(401);
    expect(bob.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('renewSession (after POST /api/auth/refresh)', () => {
  test("pushes auth.refreshed to the session's sockets and moves their expiry; other sessions are untouched", async () => {
    const harness = start();
    const laptop = await connectWithCookie(harness, 'alice-short');
    const phone = await connect(harness, 'alice-phone');
    await laptop.next('ready');

    harness.gateway.renewSession('s1', new Date(START + 20_000));

    expect(await laptop.next('auth.refreshed')).toEqual({
      expiresAt: new Date(START + 20_000).toISOString(),
      type: 'auth.refreshed',
    });
    harness.scheduler.advance(10_000);
    await laptop.barrier();
    expect(laptop.socket.readyState).toBe(WebSocket.OPEN);
    await phone.barrier();
    expect(phone.count('auth.refreshed')).toBe(0);

    harness.scheduler.advance(10_000);
    expect(await closeCode(laptop)).toBe(CloseCode.AuthFailed);
    expect(phone.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('sign-out race (S6)', () => {
  test('a socket of an already closed session is closed with 4001 as soon as it opens', async () => {
    const harness = start();
    harness.gateway.closeSession('s1');

    const late = await connectWithCookie(harness, 'alice');
    const phone = await connect(harness, 'alice-phone');

    expect(await late.next('error')).toMatchObject({ code: 'auth_failed', type: 'error' });
    expect(await closeCode(late)).toBe(CloseCode.AuthFailed);
    expect(late.count('ready')).toBe(0);
    await phone.barrier();
    expect(phone.socket.readyState).toBe(WebSocket.OPEN);
    expect(harness.gateway.connectionCount()).toBe(1);
  });

  test('the closed session is remembered for one token lifetime, then forgotten', async () => {
    const harness = start();
    // A token of session s1 that outlives the memory, so only the memory decides.
    harness.verifier.add('alice-long', ALICE, START + 3 * HOUR);
    harness.gateway.closeSession('s1');

    harness.scheduler.advance(SIGNED_OUT_MEMORY_MS - 1);
    const stillRemembered = await connectWithCookie(harness, 'alice-long');
    expect(await closeCode(stillRemembered)).toBe(CloseCode.AuthFailed);

    harness.scheduler.advance(1);
    const forgotten = await connect(harness, 'alice-long');
    await forgotten.barrier();
    expect(forgotten.socket.readyState).toBe(WebSocket.OPEN);
  });
});
