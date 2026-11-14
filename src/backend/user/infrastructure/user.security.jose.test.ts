import { describe, expect, test } from 'bun:test';
import { SignJWT } from 'jose';

import { User } from '../domain/user.entity.ts';
import { PasswordHash, UserId, UserName } from '../domain/user.value-objects.ts';
import { JoseTokenIssuer, JoseTokenVerifier } from './user.security.jose.ts';

const SECRET = 'unit-secret';
const ALICE = new User(UserId.restore(7), UserName.restore('alice'), PasswordHash.restore('x'));

describe('JoseTokenVerifier', () => {
  test('returns the subject, name and expiry of a token it can verify', async () => {
    const token = await new JoseTokenIssuer(SECRET).issue(ALICE);
    const claims = await new JoseTokenVerifier(SECRET).verify(token);
    expect(claims?.userId).toBe(UserId.restore(7));
    expect(claims?.name).toBe('alice');
    expect((claims?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(59 * 60 * 1000);
  });

  test('rejects a token signed with another secret', async () => {
    const token = await new JoseTokenIssuer('other').issue(ALICE);
    expect(await new JoseTokenVerifier(SECRET).verify(token)).toBeNull();
  });

  test('rejects an expired token', async () => {
    const token = await new JoseTokenIssuer(SECRET, '-1s').issue(ALICE);
    expect(await new JoseTokenVerifier(SECRET).verify(token)).toBeNull();
  });

  test('rejects garbage and a token whose subject is not a user id', async () => {
    const odd = await new SignJWT({ name: 'alice' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('admin')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));
    expect(await new JoseTokenVerifier(SECRET).verify('not.a.jwt')).toBeNull();
    expect(await new JoseTokenVerifier(SECRET).verify(odd)).toBeNull();
  });

  test('carries a new session id per issue, or the one it is given', async () => {
    const issuer = new JoseTokenIssuer(SECRET);
    const verifier = new JoseTokenVerifier(SECRET);

    const first = await verifier.verify(await issuer.issue(ALICE));
    const second = await verifier.verify(await issuer.issue(ALICE));
    const kept = await verifier.verify(await issuer.issue(ALICE, 'session-1'));

    expect(first?.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second?.sessionId).not.toBe(first?.sessionId);
    expect(kept?.sessionId).toBe('session-1');
  });

  test('rejects a token without a session id', async () => {
    const legacy = await new SignJWT({ name: 'alice' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('7')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));
    expect(await new JoseTokenVerifier(SECRET).verify(legacy)).toBeNull();
  });

  test('rejects a token signed with another algorithm', async () => {
    const none = `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa(JSON.stringify({ sub: '7' }))}.`;
    expect(await new JoseTokenVerifier(SECRET).verify(none)).toBeNull();
  });
});
