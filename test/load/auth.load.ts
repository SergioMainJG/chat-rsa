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
  get as httpGet,
  post as httpPost,
  type RefinedResponse,
  type ResponseCookie,
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
// The server throttles sign-in per account: `signin:<name>` holds 10 attempts and refills one per
// 30 s (RATE_LIMIT_SIGNIN_*), and every sign-in attempt spends one, wrong passwords included
// (415 and 400 are refused before it). So each scenario walks the pool round-robin from its own
// offset, and the pool is sized so that no name needs more than its 10 attempts per run, before
// any refill, including setup()'s reuse sign-in when a run is retried with the same RUN_ID:
// - smoke: 10 signIn + 5 rejections + 3 signOut over 20 names (offsets 0, 10, 15), so at most
//   1 + 1 (reuse) per name and run, and 4 over two same-RUN_ID runs without a reset.
// - load: about 375 signIn (1 -> 4 -> 0/s over 2 min) + 120 rejections (1/s) + 60 signOut
//   (0.5/s) over 80 names: at most 5 + 2 + 1 + 1 (reuse) = 9 per name.
// - stress saturates on purpose: its spike gets 429s from both buckets.
const POOL_SIZES: Readonly<Record<string, number>> = { load: 80, smoke: 20, stress: 20 };
/** Users created in setup() for the sign-in scenarios. */
const POOL_SIZE = POOL_SIZES[PROFILE] ?? 20;
const SIGN_IN_OFFSET = 0;
const REJECTIONS_OFFSET = 10;
const SIGN_OUT_OFFSET = 15;
const JWT_SEGMENT = /^[\w-]+$/u;
/** The JWT is never in a body: the server sets it in this HttpOnly cookie (S4). */
const SESSION_COOKIE = 'chat_rsa_session';
/** Not a credential: the token's `exp` in seconds, readable by the page's route guard. */
const SESSION_HINT_COOKIE = 'chat_rsa_session_hint';
const TOKEN_LIFETIME_SECONDS = 3600;
const SIGN_IN_CHECK = 'sign-in returns {user} and the session cookies';
const SIGN_UP_CHECK = 'sign-up returns {user} and the session cookies';
const SIGN_IN_PATH = '/api/auth/sign-in';
const REFRESH_PATH = '/api/auth/refresh';
const SIGN_OUT_PATH = '/api/auth/sign-out';
/** One protected GET (the `authenticated` guard), to prove a signed-out token is refused there. */
const PROTECTED_PATH = '/api/rooms';
/** Never in APP_ORIGINS: an unsafe request carrying it must be refused (CSRF). */
const FOREIGN_ORIGIN = 'https://attacker.example';
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
    sign_out: {
      duration: '2m',
      exec: 'signOut',
      executor: 'constant-arrival-rate',
      maxVUs: 10,
      preAllocatedVUs: 2,
      rate: 1,
      timeUnit: '2s',
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
    sign_out: { exec: 'signOut', executor: 'shared-iterations', iterations: 3, vus: 1 },
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
  sign_out: 800,
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
 * the user id, `name` is the user name, `exp` is a time in the future, `sid` (the session id) is a
 * non-empty string and `sst` (the session start, epoch seconds) is a finite number.
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
    payload.exp * 1000 > Date.now() &&
    typeof payload.sid === 'string' &&
    payload.sid.length > 0 &&
    typeof payload.sst === 'number' &&
    Number.isFinite(payload.sst)
  );
}

/** The `exp` claim of a token, or null; read only after `hasUsableClaims` accepted it. */
function expOf(token: string): null | number {
  const exp = jwtPart(token.split('.')[1])?.exp;
  return typeof exp === 'number' ? exp : null;
}

/**
 * `{ user: { id, name } }` served as JSON, with a positive integer id and no token in the body,
 * plus the session cookies: the token (HttpOnly, Secure, one token lifetime, usable claims) and its
 * readable hint, which holds exactly the token's `exp`.
 */
function isAuthResponse(response: RefinedResponse<ResponseType>, name: string): boolean {
  const body = bodyOf(response);
  const session = response.cookies[SESSION_COOKIE]?.[0];
  const hint = response.cookies[SESSION_HINT_COOKIE]?.[0];
  if (
    !isJsonResponse(response) ||
    !isRecord(body) ||
    !isRecord(body.user) ||
    'token' in body ||
    session === undefined ||
    hint === undefined
  ) {
    return false;
  }
  const { id } = body.user;
  return (
    typeof id === 'number' &&
    Number.isInteger(id) &&
    id > 0 &&
    body.user.name === name &&
    hasSessionCookies(response, { hint, session }, { id, name })
  );
}

