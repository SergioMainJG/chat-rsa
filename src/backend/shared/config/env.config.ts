import type { BucketPolicy } from '../domain/token-bucket.ts';

export type AppConfig = {
  readonly cacheUrl: string;
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly port: number;
  /** Token buckets for every HTTP request: one per client IP and one per signed-in user. */
  readonly rateLimit: {
    readonly ip: BucketPolicy;
    readonly user: BucketPolicy;
  };
};

type Env = Record<string, string | undefined>;

const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me';

export function loadConfig(env: Env = Bun.env): AppConfig {
  const jwtSecret = env.JWT_SECRET ?? DEV_JWT_SECRET;
  if (env.NODE_ENV === 'production' && jwtSecret === DEV_JWT_SECRET) {
    throw new Error('JWT_SECRET must be set in production');
  }
  return {
    cacheUrl: env.VALKEY_URL ?? 'redis://localhost:6380',
    databaseUrl: env.DATABASE_URL ?? 'postgres://chat:chat@localhost:5433/chat',
    jwtSecret,
    port: Number(env.PORT ?? 3000),
    rateLimit: {
      ip: {
        capacity: positive(env, 'RATE_LIMIT_IP_CAPACITY', 120),
        refillPerSecond: positive(env, 'RATE_LIMIT_IP_REFILL', 20),
      },
      user: {
        capacity: positive(env, 'RATE_LIMIT_USER_CAPACITY', 60),
        refillPerSecond: positive(env, 'RATE_LIMIT_USER_REFILL', 10),
      },
    },
  };
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
