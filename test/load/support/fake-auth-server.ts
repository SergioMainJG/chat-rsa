// In-memory stand-in for /api/auth/*, with one switchable defect per sabotage. The `honest` mode
// mirrors the real contract, so a probe that fails against a sabotage proves k6 caught that defect.

export const SABOTAGES = [
  'honest',
  'sign-in-401',
  'pool-exists',
  'no-user-id',
  'garbage-token',
  'text-content-type',
  'stripped-errors',
  'unknown-user-accepted',
] as const;
export type FakeAuthServer = {
  readonly baseUrl: string;
  /** Sign-in requests for names that were never registered. */
  readonly stop: () => Promise<void>;
  readonly unknownSignIns: () => number;
};

export type Sabotage = (typeof SABOTAGES)[number];

const PASSWORD = 'correct-Horse-battery-st4ple';
const NAME_PATTERN = /^[\p{L}\p{N}]+$/u;
const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  409: 'Conflict',
  415: 'Unsupported Media Type',
};

export function startFakeAuthServer(sabotage: Sabotage): FakeAuthServer {
  const users = new Map<string, string>();
  let nextId = 1;
  let unknownSignIns = 0;

  function error(
    request: Request,
    statusCode: number,
    message: string,
    errors?: unknown[],
  ): Response {
    const full = {
      correlationId: crypto.randomUUID(),
      error: STATUS_TEXT[statusCode] ?? 'Error',
      ...(errors && { errors }),
      message,
      path: new URL(request.url).pathname,
      statusCode,
      timestamp: new Date().toISOString(),
    };
    const body =
      sabotage === 'stripped-errors' ? { correlationId: full.correlationId, statusCode } : full;
    return Response.json(body, { status: statusCode });
  }

  function session(name: string, status: number): Response {
    const id = sabotage === 'no-user-id' ? undefined : nextId;
    nextId += 1;
    const token = sabotage === 'garbage-token' ? 'garbage' : jwtLike(name);
    const body = JSON.stringify({ token, user: { id, name } });
    const contentType = sabotage === 'text-content-type' ? 'text/plain' : 'application/json';
    return new Response(body, { headers: { 'content-type': contentType }, status });
  }

  async function credentials(
    request: Request,
  ): Promise<Response | { name: string; password: string }> {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return error(request, 415, 'Content-Type must be application/json');
    }
    const body: unknown = await request.json();
    const fields: Readonly<Record<string, unknown>> =
      typeof body === 'object' && body !== null ? { ...body } : {};
    const name = typeof fields.name === 'string' ? fields.name : '';
    if (!NAME_PATTERN.test(name)) {
      return error(request, 400, 'Validation failed', [
        { field: 'name', message: 'Name must contain only letters and numbers, without spaces' },
      ]);
    }
    return { name, password: typeof fields.password === 'string' ? fields.password : '' };
  }

  const server = Bun.serve({
    fetch: () => new Response('not found', { status: 404 }),
    port: 0,
    routes: {
      '/': new Response('ok'),
      '/api/auth/sign-in': {
        POST: async (request) => {
          const input = await credentials(request);
          if (input instanceof Response) {
            return input;
          }
          const stored = users.get(input.name);
          if (stored === undefined) {
            unknownSignIns += 1;
            return sabotage === 'unknown-user-accepted'
              ? session(input.name, 200)
              : error(request, 401, 'Invalid credentials');
          }
          if (stored !== input.password || sabotage === 'sign-in-401') {
            return error(request, 401, 'Invalid credentials');
          }
          return session(input.name, 200);
        },
      },
      '/api/auth/sign-up': {
        POST: async (request) => {
          const input = await credentials(request);
          if (input instanceof Response) {
            return input;
          }
          // `pool-exists`: the sign-in pool was left behind by an aborted earlier run.
          if (sabotage === 'pool-exists' && /p[0-9]+$/u.test(input.name)) {
            users.set(input.name, PASSWORD);
          }
          if (users.has(input.name)) {
            return error(request, 409, 'User already exists');
          }
          users.set(input.name, input.password);
          return session(input.name, 201);
        },
      },
    },
  });

  return {
    baseUrl: `http://localhost:${server.port}`,
    stop: async () => server.stop(true),
    unknownSignIns: () => unknownSignIns,
  };
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function jwtLike(name: string): string {
  return `${base64url('{"alg":"HS256"}')}.${base64url(JSON.stringify({ name }))}.${base64url('signature')}`;
}
