import { beforeEach, describe, expect, test } from 'bun:test';

import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../../shared/domain/app.error.ts';
import { PasswordHash, UserName } from '../domain/user.value-objects.ts';
import { UserRepositoryImpl } from '../infrastructure/user.repository.impl.ts';
import { JoseTokenIssuer, JoseTokenVerifier } from '../infrastructure/user.security.jose.ts';
import {
  FakePasswordHasher,
  FakeTokenIssuer,
  InMemoryUserDatasource,
  StaleReadUserDatasource,
  STRONG_PASSWORD,
} from './user.fakes.test-support.ts';
import { LookupUserUseCase } from './user.lookup.use-case.ts';
import { RefreshUseCase } from './user.refresh.use-case.ts';
import { SignInUseCase } from './user.sign-in.use-case.ts';
import { SignUpUseCase } from './user.sign-up.use-case.ts';

let datasource: InMemoryUserDatasource;
let hasher: FakePasswordHasher;
let signUp: SignUpUseCase;
let signIn: SignInUseCase;

beforeEach(() => {
  datasource = new InMemoryUserDatasource();
  hasher = new FakePasswordHasher();
  const users = new UserRepositoryImpl(datasource);
  signUp = new SignUpUseCase(users, hasher, new FakeTokenIssuer());
  signIn = new SignInUseCase(users, hasher, new FakeTokenIssuer());
});

describe('SignUpUseCase', () => {
  test('returns ConflictError as a Result when another sign-up wins the race after the pre-check', async () => {
    const racing = new StaleReadUserDatasource();
    const racingSignUp = new SignUpUseCase(new UserRepositoryImpl(racing), hasher, new FakeTokenIssuer());
    await racingSignUp.execute({ name: 'alice', password: STRONG_PASSWORD });

    const result = await racingSignUp.execute({ name: 'alice', password: STRONG_PASSWORD });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error).toBeInstanceOf(ConflictError);
    expect(racing.users).toHaveLength(1);
  });

  test('still throws unexpected datasource failures instead of hiding them in a Result', async () => {
    const failure = new Error('connection reset');
    const broken = new InMemoryUserDatasource();
    broken.create = async () => {
      throw failure;
    };
    const brokenSignUp = new SignUpUseCase(new UserRepositoryImpl(broken), hasher, new FakeTokenIssuer());

    const outcome = await brokenSignUp
      .execute({ name: 'alice', password: STRONG_PASSWORD })
      .catch((error: unknown) => error);

    expect(outcome).toBe(failure);
  });

  test('creates the user with a hashed password and returns {user, token}', async () => {
    const result = await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });

    expect(result).toEqual({ ok: true, value: { token: 'token-for-1', user: { id: 1, name: 'alice' } } });
    expect(datasource.users[0]?.passwordHash).toBe(PasswordHash.restore(`hashed:${STRONG_PASSWORD}`));
  });

  test('reports every invalid field at once', async () => {
    const result = await signUp.execute({ name: 'alice smith', password: 'password' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBeInstanceOf(ValidationError);
    expect(result.error.errors).toEqual([
      { field: 'name', message: 'Name must contain only letters and numbers, without spaces' },
      { field: 'password', message: 'Password is too weak' },
    ]);
    expect(datasource.users).toHaveLength(0);
  });

  test('returns a ConflictError when the name is taken', async () => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });
    const result = await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBeInstanceOf(ConflictError);
    expect(result.error.message).toBe('User already exists');
    expect(datasource.users).toHaveLength(1);
  });
});

