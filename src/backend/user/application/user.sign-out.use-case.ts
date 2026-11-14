import { type AppError, UnauthorizedError } from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import {
  type SessionRevocations,
  type TokenClaims,
  TokenVerifier,
} from '../domain/user.security.ts';

/**
 * Wraps the signature check with the revocation list, so every caller (HTTP guard, refresh, socket
 * upgrade and `auth.refresh`) refuses a signed-out session. It fails closed: when the list cannot
 * be read, the token is refused.
 */
export class RevocationAwareTokenVerifier extends TokenVerifier {
  constructor(
    private readonly inner: TokenVerifier,
    private readonly revocations: SessionRevocations,
  ) {
    super();
  }

  override async verify(token: string): Promise<null | TokenClaims> {
    const claims = await this.inner.verify(token);
    if (claims === null) {
      return null;
    }
    const revoked = await this.revocations.isRevoked(claims.sessionId).catch(() => true);
    return revoked ? null : claims;
  }
}

/** Ends the session of a token: it and every token refreshed from it stop working. */
export class SignOutUseCase {
  constructor(
    private readonly verifier: TokenVerifier,
    private readonly revocations: SessionRevocations,
    /** Closes whatever is still open for the session, such as its sockets. */
    private readonly onSignedOut: (sessionId: string) => void,
  ) {}

  async execute(token: string): Promise<Result<null, AppError>> {
    const claims = await this.verifier.verify(token);
    if (claims === null) {
      return err(new UnauthorizedError('Invalid or expired token'));
    }
    await this.revocations.revoke(claims.sessionId);
    this.onSignedOut(claims.sessionId);
    return ok(null);
  }
}