/**
 * The HttpOnly token cookie with usable claims, and the readable hint holding its `exp`; both
 * Secure, `SameSite=Strict`, `Path=/` and one token lifetime long.
 */
function hasSessionCookies(
  response: RefinedResponse<ResponseType>,
  cookies: { readonly hint: ResponseCookie; readonly session: ResponseCookie },
  user: { readonly id: number; readonly name: string },
): boolean {
  const { hint, session } = cookies;
  const token = attributesOf(session);
  const readable = attributesOf(hint);
  return (
    hasUsableClaims(session.value, user.id, user.name) &&
    token.http_only === true &&
    token.secure === true &&
    token.max_age === TOKEN_LIFETIME_SECONDS &&
    token.path === '/' &&
    sameSiteOf(response, SESSION_COOKIE) === 'strict' &&
    readable.http_only === false &&
    readable.secure === true &&
    readable.max_age === TOKEN_LIFETIME_SECONDS &&
    readable.path === '/' &&
    sameSiteOf(response, SESSION_HINT_COOKIE) === 'strict' &&
    hint.value === String(expOf(session.value))
  );
}

/**
 * The lower-cased `SameSite` of cookie `name`, or null. k6 exposes no SameSite field, so it is read
 * from the raw `Set-Cookie` header, where k6 joins the cookies with ", ".
 */
function sameSiteOf(response: RefinedResponse<ResponseType>, name: string): null | string {
  const header = response.headers['Set-Cookie'] ?? '';
  const cookie = header.split(/,\s*(?=[^;=,\s]+=)/u).find((item) => item.startsWith(`${name}=`));
  const attribute = cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => /^samesite=/iu.test(part));
  return attribute?.slice('samesite='.length).toLowerCase() ?? null;
}

/** A cookie deleted now: empty, at `Path=/`, and `Max-Age=0` (which k6 reports as -1). */
function isCleared(cookie: ResponseCookie | undefined): boolean {
  if (cookie === undefined) {
    return false;
  }
  const { max_age: maxAge, path } = attributesOf(cookie);
  return cookie.value === '' && typeof maxAge === 'number' && maxAge < 0 && path === '/';
}

/**
 * The cookie's attributes as k6 really exposes them: snake_case (`http_only`, `max_age`), unlike
 * the camelCase names in @types/k6.
 */
