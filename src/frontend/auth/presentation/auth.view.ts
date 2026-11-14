import type { AuthResponse, Credentials } from '../../../shared/contracts/auth.contract.ts';

/** What a sign-in or sign-up response means for the page, independent of the DOM. */
export type AuthOutcome =
  | {
      readonly fieldErrors: Readonly<Record<string, string>>;
      readonly kind: 'failure';
      readonly message: string;
    }
  | { readonly kind: 'success'; readonly redirectTo: string; readonly session: AuthResponse };

/** Signing in or up takes the user straight to the chat room. */
export const AFTER_AUTH_PATH = '/chat';

export const GENERIC_ERROR = 'Something went wrong. Please try again.';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isSession(value: unknown): value is AuthResponse {
  return (
    isRecord(value) &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    isRecord(value.user) &&
    typeof value.user.id === 'number' &&
    typeof value.user.name === 'string'
  );
}

/** Missing fields become empty strings, so the server reports them as required. */
export function credentialsFrom(form: FormData): Credentials {
  const field = (key: string): string => {
    const value = form.get(key);
    return typeof value === 'string' ? value : '';
  };
  return { name: field('name'), password: field('password') };
}

/**
 * Whether a stored JWT has not expired yet, read from its unverified payload. It only decides
 * whether the auth pages send the user on to the chat room; the server still verifies the token,
 * and the chat page clears it on a 401, so a forged or revoked token cannot loop.
 */
export function hasLiveSession(token: null | string, nowMs: number): boolean {
  const payload = token?.split('.')[1];
  if (payload === undefined) {
    return false;
  }
  try {
    const claims: unknown = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')));
    return isRecord(claims) && typeof claims.exp === 'number' && claims.exp * 1000 > nowMs;
  } catch {
    return false;
  }
}

export async function outcomeOf(response: Response): Promise<AuthOutcome> {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && isSession(body)) {
    return { kind: 'success', redirectTo: AFTER_AUTH_PATH, session: body };
  }
  if (!response.ok && isRecord(body) && typeof body.message === 'string') {
    return { fieldErrors: fieldErrorsOf(body.errors), kind: 'failure', message: body.message };
  }
  return { fieldErrors: {}, kind: 'failure', message: GENERIC_ERROR };
}

function fieldErrorsOf(errors: unknown): Record<string, string> {
  if (!Array.isArray(errors)) {
    return {};
  }
  const byField: Record<string, string> = {};
  for (const entry of errors) {
    if (isRecord(entry) && typeof entry.field === 'string' && typeof entry.message === 'string') {
      byField[entry.field] ??= entry.message;
    }
  }
  return byField;
}
