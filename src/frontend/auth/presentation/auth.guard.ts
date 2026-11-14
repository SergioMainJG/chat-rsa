import { AFTER_AUTH_PATH, hasLiveSession } from './auth.view.ts';

/** Who may see a page: signed-in members (the chat) or guests (sign-in and sign-up). */
export type GuardDecision =
  { readonly kind: 'allow' } | { readonly kind: 'redirect'; readonly path: string };

export type PageAccess = 'guests' | 'members';

export const SIGN_IN_PATH = '/sign-in';

/**
 * Decides, before the page is shown, whether the stored token may see it. Only the token's own
 * expiry is checked here; the server still verifies every request (signature and revocation).
 */
export function guardRoute(access: PageAccess, token: null | string, nowMs: number): GuardDecision {
  const live = hasLiveSession(token, nowMs);
  if (access === 'members' && !live) {
    return { kind: 'redirect', path: SIGN_IN_PATH };
  }
  if (access === 'guests' && live) {
    return { kind: 'redirect', path: AFTER_AUTH_PATH };
  }
  return { kind: 'allow' };
}