function attributesOf(cookie: ResponseCookie): Readonly<Record<string, unknown>> {
  return { ...cookie };
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

/** A GET whose own expected statuses count as success (k6 `responseCallback`). */
function get(
  path: string,
  expected: readonly number[],
  headers: Readonly<Record<string, string>>,
): RefinedResponse<ResponseType> {
  return httpGet(`${BASE_URL}${path}`, {
    headers,
    responseCallback: expectedStatuses(...expected),
    tags: { name: path },
  });
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

/**
 * `expected` scopes which statuses count as success to this one request (k6 `responseCallback`).
 * `headers` are added to (or override) the JSON content type; an undefined body sends none.
 */
function post(
  path: string,
  body: unknown,
  expected: readonly number[],
  headers: Readonly<Record<string, string>> = {},
): RefinedResponse<ResponseType> {
  let payload: null | string = null;
  if (typeof body === 'string') {
    payload = body;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
  }
  return httpPost(`${BASE_URL}${path}`, payload, {
    headers: { 'content-type': 'application/json', ...headers },
    responseCallback: expectedStatuses(...expected),
    tags: { name: path },
  });
}

/** The pool name of this iteration: each scenario walks the pool round-robin from its offset. */
function poolName(data: PoolData, offset: number): string {
  return data.pool[(offset + scenario.iterationInTest) % data.pool.length] ?? '';
}

/** Idempotent: a pool user left by an aborted run (409) is reused if its known password still works. */
export function setup(): PoolData {
  const pool = Array.from({ length: POOL_SIZE }, (_, index) => `${NAME_PREFIX}p${index}`);
  for (const name of pool) {
    const created = post('/api/auth/sign-up', { name, password: PASSWORD }, [201, 409]);
    if (created.status === 409) {
      const reuse = post(SIGN_IN_PATH, { name, password: PASSWORD }, [200]);
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
  const name = poolName(data, SIGN_IN_OFFSET);
  const response = post(SIGN_IN_PATH, { name, password: PASSWORD }, [200]);
  check(response, {
    'sign-in status is 200': (r) => r.status === 200,
    [SIGN_IN_CHECK]: (r) => isAuthResponse(r, name),
  });
}

export function signUp(data: PoolData): void {
  const name = `${NAME_PREFIX}u${data.attempt}${scenario.iterationInTest}`;
  const response = post('/api/auth/sign-up', { name, password: PASSWORD }, [201]);
  check(response, {
    'sign-up status is 201': (r) => r.status === 201,
    [SIGN_UP_CHECK]: (r) => isAuthResponse(r, name),
  });
}

function unknownUserSignIn(): void {
  // Never registered: exercises the shared dummy-hash path that equalizes timing.
  const response = post(
    SIGN_IN_PATH,
    { name: `${NAME_PREFIX}g${scenario.iterationInTest}`, password: PASSWORD },
    [401],
  );
  check(response, { 'unknown user is 401': (r) => hasErrorShape(r, 401, SIGN_IN_PATH) });
}

/** Expected failures must keep their status and the full error format under load. */
export function rejections(data: PoolData): void {
  const path = SIGN_IN_PATH;
  const known = poolName(data, REJECTIONS_OFFSET);
  const wrongPassword = post(path, { name: known, password: WRONG_PASSWORD }, [401]);
  const invalid = post(path, { name: 'has space', password: 'password' }, [400]);
  const wrongMediaType = post(path, { name: known, password: PASSWORD }, [415], {
    'content-type': 'text/plain',
  });
  check(wrongPassword, { 'wrong password is 401': (r) => hasErrorShape(r, 401, path) });
  check(invalid, { 'invalid credentials are 400': (r) => hasErrorShape(r, 400, path) });
  check(wrongMediaType, { 'text/plain is 415': (r) => hasErrorShape(r, 415, path) });
  unknownUserSignIn();
}

/** The CSRF guard's answer: 403 `Origin not allowed` in the shared error format. */
function isOriginRefused(response: RefinedResponse<ResponseType>, path: string): boolean {
  const body = bodyOf(response);
  return (
    hasErrorShape(response, 403, path) && isRecord(body) && body.message === 'Origin not allowed'
  );
}

/**
 * One session from sign-in to sign-out. While it lives, its token reads a protected route, and the
 * CSRF guard refuses a foreign `Origin` and a cookie request without `Origin` but lets a bearer
 * request without `Origin` refresh. After `POST /api/auth/sign-out` (204, both cookies cleared),
 * the same token is refused by refresh and by the protected route.
 */
export function signOut(data: PoolData): void {
  const name = poolName(data, SIGN_OUT_OFFSET);
  const signedIn = post(SIGN_IN_PATH, { name, password: PASSWORD }, [200]);
  check(signedIn, { [SIGN_IN_CHECK]: (r) => isAuthResponse(r, name) });
  const token = signedIn.cookies[SESSION_COOKIE]?.[0]?.value ?? '';
  const bearer = { authorization: `Bearer ${token}` };

  check(get(PROTECTED_PATH, [200], bearer), {
    'a live session reads GET /api/rooms': (r) => r.status === 200,
  });
  const foreign = post(SIGN_IN_PATH, { name, password: PASSWORD }, [403], {
    origin: FOREIGN_ORIGIN,
  });
  check(foreign, {
    'a foreign Origin is refused with 403': (r) => isOriginRefused(r, SIGN_IN_PATH),
  });
  const cookieOnly = post(REFRESH_PATH, undefined, [403], {
    cookie: `${SESSION_COOKIE}=${token}`,
  });
  check(cookieOnly, {
    'a cookie-authenticated refresh without Origin is 403': (r) => isOriginRefused(r, REFRESH_PATH),
  });
  check(post(REFRESH_PATH, undefined, [200], bearer), {
    'a bearer refresh without Origin is 200': (r) => r.status === 200 && isAuthResponse(r, name),
  });

  check(post(SIGN_OUT_PATH, undefined, [204], bearer), {
    'sign-out is 204 and clears both session cookies': (r) =>
      r.status === 204 &&
      isCleared(r.cookies[SESSION_COOKIE]?.[0]) &&
      isCleared(r.cookies[SESSION_HINT_COOKIE]?.[0]),
  });
  check(post(REFRESH_PATH, undefined, [401], bearer), {
    'a signed-out token is refused by refresh': (r) => hasErrorShape(r, 401, REFRESH_PATH),
  });
  check(get(PROTECTED_PATH, [401], bearer), {
    'a signed-out token is refused by GET /api/rooms': (r) => hasErrorShape(r, 401, PROTECTED_PATH),
  });
}

/** A 429 says when to retry: an integer number of seconds, at least 1. */
function hasRetryAfter(response: RefinedResponse<ResponseType>): boolean {
  const value = response.headers['Retry-After'] ?? '';
  return /^[1-9][0-9]*$/u.test(value);
}

/** A burst past the IP bucket: every 429 must carry Retry-After and the shared error format. */
export function rateLimit(): void {
  const path = SIGN_IN_PATH;
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
