import type { BucketPolicy } from '../domain/token-bucket.ts';

export type AppConfig = {
  /** Origins allowed on unsafe requests and on cookie-authenticated `/ws` upgrades (CSRF). */
  readonly appOrigins: readonly string[];
  readonly cacheUrl: string;
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly port: number;
  /**
   * Token buckets: one per client IP and one per signed-in user for every HTTP request, and one per
   * account name for sign-in.
   */
  readonly rateLimit: {
    readonly ip: BucketPolicy;
    readonly signin: BucketPolicy;
    readonly user: BucketPolicy;
  };
  /** Absolute session lifetime: refresh is refused once a session is older than this. */
  readonly sessionMaxAgeSeconds: number;
  /** Peers whose `CF-Connecting-IP` header is trusted as the client IP. */
  readonly trustedProxyIps: readonly string[];
};

type Env = Record<string, string | undefined>;

export const JWT_SECRET_MIN_LENGTH = 32;
/** Only `bun test` (which sets `NODE_ENV=test`) may sign tokens without a configured secret. */
const TEST_ONLY_JWT_SECRET = 'test-only-jwt-secret-never-use-it-outside-bun-test';
const SEVEN_DAYS_SECONDS = 604_800;

/** Where the server listens and what it connects to; tools that sign no tokens need only this. */
export type ConnectionConfig = Pick<AppConfig, 'cacheUrl' | 'databaseUrl' | 'port'>;

export function loadConfig(env: Env = Bun.env): AppConfig {
  const connection = loadConnectionConfig(env);
  const { port } = connection;
  return {
    ...connection,
    appOrigins: list(env.APP_ORIGINS) ?? [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
    jwtSecret: jwtSecretOf(env),
    rateLimit: {
      ip: {
        capacity: positive(env, 'RATE_LIMIT_IP_CAPACITY', 120),
        refillPerSecond: positive(env, 'RATE_LIMIT_IP_REFILL', 20),
      },
      signin: {
        capacity: positive(env, 'RATE_LIMIT_SIGNIN_CAPACITY', 10),
        refillPerSecond: positive(env, 'RATE_LIMIT_SIGNIN_REFILL', 1 / 30),
      },
      user: {
        capacity: positive(env, 'RATE_LIMIT_USER_CAPACITY', 60),
        refillPerSecond: positive(env, 'RATE_LIMIT_USER_REFILL', 10),
      },
    },
    sessionMaxAgeSeconds: positive(env, 'SESSION_MAX_AGE_SECONDS', SEVEN_DAYS_SECONDS),
    trustedProxyIps: list(env.TRUSTED_PROXY_IPS) ?? [],
  };
}

export function loadConnectionConfig(env: Env = Bun.env): ConnectionConfig {
  return {
    cacheUrl: env.VALKEY_URL ?? 'redis://localhost:6380',
    databaseUrl: env.DATABASE_URL ?? 'postgres://chat:chat@localhost:5433/chat',
    port: Number(env.PORT ?? 3000),
  };
}

/** There is no development default: a guessable secret lets anyone sign tokens. */
function jwtSecretOf(env: Env): string {
  const secret = env.JWT_SECRET ?? (env.NODE_ENV === 'test' ? TEST_ONLY_JWT_SECRET : '');
  if (secret.length < JWT_SECRET_MIN_LENGTH) {
    throw new Error(`JWT_SECRET must be set to at least ${JWT_SECRET_MIN_LENGTH} characters`);
  }
  return secret;
}

/** Comma-separated values, trimmed, empty entries dropped; undefined when the variable is unset. */
function list(raw: string | undefined): readonly string[] | undefined {
  return raw
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** A zero or negative refill would never let a refused client back in, so it is refused here. */
function positive(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw.trim() === '' ? Number.NaN : raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}
