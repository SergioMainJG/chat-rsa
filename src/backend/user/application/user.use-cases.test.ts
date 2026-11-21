import { beforeEach, describe, expect, test } from 'bun:test';

import {
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../../shared/domain/app.error.ts';
import { InMemoryRateLimiter } from '../../shared/rate-limit/rate-limit.in-memory.ts';
import { User } from '../domain/user.entity.ts';
import { PasswordHash, UserName } from '../domain/user.value-objects.ts';
import { UserRepositoryImpl } from '../infrastructure/user.repository.impl.ts';
import { JoseTokenIssuer, JoseTokenVerifier } from '../infrastructure/user.security.jose.ts';
import {
  FAKE_EXPIRES_AT,
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

const GENEROUS = { capacity: 1000, refillPerSecond: 1000 };

beforeEach(() => {
  datasource = new InMemoryUserDatasource();
  hasher = new FakePasswordHasher();
  const users = new UserRepositoryImpl(datasource);
  signUp = new SignUpUseCase(users, hasher, new FakeTokenIssuer());
  signIn = new SignInUseCase(users, hasher, new FakeTokenIssuer(), {
    limiter: new InMemoryRateLimiter(),
    policy: GENEROUS,
  });
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

    expect(result).toEqual({
      ok: true,
      value: { expiresAt: FAKE_EXPIRES_AT, token: 'token-for-1', user: { id: 1, name: 'alice' } },
    });
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
      value: { expiresAt: FAKE_EXPIRES_AT, token: 'token-for-1', user: { id: 1, name: 'alice' } },
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

describe('SignInUseCase per-account throttle', () => {
  const TIGHT = { capacity: 2, refillPerSecond: 1 / 30 };

  function throttled(limiter = new InMemoryRateLimiter(() => 0)): SignInUseCase {
    return new SignInUseCase(new UserRepositoryImpl(datasource), hasher, new FakeTokenIssuer(), {
      limiter,
      policy: TIGHT,
    });
  }

  test.each([
    ['a known name', 'alice'],
    ['an unknown name', 'nobody'],
  ])('spends signin:<name> before checking the password, for %s, and answers 429', async (_case, name) => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });
    const useCase = throttled();
    const input = { name, password: 'wrong-Password-1' };

    await useCase.execute(input);
    await useCase.execute(input);
    const refused = await useCase.execute(input);

    expect(refused.ok ? undefined : refused.error).toBeInstanceOf(TooManyRequestsError);
    expect(refused.ok ? undefined : refused.error.statusCode).toBe(429);
    expect(refused.ok || !(refused.error instanceof TooManyRequestsError) ? 0 : refused.error.retryAfterSeconds).toBe(
      30,
    );
    // The third attempt never reached the hasher.
    expect(hasher.verified).toHaveLength(2);
  });

  test('a throttled account refuses even the right password, while other names still sign in', async () => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });
    await signUp.execute({ name: 'bob', password: STRONG_PASSWORD });
    const useCase = throttled();
    await useCase.execute({ name: 'alice', password: 'wrong-Password-1' });
    await useCase.execute({ name: 'alice', password: 'wrong-Password-1' });

    const alice = await useCase.execute({ name: 'alice', password: STRONG_PASSWORD });
    const bob = await useCase.execute({ name: 'bob', password: STRONG_PASSWORD });

    expect(alice.ok ? undefined : alice.error).toBeInstanceOf(TooManyRequestsError);
    expect(bob.ok).toBe(true);
  });
});

const SECRET = 'refresh-test-secret';
const MAX_AGE_SECONDS = 604_800;

function refreshUseCase(options: { now?: () => number; refreshed?: Array<[string, Date]> } = {}): RefreshUseCase {
  return new RefreshUseCase(
    new JoseTokenVerifier(SECRET),
    new UserRepositoryImpl(datasource),
    new JoseTokenIssuer(SECRET),
    { now: options.now ?? Date.now, sessionMaxAgeSeconds: MAX_AGE_SECONDS },
    (sessionId, expiresAt) => {
      options.refreshed?.push([sessionId, expiresAt]);
    },
  );
}

