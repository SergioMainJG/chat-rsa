// k6 load test for /api/auth/*. Run it through `bun run test:load [smoke|load|stress]`, which
// starts the pinned grafana/k6 image and deletes every user this run created.
// test/load/auth.load.sabotage.test.ts proves that each check below catches a real defect.
import type { Options, Scenario } from 'k6/options';

import { check } from 'k6';
import { b64decode } from 'k6/encoding';
import { scenario } from 'k6/execution';
import {
  batch,
  expectedStatuses,
  post as httpPost,
  type RefinedResponse,
  type ResponseType,
} from 'k6/http';
import { Counter } from 'k6/metrics';

import { STATUS_TEXT } from './support/error-format.ts';

/** K6 injects this global; declared here because tsconfig only loads Bun's global types. */
// eslint-disable-next-line no-underscore-dangle -- `__ENV` is the name k6 itself gives this global
declare const __ENV: Readonly<Record<string, string | undefined>>;

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3000';
const PROFILE = __ENV.PROFILE ?? 'smoke';
const PASSWORD = 'correct-Horse-battery-st4ple';
const WRONG_PASSWORD = 'another-Strong-pass-99';
/** Users created in setup() for the sign-in scenario. */
const POOL_SIZE = 20;
/** Same rule as runUserPattern in k6-runner.ts: no default, so two runs never share names. */
const RUN_ID = __ENV.RUN_ID ?? '';
if (!/^[0-9a-z]{8,}$/u.test(RUN_ID)) {
  throw new Error(`RUN_ID must be at least 8 lower-case alphanumerics, got "${RUN_ID}"`);
}
/**
 * Pool users are `<prefix>p<n>`, sign-ups `<prefix>u<n>` (cleaned up), unknown names
 * `<prefix>g<n>`.
 */
const NAME_PREFIX = `load${RUN_ID}`;
const JWT_SEGMENT = /^[\w-]+$/u;
/** Requests in the stress burst: past the server's default IP bucket (120), which guards sign-in. */
const RATE_LIMIT_BURST = Number(__ENV.RATE_LIMIT_BURST ?? 200);
const rateLimited = new Counter('rate_limited');

type Scenarios = Readonly<Record<string, Scenario>>;

// Every sign-up, sign-in, wrong-password and unknown-user check costs one argon2 operation. The
// `load` profile stays below the measured capacity; `stress` deliberately goes past it.
const PROFILES: Readonly<Record<string, Scenarios>> = {
  load: {
    rejections: {
      duration: '2m',
      exec: 'rejections',
      executor: 'constant-arrival-rate',
      maxVUs: 10,
      preAllocatedVUs: 2,
      rate: 1,
      timeUnit: '1s',
    },
    sign_in: {
      exec: 'signIn',
      executor: 'ramping-arrival-rate',
      maxVUs: 20,
      preAllocatedVUs: 4,
      stages: [
        { duration: '30s', target: 4 },
        { duration: '1m', target: 4 },
        { duration: '30s', target: 0 },
      ],
      startRate: 1,
      timeUnit: '1s',
    },
    sign_up: {
      exec: 'signUp',
      executor: 'ramping-arrival-rate',
      maxVUs: 20,
      preAllocatedVUs: 2,
      stages: [
        { duration: '30s', target: 2 },
        { duration: '1m', target: 2 },
        { duration: '30s', target: 0 },
      ],
      startRate: 1,
      timeUnit: '1s',
    },
  },
  smoke: {
    rejections: { exec: 'rejections', executor: 'shared-iterations', iterations: 5, vus: 1 },
    sign_in: { exec: 'signIn', executor: 'shared-iterations', iterations: 10, vus: 1 },
    sign_up: { exec: 'signUp', executor: 'shared-iterations', iterations: 10, vus: 1 },
  },
  // A 30-VU burst with no pacing: it measures how the server degrades past capacity. Its latency
  // threshold is the same as sign-in's, so a saturated server fails this profile on purpose.
  stress: {
    // One burst of invalid sign-ins (400, no argon2 cost) that must be shed with 429.
    rate_limit: { exec: 'rateLimit', executor: 'shared-iterations', iterations: 1, vus: 1 },
    rejections: { exec: 'rejections', executor: 'shared-iterations', iterations: 5, vus: 1 },
    spike: {
      exec: 'spike',
      executor: 'ramping-vus',
      stages: [
        { duration: '10s', target: 30 },
        { duration: '20s', target: 30 },
        { duration: '10s', target: 0 },
      ],
      startVUs: 0,
    },
  },
};

