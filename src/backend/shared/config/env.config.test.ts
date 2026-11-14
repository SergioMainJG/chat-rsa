import { expect, test } from 'bun:test';

import { loadConfig, loadConnectionConfig } from './env.config.ts';

const SECRET = 'a-jwt-secret-of-at-least-32-chars!';

const DEFAULT_RATE_LIMIT = {
  ip: { capacity: 120, refillPerSecond: 20 },
  signin: { capacity: 10, refillPerSecond: 1 / 30 },
  user: { capacity: 60, refillPerSecond: 10 },
};

test('loadConfig falls back to local defaults', () => {
  expect(loadConfig({ JWT_SECRET: SECRET })).toEqual({
    appOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
    cacheUrl: 'redis://localhost:6380',
    databaseUrl: 'postgres://chat:chat@localhost:5433/chat',
    jwtSecret: SECRET,
    port: 3000,
    rateLimit: DEFAULT_RATE_LIMIT,
    sessionMaxAgeSeconds: 604_800,
    trustedProxyIps: [],
  });
});

test('loadConfig reads values from the environment', () => {
  const config = loadConfig({
    APP_ORIGINS: 'https://chat.example.com, http://localhost:8080',
    DATABASE_URL: 'postgres://u:p@db:5432/x',
    JWT_SECRET: SECRET,
    PORT: '8080',
    SESSION_MAX_AGE_SECONDS: '3600',
    TRUSTED_PROXY_IPS: '127.0.0.1, ::1',
    VALKEY_URL: 'redis://cache:6379',
  });
  expect(config).toEqual({
    appOrigins: ['https://chat.example.com', 'http://localhost:8080'],
    cacheUrl: 'redis://cache:6379',
    databaseUrl: 'postgres://u:p@db:5432/x',
    jwtSecret: SECRET,
    port: 8080,
    rateLimit: DEFAULT_RATE_LIMIT,
    sessionMaxAgeSeconds: 3600,
    trustedProxyIps: ['127.0.0.1', '::1'],
  });
});

test('the default origins follow PORT', () => {
  expect(loadConfig({ JWT_SECRET: SECRET, PORT: '3001' }).appOrigins).toEqual([
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ]);
});

test.each([
  ['missing', {}],
  ['missing in production', { NODE_ENV: 'production' }],
  ['missing in development', { NODE_ENV: 'development' }],
  ['shorter than 32 characters', { JWT_SECRET: 'x'.repeat(31) }],
  ['short even under NODE_ENV=test', { JWT_SECRET: 'short', NODE_ENV: 'test' }],
  ['the removed development default', { JWT_SECRET: 'dev-only-jwt-secret-change-me' }],
])('loadConfig refuses a JWT secret that is %s', (_case, env) => {
  expect(() => loadConfig(env)).toThrow('JWT_SECRET must be set to at least 32 characters');
});

test('only NODE_ENV=test falls back to a test-only secret of at least 32 characters', () => {
  const { jwtSecret } = loadConfig({ NODE_ENV: 'test' });
  expect(jwtSecret.length).toBeGreaterThanOrEqual(32);
  expect(jwtSecret).not.toBe('dev-only-jwt-secret-change-me');
  expect(loadConfig({ JWT_SECRET: SECRET, NODE_ENV: 'test' }).jwtSecret).toBe(SECRET);
});

test('loadConfig reads the rate limit policies from the environment', () => {
  const config = loadConfig({
    JWT_SECRET: SECRET,
    RATE_LIMIT_IP_CAPACITY: '30',
    RATE_LIMIT_IP_REFILL: '2.5',
    RATE_LIMIT_SIGNIN_CAPACITY: '5',
    RATE_LIMIT_SIGNIN_REFILL: '0.1',
    RATE_LIMIT_USER_CAPACITY: '15',
    RATE_LIMIT_USER_REFILL: '0.5',
  });
  expect(config.rateLimit).toEqual({
    ip: { capacity: 30, refillPerSecond: 2.5 },
    signin: { capacity: 5, refillPerSecond: 0.1 },
    user: { capacity: 15, refillPerSecond: 0.5 },
  });
});

test.each([
  ['RATE_LIMIT_USER_REFILL', '0'],
  ['RATE_LIMIT_USER_REFILL', '-1'],
  ['RATE_LIMIT_USER_REFILL', 'abc'],
  ['RATE_LIMIT_USER_REFILL', ''],
  ['RATE_LIMIT_SIGNIN_CAPACITY', '0'],
  ['RATE_LIMIT_SIGNIN_REFILL', 'abc'],
  ['SESSION_MAX_AGE_SECONDS', '0'],
])('loadConfig refuses %s=%p', (name, raw) => {
  expect(() => loadConfig({ JWT_SECRET: SECRET, [name]: raw })).toThrow(`${name} must be a positive number`);
});

// BUG-LOAD-RUN3-MED-01: the load script only needs the port and the database and cache URLs, yet
// loadConfig made it crash on a short or missing JWT_SECRET.
test('loadConnectionConfig needs no JWT_SECRET and matches loadConfig', () => {
  const env = {
    DATABASE_URL: 'postgres://x@db/y',
    JWT_SECRET: 'x'.repeat(32),
    PORT: '4100',
    VALKEY_URL: 'redis://cache:1',
  };
  const full = loadConfig(env);

  expect(loadConnectionConfig({ ...env, JWT_SECRET: 'secret123' })).toEqual({
    cacheUrl: full.cacheUrl,
    databaseUrl: full.databaseUrl,
    port: full.port,
  });
  expect(loadConnectionConfig({})).toEqual({
    cacheUrl: 'redis://localhost:6380',
    databaseUrl: 'postgres://chat:chat@localhost:5433/chat',
    port: 3000,
  });
});
