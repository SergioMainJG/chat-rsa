import type { AuthResponse, Credentials } from '../../../shared/contracts/auth.contract.ts';

/** What a sign-in or sign-up response means for the page, independent of the DOM. */
export type AuthOutcome =
  | {
      readonly fieldErrors: Readonly<Record<string, string>>;
      readonly kind: 'failure';
      readonly message: string;
    }
  | { readonly kind: 'success'; readonly session: AuthResponse };

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

export async function outcomeOf(response: Response): Promise<AuthOutcome> {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && isSession(body)) {
    return { kind: 'success', session: body };
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