const scenarios = PROFILES[PROFILE];
if (!scenarios) {
  throw new Error(`Unknown PROFILE "${PROFILE}". Use one of: ${Object.keys(PROFILES).join(', ')}`);
}

const LATENCY_P95_MS: Readonly<Record<string, number>> = {
  rate_limit: 800,
  rejections: 500,
  sign_in: 800,
  sign_up: 1000,
  spike: 800,
};

export const options: Options = {
  scenarios,
  thresholds: {
    checks: ['rate>0.99'],
    // Each request declares its own expected statuses, so a 401 on a valid sign-in is a failure.
    http_req_failed: ['rate<0.01'],
    ...('rate_limit' in scenarios && { rate_limited: ['count>0'] }),
    ...Object.fromEntries(
      Object.keys(scenarios).map((name) => [
        `http_req_duration{scenario:${name}}`,
        [`p(95)<${LATENCY_P95_MS[name] ?? 800}`],
      ]),
    ),
  },
};

type PoolData = {
  /** Digits unique to this attempt, so a retry with the same RUN_ID signs up new names. */
  readonly attempt: string;
  readonly pool: readonly string[];
};

function bodyOf(response: RefinedResponse<ResponseType>): unknown {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function isJsonResponse(response: RefinedResponse<ResponseType>): boolean {
  const contentType = response.headers['Content-Type'] ?? '';
  return contentType.toLowerCase().startsWith('application/json');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/** The decoded JSON of one base64url JWT segment, or null when it is not a JSON object. */
function jwtPart(segment: string | undefined): null | Readonly<Record<string, unknown>> {
  if (segment === undefined || !JWT_SEGMENT.test(segment)) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(b64decode(segment, 'rawurl', 's'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * A token the messaging endpoints accept (they verify it with JoseTokenVerifier): HS256, `sub` is
 * the user id, `name` is the user name and `exp` is a time in the future.
 */
function hasUsableClaims(token: string, id: number, name: string): boolean {
  const segments = token.split('.');
  const header = jwtPart(segments[0]);
  const payload = jwtPart(segments[1]);
  return (
    segments.length === 3 &&
    JWT_SEGMENT.test(segments[2] ?? '') &&
    header?.alg === 'HS256' &&
    payload?.sub === String(id) &&
    payload.name === name &&
    typeof payload.exp === 'number' &&
    payload.exp * 1000 > Date.now()
  );
}

/** `{ user: { id, name }, token }` served as JSON, with a positive integer id and usable claims. */
function isAuthResponse(response: RefinedResponse<ResponseType>, name: string): boolean {
  const body = bodyOf(response);
  if (
    !isJsonResponse(response) ||
    !isRecord(body) ||
    !isRecord(body.user) ||
    typeof body.token !== 'string'
  ) {
    return false;
  }
  const { id } = body.user;
  return (
    typeof id === 'number' &&
    Number.isInteger(id) &&
    id > 0 &&
    body.user.name === name &&
    hasUsableClaims(body.token, id, name)
  );
}

/** An exact ISO 8601 instant; a malformed value is a failed check, never a thrown RangeError. */
function isIsoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return false;
  }
  return new Date(value).toISOString() === value;
}

/** Each field error of a 400 names its field and says what is wrong with it. */
function hasFieldErrors(errors: unknown): boolean {
  return (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item.field === 'string' &&
        item.field.length > 0 &&
        typeof item.message === 'string' &&
        item.message.length > 0,
    )
  );
}

/**
 * The shared error format: every field present, the exact status title, the request's own path, an
 * ISO timestamp and, on a 400, the field errors.
 */
function hasErrorShape(
  response: RefinedResponse<ResponseType>,
  statusCode: number,
  path: string,
): boolean {
  const body = bodyOf(response);
  if (!isJsonResponse(response) || !isRecord(body)) {
    return false;
  }
  const { correlationId, error, message, timestamp } = body;
  return (
    response.status === statusCode &&
    body.statusCode === statusCode &&
    body.path === path &&
    typeof correlationId === 'string' &&
    correlationId.length > 0 &&
    error === STATUS_TEXT[statusCode] &&
    (statusCode !== 400 || hasFieldErrors(body.errors)) &&
    typeof message === 'string' &&
    message.length > 0 &&
    isIsoTimestamp(timestamp)
  );
}

/** `expected` scopes which statuses count as success to this one request (k6 `responseCallback`). */
function post(
  path: string,
  body: unknown,
  expected: readonly number[],
  contentType = 'application/json',
): RefinedResponse<ResponseType> {
  return httpPost(`${BASE_URL}${path}`, typeof body === 'string' ? body : JSON.stringify(body), {
    headers: { 'content-type': contentType },
    responseCallback: expectedStatuses(...expected),
    tags: { name: path },
  });
}

/** Idempotent: a pool user left by an aborted run (409) is reused if its known password still works. */
export function setup(): PoolData {
  const pool = Array.from({ length: POOL_SIZE }, (_, index) => `${NAME_PREFIX}p${index}`);
  for (const name of pool) {
    const created = post('/api/auth/sign-up', { name, password: PASSWORD }, [201, 409]);
    if (created.status === 409) {
      const reuse = post('/api/auth/sign-in', { name, password: PASSWORD }, [200]);
      if (!isAuthResponse(reuse, name)) {
        throw new Error(
          `setup: pool user ${name} exists but its password no longer works (${reuse.status})`,
        );
      }
    } else if (created.status !== 201) {
      throw new Error(
        `setup: sign-up for the sign-in pool returned ${created.status} at ${BASE_URL}`,
      );
    }
  }
  // Digits only: sign-ups stay `<prefix>u<digits>`, inside the cleanup pattern.
  const attempt = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  return { attempt, pool };
}

export function signIn(data: PoolData): void {
  const name = data.pool[scenario.iterationInTest % data.pool.length] ?? '';
  const response = post('/api/auth/sign-in', { name, password: PASSWORD }, [200]);
  check(response, {
    'sign-in returns {user, token}': (r) => isAuthResponse(r, name),
    'sign-in status is 200': (r) => r.status === 200,
  });
}

export function signUp(data: PoolData): void {
  const name = `${NAME_PREFIX}u${data.attempt}${scenario.iterationInTest}`;
  const response = post('/api/auth/sign-up', { name, password: PASSWORD }, [201]);
  check(response, {
    'sign-up returns {user, token}': (r) => isAuthResponse(r, name),
    'sign-up status is 201': (r) => r.status === 201,
  });
}

function unknownUserSignIn(): void {
  // Never registered: exercises the shared dummy-hash path that equalizes timing.
  const response = post(
    '/api/auth/sign-in',
    { name: `${NAME_PREFIX}g${scenario.iterationInTest}`, password: PASSWORD },
    [401],
  );
  check(response, { 'unknown user is 401': (r) => hasErrorShape(r, 401, '/api/auth/sign-in') });
}

/** Expected failures must keep their status and the full error format under load. */
export function rejections(data: PoolData): void {
  const path = '/api/auth/sign-in';
  const known = data.pool[0];
  const wrongPassword = post(path, { name: known, password: WRONG_PASSWORD }, [401]);
  const invalid = post(path, { name: 'has space', password: 'password' }, [400]);
  const wrongMediaType = post(path, { name: known, password: PASSWORD }, [415], 'text/plain');
  check(wrongPassword, { 'wrong password is 401': (r) => hasErrorShape(r, 401, path) });
  check(invalid, { 'invalid credentials are 400': (r) => hasErrorShape(r, 400, path) });
  check(wrongMediaType, { 'text/plain is 415': (r) => hasErrorShape(r, 415, path) });
  unknownUserSignIn();
}

/** A 429 says when to retry: an integer number of seconds, at least 1. */
function hasRetryAfter(response: RefinedResponse<ResponseType>): boolean {
  const value = response.headers['Retry-After'] ?? '';
  return /^[1-9][0-9]*$/u.test(value);
}

/** A burst past the IP bucket: every 429 must carry Retry-After and the shared error format. */
export function rateLimit(): void {
  const path = '/api/auth/sign-in';
  const body = JSON.stringify({ name: 'has space', password: 'password' });
  const responses = batch(
    Array.from({ length: RATE_LIMIT_BURST }, () => ({
      body,
      method: 'POST',
      params: {
        headers: { 'content-type': 'application/json' },
        responseCallback: expectedStatuses(400, 429),
        tags: { name: path },
      },
      url: `${BASE_URL}${path}`,
    })),
  );
  for (const response of responses) {
    if (response.status === 429) {
      rateLimited.add(1);
      check(response, {
        'rate limit is 429 with Retry-After': (r) =>
          hasRetryAfter(r) && hasErrorShape(r, 429, path),
      });
    }
  }
}

/** Burst traffic: alternating known sign-ins and unknown names, both one argon2 operation each. */
export function spike(data: PoolData): void {
  if (scenario.iterationInTest % 2 === 0) {
    signIn(data);
  } else {
    unknownUserSignIn();
  }
}