/** The stored user; throws instead of letting a missing fixture make a rejection test pass vacuously. */
async function storedUser(name: string): Promise<User> {
  const user = await datasource.findByName(UserName.restore(name));
  if (!user) {
    throw new Error(`no user ${name}`);
  }
  return user;
}

async function tokenFor(name: string, expiresIn = '1h', session?: { id: string; startedAt: Date }): Promise<string> {
  const { token } = await new JoseTokenIssuer(SECRET, expiresIn).issue(await storedUser(name), session);
  return token;
}

describe('RefreshUseCase', () => {
  test('issues a fresh token for the user of a valid token and reports it for the session', async () => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });
    const refreshed: Array<[string, Date]> = [];

    const result = await refreshUseCase({ refreshed }).execute(
      await tokenFor('alice', '1h', { id: 'session-1', startedAt: new Date() }),
    );

    if (!result.ok) {
      throw result.error;
    }
    expect(result.value.user).toEqual({ id: 1, name: 'alice' });
    const claims = await new JoseTokenVerifier(SECRET).verify(result.value.token);
    expect(claims).toMatchObject({ name: 'alice', userId: 1 });
    expect(result.value.expiresAt).toEqual(claims?.expiresAt ?? new Date(0));
    expect(refreshed).toEqual([['session-1', result.value.expiresAt]]);
  });

  test.each([
    ['a forged token', async (): Promise<string> => 'not.a.jwt'],
    ['an expired token', async (): Promise<string> => tokenFor('alice', '-10s')],
    [
      'a token signed with another secret',
      async (): Promise<string> => {
        const { token } = await new JoseTokenIssuer('other-secret').issue(await storedUser('alice'));
        return token;
      },
    ],
    [
      'a validly signed token whose name is not a valid user name',
      async (): Promise<string> => {
        const user = await storedUser('alice');
        const renamed = new User(user.id, UserName.restore('not a valid name!'), user.passwordHash);
        const { token } = await new JoseTokenIssuer(SECRET).issue(renamed);
        return token;
      },
    ],
  ])('rejects %s with 401', async (_label, token) => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });
    const refreshed: Array<[string, Date]> = [];

    const result = await refreshUseCase({ refreshed }).execute(await token());

    expect(result.ok ? undefined : result.error).toBeInstanceOf(UnauthorizedError);
    expect(result.ok ? undefined : result.error.message).toBe('Invalid or expired token');
    expect(refreshed).toEqual([]);
  });

  test('keeps the session id and session start of the token it refreshes', async () => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });
    const startedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 3_600_000);

    const result = await refreshUseCase().execute(await tokenFor('alice', '1h', { id: 'session-9', startedAt }));

    if (!result.ok) {
      throw result.error;
    }
    const claims = await new JoseTokenVerifier(SECRET).verify(result.value.token);
    expect(claims?.sessionId).toBe('session-9');
    expect(claims?.sessionStartedAt).toEqual(startedAt);
  });

  test('answers 401 once now - sst > SESSION_MAX_AGE_SECONDS, and still refreshes at exactly the limit', async () => {
    await signUp.execute({ name: 'alice', password: STRONG_PASSWORD });
    const startedAt = new Date('2026-11-01T00:00:00.000Z');
    const token = await tokenFor('alice', '1h', { id: 'old', startedAt });
    const refreshed: Array<[string, Date]> = [];
    const at =
      (offsetSeconds: number): (() => number) =>
      () =>
        startedAt.getTime() + offsetSeconds * 1000;

    const atLimit = await refreshUseCase({ now: at(MAX_AGE_SECONDS), refreshed }).execute(token);
    const past = await refreshUseCase({ now: at(MAX_AGE_SECONDS + 1), refreshed }).execute(token);

    expect(atLimit.ok).toBe(true);
    expect(past.ok ? undefined : past.error).toBeInstanceOf(UnauthorizedError);
    expect(past.ok ? undefined : past.error.message).toBe('Invalid or expired token');
    expect(refreshed).toHaveLength(1);
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