describe('SignInUseCase', () => {
  beforeEach(async () => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });
  });

  // Sign-in only checks the password against the stored hash: strength is a sign-up rule, so an
  // account whose password would be "weak" today (created before the rule, or by a migration) can
  // still sign in.
  test('signs in a stored account whose password is weak, without a strength check', async () => {
    await datasource.create({
      name: UserName.restore('legacy'),
      passwordHash: PasswordHash.restore('hashed:password'),
    });

    const result = await signIn.execute({ name: 'legacy', password: 'password' });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.user).toEqual({ id: 2, name: 'legacy' });
  });

  test('answers a wrong weak password with 401 Invalid credentials, not a validation error', async () => {
    const result = await signIn.execute({ name: 'alice', password: 'password' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBeInstanceOf(UnauthorizedError);
    expect(result.error.message).toBe('Invalid credentials');
    expect(hasher.verified).toHaveLength(1);
  });

  test('still requires a password and caps its length before touching storage', async () => {
    const empty = await signIn.execute({ name: 'alice', password: '' });
    const huge = await signIn.execute({ name: 'alice', password: 'x'.repeat(257) });

    expect(empty.ok ? [] : empty.error.errors).toEqual([{ field: 'password', message: 'Password is required' }]);
    expect(huge.ok ? [] : huge.error.errors).toEqual([
      { field: 'password', message: 'Password must be at most 256 characters' },
    ]);
    expect(hasher.verified).toHaveLength(0);
  });

  test('returns {user, token} for valid credentials', async () => {
    expect(await signIn.execute({ name: 'alice', password: STRONG_PASSWORD })).toEqual({
      ok: true,
      value: { token: 'token-for-1', user: { id: 1, name: 'alice' } },
    });
  });

  test('validates name and password before touching storage', async () => {
    const result = await signIn.execute({ name: 'al ice', password: '' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBeInstanceOf(ValidationError);
    expect(result.error.errors).toEqual([
      { field: 'name', message: 'Name must contain only letters and numbers, without spaces' },
      { field: 'password', message: 'Password is required' },
    ]);
    expect(hasher.verified).toHaveLength(0);
  });

  test.each([
    ['a wrong password', { name: 'alice', password: 'another-Strong-pass-99' }],
    ['an unknown name', { name: 'bob', password: STRONG_PASSWORD }],
  ])('returns the same UnauthorizedError for %s', async (_, input) => {
    const result = await signIn.execute(input);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBeInstanceOf(UnauthorizedError);
    expect(result.error.message).toBe('Invalid credentials');
    expect(hasher.verified).toHaveLength(1);
  });
});

const SECRET = 'refresh-test-secret';

function refreshUseCase(): RefreshUseCase {
  return new RefreshUseCase(
    new JoseTokenVerifier(SECRET),
    new UserRepositoryImpl(datasource),
    new JoseTokenIssuer(SECRET),
  );
}

async function tokenFor(name: string, expiresIn = '1h'): Promise<string> {
  const user = await datasource.findByName(UserName.restore(name));
  if (!user) {
    throw new Error(`no user ${name}`);
  }
  return new JoseTokenIssuer(SECRET, expiresIn).issue(user);
}

describe('RefreshUseCase', () => {
  test('issues a fresh token for the user of a valid token', async () => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });

    const result = await refreshUseCase().execute(await tokenFor('alice'));

    if (!result.ok) {
      throw result.error;
    }
    expect(result.value.user).toEqual({ id: 1, name: 'alice' });
    expect(await new JoseTokenVerifier(SECRET).verify(result.value.token)).toMatchObject({ name: 'alice', userId: 1 });
  });

  test.each([
    ['a forged token', async (): Promise<string> => 'not.a.jwt'],
    ['an expired token', async (): Promise<string> => tokenFor('alice', '-10s')],
    [
      'a token signed with another secret',
      async (): Promise<string> => {
        const user = await datasource.findByName(UserName.restore('alice'));
        return user ? new JoseTokenIssuer('other-secret').issue(user) : '';
      },
    ],
  ])('rejects %s with 401', async (_label, token) => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });

    const result = await refreshUseCase().execute(await token());

    expect(result.ok ? undefined : result.error).toBeInstanceOf(UnauthorizedError);
    expect(result.ok ? undefined : result.error.message).toBe('Invalid or expired token');
  });

  test('keeps the session id of the token it refreshes', async () => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });
    const user = await datasource.findByName(UserName.restore('alice'));
    if (!user) {
      throw new Error('no alice');
    }

    const result = await refreshUseCase().execute(await new JoseTokenIssuer(SECRET).issue(user, 'session-9'));

    if (!result.ok) {
      throw result.error;
    }
    const claims = await new JoseTokenVerifier(SECRET).verify(result.value.token);
    expect(claims?.sessionId).toBe('session-9');
  });

  test('rejects the token of a deleted user, and of a user whose name now belongs to someone else', async () => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });
    await signUp.execute({ name: 'bob', password: STRONG_PASSWORD });
    const aliceToken = await tokenFor('alice');
    datasource.users.splice(0, 1);

    const deleted = await refreshUseCase().execute(aliceToken);
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });
    const replaced = await refreshUseCase().execute(aliceToken);

    expect(deleted.ok ? undefined : deleted.error).toBeInstanceOf(UnauthorizedError);
    expect(replaced.ok ? undefined : replaced.error).toBeInstanceOf(UnauthorizedError);
  });
});

describe('LookupUserUseCase', () => {
  test('returns the public user for a known name', async () => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });

    const result = await new LookupUserUseCase(new UserRepositoryImpl(datasource)).execute('alice');

    expect(result).toEqual({ ok: true, value: { id: 1, name: 'alice' } });
  });

  test('answers 404 for an unknown name and 400 for an invalid one', async () => {
    const lookup = new LookupUserUseCase(new UserRepositoryImpl(datasource));

    const unknown = await lookup.execute('nobody');
    const invalid = await lookup.execute('no spaces');

    expect(unknown.ok ? undefined : unknown.error).toBeInstanceOf(NotFoundError);
    expect(invalid.ok ? undefined : invalid.error).toBeInstanceOf(ValidationError);
  });
});
