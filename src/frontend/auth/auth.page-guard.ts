// Browser side of the route guard. Guarded pages start with `<html data-guard="pending">`, which
// styles.css hides; CSS blocks the first paint, so nothing shows until `revealPage` runs. A page the
// visitor may not see is left hidden and replaced, so it never flashes before the redirect. The
// guard reads only the session hint cookie: the JWT is HttpOnly and never visible to JS.
import { SESSION_HINT_COOKIE } from '../../shared/contracts/auth.contract.ts';
import { guardRoute, type PageAccess, sessionHintOf } from './presentation/auth.guard.ts';

/** Deletes the hint cookie (the server clears both cookies at sign-out; this covers a failure). */
export function clearSessionHint(): void {
  document.cookie = `${SESSION_HINT_COOKIE}=; Max-Age=0; Path=/; Secure; SameSite=Strict`;
}

/** Redirects (with `replace`, out of the history) when the page is not for this visitor. */
export function enforceAccess(access: PageAccess): boolean {
  const decision = guardRoute(access, sessionHint(), Date.now());
  if (decision.kind === 'redirect') {
    location.replace(decision.path);
    return false;
  }
  return true;
}

export function revealPage(): void {
  delete document.documentElement.dataset.guard;
}

/** The current hint cookie's value, or null. */
export function sessionHint(): null | string {
  return sessionHintOf(document.cookie);
}
