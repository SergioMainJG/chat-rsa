import { describe, expect, test } from 'bun:test';

import { JoseTokenVerifier } from '../../src/backend/user/infrastructure/user.security.jose.ts';
import { sessionTokenOf } from '../support/session-cookie.test-support.ts';
import { FAKE_JWT_SECRET, type Sabotage, startFakeAuthServer } from './support/fake-auth-server.ts';
import {
  failedChecks,
  K6_TIMEOUT_MS,
  type ProbeRun,
  runK6Against,
  THRESHOLD_FAILED,
} from './support/k6-probe.test-support.ts';

// BUG-CRITICAL-04 (load run 2) and BUG-LOAD-RUN3-CRIT-03: the auth suite must reject a token whose
// claims the messaging endpoints would refuse (`sub`, `exp`, `name`, `sid`, `sst`, HS256), and the honest fake must issue tokens the
// real JoseTokenVerifier accepts, so the fake stays faithful to the contract `messages` relies on.

const AUTH_CHECKS = [
  'sign-in returns {user} and the session cookies',
  'sign-up returns {user} and the session cookies',
];

async function runAgainst(sabotage: Sabotage): Promise<ProbeRun> {
  const fake = startFakeAuthServer(sabotage);
  try {
    return await runK6Against(fake);
  } finally {
    await fake.stop();
  }
}

async function signUp(baseUrl: string, name: string): Promise<{ token: string; user: { id: number } }> {
  const response = await fetch(`${baseUrl}/api/auth/sign-up`, {
    body: JSON.stringify({ name, password: 'correct-Horse-battery-st4ple' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  expect(response.status).toBe(201);
  const body: { user: { id: number } } = await response.json();
  return { token: sessionTokenOf(response), user: body.user };
}

describe('fake auth server tokens', () => {
  test('the honest token passes the real JoseTokenVerifier with the user id and name', async () => {
    const fake = startFakeAuthServer('honest');
    try {
      const { token, user } = await signUp(fake.baseUrl, 'jwtclaims1');
      const claims = await new JoseTokenVerifier(FAKE_JWT_SECRET).verify(token);
      expect(claims).toMatchObject({ name: 'jwtclaims1', userId: user.id });
      expect(claims?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await fake.stop();
    }
  });

  test.each(['broken-jwt-claims', 'jwt-expired', 'jwt-wrong-alg', 'jwt-no-sid', 'jwt-no-sst'] as const)(
    'the %s token is one the real verifier refuses',
    async (sabotage) => {
      const fake = startFakeAuthServer(sabotage);
      try {
        const { token } = await signUp(fake.baseUrl, 'jwtclaims2');
        expect(await new JoseTokenVerifier(FAKE_JWT_SECRET).verify(token)).toBeNull();
      } finally {
        await fake.stop();
      }
    },
  );
});

describe('k6 auth suite against tokens with broken claims', () => {
  test.each([
    ['broken-jwt-claims', 'a signed HS256 token without exp'],
    ['jwt-expired', 'a token whose exp is in the past'],
    ['jwt-not-json', 'three base64url segments that are not JSON ("undefined.undefined.undefined")'],
    ['jwt-wrong-alg', 'a token signed with HS512'],
    ['jwt-wrong-name', 'a token whose name is another user'],
    ['jwt-wrong-subject', 'a token whose sub is another user'],
    ['jwt-no-sid', 'a token without the session id (sid)'],
    ['jwt-no-sst', 'a token without the session start (sst)'],
  ] as const)(
    'rejects %s (%s)',
    async (sabotage) => {
      const outcome = await runAgainst(sabotage);

      expect(outcome.exitCode).toBe(THRESHOLD_FAILED);
      for (const name of AUTH_CHECKS) {
        expect(failedChecks(outcome)).toContain(name);
      }
    },
    K6_TIMEOUT_MS,
  );
});
