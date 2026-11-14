import { describe, expect, test } from 'bun:test';

import { UnauthorizedError } from '../../shared/domain/app.error.ts';
import { User } from '../domain/user.entity.ts';
import { PasswordHash, UserId, UserName } from '../domain/user.value-objects.ts';
import { UserRepositoryImpl } from '../infrastructure/user.repository.impl.ts';
import { JoseTokenIssuer, JoseTokenVerifier } from '../infrastructure/user.security.jose.ts';
import { InMemorySessionRevocations, InMemoryUserDatasource } from './user.fakes.test-support.ts';
import { RefreshUseCase } from './user.refresh.use-case.ts';
import { RevocationAwareTokenVerifier, SignOutUseCase } from './user.sign-out.use-case.ts';

const SECRET = 'sign-out-secret';
const issuer = new JoseTokenIssuer(SECRET);

async function setup(): Promise<{
  closed: string[];
  datasource: InMemoryUserDatasource;
  revocations: InMemorySessionRevocations;
  signOut: SignOutUseCase;
  user: User;
  verifier: RevocationAwareTokenVerifier;
}> {
  const datasource = new InMemoryUserDatasource();
  const user = await datasource.create({
    name: UserName.restore('alice'),
    passwordHash: PasswordHash.restore('hash'),
  });
  const revocations = new InMemorySessionRevocations();
  const verifier = new RevocationAwareTokenVerifier(new JoseTokenVerifier(SECRET), revocations);
  const closed: string[] = [];
  const signOut = new SignOutUseCase(verifier, revocations, (sessionId) => {
    closed.push(sessionId);
  });
  return { closed, datasource, revocations, signOut, user, verifier };
}

async function tokenOf(user: User, sessionId: string): Promise<string> {
  const { token } = await issuer.issue(user, { id: sessionId, startedAt: new Date() });
  return token;
}

describe('SignOutUseCase', () => {
  test('revokes the whole session: the token, tokens refreshed from it, and its refresh', async () => {
    const { closed, datasource, signOut, user, verifier } = await setup();
    const token = await tokenOf(user, 'session-a');
    const refreshUseCase = new RefreshUseCase(verifier, new UserRepositoryImpl(datasource), issuer, {
      sessionMaxAgeSeconds: 604_800,
    });
    const refreshed = await refreshUseCase.execute(token);
    if (!refreshed.ok) {
      throw refreshed.error;
    }

    expect(await signOut.execute(token)).toEqual({ ok: true, value: null });

    expect(await verifier.verify(token)).toBeNull();
    expect(await verifier.verify(refreshed.value.token)).toBeNull();
    const again = await refreshUseCase.execute(refreshed.value.token);
    expect(again.ok ? undefined : again.error).toBeInstanceOf(UnauthorizedError);
    expect(closed).toEqual(['session-a']);
  });

  test('leaves the other sessions of the same user signed in', async () => {
    const { signOut, user, verifier } = await setup();
    const phone = await tokenOf(user, 'phone');

    await signOut.execute(await tokenOf(user, 'laptop'));

    expect(await verifier.verify(phone)).toMatchObject({ sessionId: 'phone', userId: UserId.restore(1) });
  });

  test('refuses an invalid or already signed-out token with 401 and revokes nothing', async () => {
    const { closed, revocations, signOut, user } = await setup();
    const token = await tokenOf(user, 'session-b');
    await signOut.execute(token);

    for (const bad of ['not.a.jwt', token]) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      const result = await signOut.execute(bad);
      expect(result.ok ? undefined : result.error).toBeInstanceOf(UnauthorizedError);
    }
    expect([...revocations.revoked]).toEqual(['session-b']);
    expect(closed).toEqual(['session-b']);
  });
});

describe('RevocationAwareTokenVerifier', () => {
  test('refuses every token when the revocation list cannot be read (fails closed)', async () => {
    const { revocations, user, verifier } = await setup();
    const token = await tokenOf(user, 'session-c');
    revocations.failing = true;

    expect(await verifier.verify(token)).toBeNull();
  });

  test('passes the claims of a token whose session was not revoked', async () => {
    const { user, verifier } = await setup();
    const token = await tokenOf(new User(user.id, user.name, user.passwordHash), 'session-d');

    expect(await verifier.verify(token)).toMatchObject({ name: 'alice', sessionId: 'session-d' });
  });
});
