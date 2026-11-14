import type { PublicUser } from '../../../shared/contracts/auth.contract.ts';
import type { IssuedToken } from '../domain/user.security.ts';

/**
 * A signed-in session as the use cases return it. The token and its expiry go into cookies; only
 * `user` reaches the response body.
 */
export type AuthSession = IssuedToken & { readonly user: PublicUser };
