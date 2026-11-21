import { SESSION_HINT_COOKIE } from '../../../shared/contracts/auth.contract.ts';
import { pagePath } from '../../i18n/i18n.messages.ts';
import { afterAuthPath, hasLiveSession } from './auth.view.ts';

/** Who may see a page: signed-in members (the chat) or guests (sign-in and sign-up). */
export type GuardDecision =
  { readonly kind: 'allow' } | { readonly kind: 'redirect'; readonly path: string };

export type PageAccess = 'guests' | 'members';

/**
 * Decides, before the page is shown, whether the visitor may see it, from the session hint (the
 * token's expiry). The token itself is HttpOnly; the server still verifies every request (signature
 * and revocation).
 */
export function guardRoute(access: PageAccess, hint: null | string, nowMs: number): GuardDecision {
  const live = hasLiveSession(hint, nowMs);
  if (access === 'members' && !live) {
    return { kind: 'redirect', path: pagePath('sign-in') };
  }
  if (access === 'guests' && live) {
    return { kind: 'redirect', path: afterAuthPath() };
  }
  return { kind: 'allow' };
}

/** The `chat_rsa_session_hint` value in a `document.cookie` string, or null. */
export function sessionHintOf(cookies: string): null | string {
  for (const pair of cookies.split(';')) {
    const [name, ...value] = pair.trim().split('=');
    if (name === SESSION_HINT_COOKIE) {
      const hint = value.join('=');
      return hint === '' ? null : hint;
    }
  }
  return null;
}
