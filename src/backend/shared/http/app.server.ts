import type { AuthController } from '../../user/presentation/user.controller.ts';

import signInPage from '../../../frontend/auth/sign-in.html';
import signUpPage from '../../../frontend/auth/sign-up.html';
import index from '../../../frontend/index.html';
import { NotFoundError } from '../domain/app.error.ts';
import { errorResponse } from './http.error-response.ts';

export type ServerDependencies = {
  readonly auth: AuthController;
  readonly development?: boolean;
  readonly port: number;
};

export function createServer({
  auth,
  development = false,
  port,
}: ServerDependencies): Bun.Server<undefined> {
  return Bun.serve({
    development,
    fetch: (request) =>
      errorResponse(
        request,
        new NotFoundError(`Route ${request.method} ${new URL(request.url).pathname} not found`),
      ),
    port,
    routes: {
      '/': index,
      '/api/auth/sign-in': { POST: auth.signIn },
      '/api/auth/sign-up': { POST: auth.signUp },
      '/sign-in': signInPage,
      '/sign-up': signUpPage,
    },
  });
}
