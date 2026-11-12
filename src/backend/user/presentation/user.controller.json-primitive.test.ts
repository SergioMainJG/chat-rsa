import { describe, expect, test } from 'bun:test';

import type { ErrorResponse } from '../../../shared/contracts/error.contract.ts';

import { ok } from '../../shared/domain/result.ts';
import { type AuthUseCase, createAuthController } from './user.controller.ts';

// Run 2 survivor (user.controller.ts:42): `typeof body !== 'object'` -> `false` survived because
// only `[1, 2]` and `null` were tested. A JSON primitive then reached the use case and failed later
// as a field-validation error, so this pins the controller's own guard: exact message, no field
// errors, and the use case is never called.

const PRIMITIVES = ['42', '-1.5', 'true', 'false', '"quoted"', '""'] as const;

function spyUseCase(): AuthUseCase & { readonly calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    execute: async (input) => {
      calls.push(input);
      return ok({ token: 'jwt', user: { id: 1, name: 'alice' } });
    },
  };
}

describe.each(['/api/auth/sign-up', '/api/auth/sign-in'] as const)('POST %s with a JSON primitive body', (path) => {
  test.each(PRIMITIVES)('rejects %s as not being a JSON object, before the use case runs', async (raw) => {
    expect(typeof JSON.parse(raw)).not.toBe('object');
    const useCase = spyUseCase();
    const logged: unknown[] = [];
    const controller = createAuthController(
      { signIn: useCase, signUp: useCase },
      {
        error: (error) => {
          logged.push(error);
        },
      },
    );
    const request = new Request(`http://localhost${path}`, {
      body: raw,
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    const response = path === '/api/auth/sign-up' ? await controller.signUp(request) : await controller.signIn(request);
    const body: ErrorResponse = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      correlationId: expect.any(String),
      error: 'Bad Request',
      message: 'Request body must be a JSON object',
      path,
      statusCode: 400,
      timestamp: expect.any(String),
    });
    expect(useCase.calls).toEqual([]);
    expect(logged).toEqual([]);
  });
});
