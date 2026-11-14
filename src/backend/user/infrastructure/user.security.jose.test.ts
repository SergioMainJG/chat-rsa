import { describe, expect, test } from 'bun:test';
import { SignJWT } from 'jose';

import type { SessionRef } from '../domain/user.security.ts';

import { User } from '../domain/user.entity.ts';
import { PasswordHash, UserId, UserName } from '../domain/user.value-objects.ts';
import { JoseTokenIssuer, JoseTokenVerifier } from './user.security.jose.ts';

const SECRET = 'unit-secret';
const KEY = new TextEncoder().encode(SECRET);
const ALICE = new User(UserId.restore(7), UserName.restore('alice'), PasswordHash.restore('x'));

async function signed(extra: Record<string, unknown>): Promise<string> {
  return new SignJWT({ name: 'alice', sid: 'session-1', ...extra })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('7')
    .setExpirationTime('1h')
    .sign(KEY);
}

async function tokenOf(issuer: JoseTokenIssuer, session?: SessionRef): Promise<string> {
  const { token } = await issuer.issue(ALICE, session);
  return token;
}

describe('JoseTokenVerifier', () => {
  test('returns the subject, name, expiry and session start of a token it can verify', async () => {
    const before = Math.floor(Date.now() / 1000) * 1000;
    const issued = await new JoseTokenIssuer(SECRET).issue(ALICE);
    const claims = await new JoseTokenVerifier(SECRET).verify(issued.token);
    expect(claims?.userId).toBe(UserId.restore(7));
    expect(claims?.name).toBe('alice');
    expect((claims?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(issued.expiresAt).toEqual(claims?.expiresAt ?? new Date(0));
    expect(claims?.sessionStartedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(claims?.sessionStartedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('rejects a token signed with another secret', async () => {
    const { token } = await new JoseTokenIssuer('other').issue(ALICE);
    expect(await new JoseTokenVerifier(SECRET).verify(token)).toBeNull();
  });

  test('rejects an expired token', async () => {
    const { token } = await new JoseTokenIssuer(SECRET, '-1s').issue(ALICE);
    expect(await new JoseTokenVerifier(SECRET).verify(token)).toBeNull();
  });

  test('rejects garbage and a token whose subject is not a user id', async () => {
    const odd = await new SignJWT({ name: 'alice', sid: 's', sst: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('admin')
      .setExpirationTime('1h')
      .sign(KEY);
    expect(await new JoseTokenVerifier(SECRET).verify('not.a.jwt')).toBeNull();
    expect(await new JoseTokenVerifier(SECRET).verify(odd)).toBeNull();
  });

  test('carries a new session per issue, or the session (id and start) it is given', async () => {
    const issuer = new JoseTokenIssuer(SECRET);
    const verifier = new JoseTokenVerifier(SECRET);
    const startedAt = new Date('2026-11-10T08:00:00.000Z');

    const first = await verifier.verify(await tokenOf(issuer));
    const second = await verifier.verify(await tokenOf(issuer));
    const kept = await verifier.verify(await tokenOf(issuer, { id: 'session-1', startedAt }));

    expect(first?.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second?.sessionId).not.toBe(first?.sessionId);
    expect(kept?.sessionId).toBe('session-1');
    expect(kept?.sessionStartedAt).toEqual(startedAt);
  });

  test('rejects a token without a session id', async () => {
    const legacy = await new SignJWT({ name: 'alice', sst: 1_700_000_000 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('7')
      .setExpirationTime('1h')
      .sign(KEY);
    expect(await new JoseTokenVerifier(SECRET).verify(legacy)).toBeNull();
  });

  test('rejects a token without a numeric session start (sst)', async () => {
    const verifier = new JoseTokenVerifier(SECRET);
    expect(await verifier.verify(await signed({}))).toBeNull();
    expect(await verifier.verify(await signed({ sst: '1700000000' }))).toBeNull();
    expect(await verifier.verify(await signed({ sst: 1_700_000_000 }))).toMatchObject({
      sessionStartedAt: new Date(1_700_000_000_000),
    });
  });

  test('rejects a token signed with another algorithm', async () => {
    const none = `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa(JSON.stringify({ sub: '7' }))}.`;
    expect(await new JoseTokenVerifier(SECRET).verify(none)).toBeNull();
  });
});
