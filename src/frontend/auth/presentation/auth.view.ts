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

const EPOCH_SECONDS = /^\d{1,12}$/u;

/**
 * Whether the `chat_rsa_session_hint` cookie (the token's `exp`, in epoch seconds) is still in the
 * future. It only decides whether the auth pages send the user on to the chat room: the JWT itself
 * is HttpOnly and verified by the server, and the chat page deletes the hint on a 401, so a forged
 * hint cannot loop.
 */
export function hasLiveSession(hint: null | string, nowMs: number): boolean {
  return hint !== null && EPOCH_SECONDS.test(hint) && Number(hint) * 1000 > nowMs;
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
