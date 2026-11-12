// k6 load test for /api/auth/*. Run it through `bun run test:load [smoke|load|stress]`, which
// starts the pinned grafana/k6 image and deletes every user this run created.
// test/load/auth.load.sabotage.test.ts proves that each check below catches a real defect.
import type { Options, Scenario } from 'k6/options';

import { check } from 'k6';
import { scenario } from 'k6/execution';
import {
  expectedStatuses,
  post as httpPost,
  type RefinedResponse,
  type ResponseType,
} from 'k6/http';

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
    ...Object.fromEntries(
      Object.keys(scenarios).map((name) => [
        `http_req_duration{scenario:${name}}`,
        [`p(95)<${LATENCY_P95_MS[name] ?? 800}`],
      ]),
    ),
  },
};

type PoolData = { readonly pool: readonly string[] };

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

/** `{ user: { id, name }, token }` served as JSON, with a positive integer id and a three-part JWT. */
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
  const segments = body.token.split('.');
  return (
    typeof id === 'number' &&
    Number.isInteger(id) &&
    id > 0 &&
    body.user.name === name &&
    segments.length === 3 &&
    segments.every((segment) => JWT_SEGMENT.test(segment))
  );
}

/** The shared error format: every field present, the request's own path and an ISO timestamp. */
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
    typeof error === 'string' &&
    error.length > 0 &&
    typeof message === 'string' &&
    message.length > 0 &&
    typeof timestamp === 'string' &&
    new Date(timestamp).toISOString() === timestamp
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
  return { pool };
}

export function signIn(data: PoolData): void {
  const name = data.pool[scenario.iterationInTest % data.pool.length] ?? '';
  const response = post('/api/auth/sign-in', { name, password: PASSWORD }, [200]);
  check(response, {
    'sign-in returns {user, token}': (r) => isAuthResponse(r, name),
    'sign-in status is 200': (r) => r.status === 200,
  });
}

export function signUp(): void {
  const name = `${NAME_PREFIX}u${scenario.iterationInTest}`;
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

/** Burst traffic: alternating known sign-ins and unknown names, both one argon2 operation each. */
export function spike(data: PoolData): void {
  if (scenario.iterationInTest % 2 === 0) {
    signIn(data);
  } else {
    unknownUserSignIn();
  }
}
