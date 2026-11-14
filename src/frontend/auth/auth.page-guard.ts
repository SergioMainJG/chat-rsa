// Browser side of the route guard. Guarded pages start with `<html data-guard="pending">`, which
// styles.css hides; CSS blocks the first paint, so nothing shows until `revealPage` runs. A page the
// token may not see is left hidden and replaced, so it never flashes before the redirect.
import { guardRoute, type PageAccess } from './presentation/auth.guard.ts';

export const TOKEN_KEY = 'chat-rsa.token';

/** Redirects (with `replace`, out of the history) when the page is not for this visitor. */
export function enforceAccess(access: PageAccess): boolean {
  const decision = guardRoute(access, storedToken(), Date.now());
  if (decision.kind === 'redirect') {
    location.replace(decision.path);
    return false;
  }
  return true;
}

export function revealPage(): void {
  delete document.documentElement.dataset.guard;
}

export function storedToken(): null | string {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // Blocked storage means no stored session.
    return null;
  }
}
