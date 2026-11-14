import { jwtVerify, SignJWT } from 'jose';

import type { User } from '../domain/user.entity.ts';

import { type TokenClaims, TokenIssuer, TokenVerifier } from '../domain/user.security.ts';
import { UserId } from '../domain/user.value-objects.ts';

/** How long one token lives; a revoked session must stay revoked at least this long. */
export const TOKEN_LIFETIME_SECONDS = 3600;

export class JoseTokenIssuer extends TokenIssuer {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly expiresIn = `${TOKEN_LIFETIME_SECONDS}s`,
  ) {
    super();
    this.key = new TextEncoder().encode(secret);
  }

  override async issue(user: User, sessionId: string = crypto.randomUUID()): Promise<string> {
    return new SignJWT({ name: user.name.value, sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(user.id))
      .setIssuedAt()
      .setExpirationTime(this.expiresIn)
      .sign(this.key);
  }
}

/**
 * Verifies tokens from `JoseTokenIssuer`: HS256 only, with a numeric subject, a session id and an
 * expiry.
 */
export class JoseTokenVerifier extends TokenVerifier {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    super();
    this.key = new TextEncoder().encode(secret);
  }

  override async verify(token: string): Promise<null | TokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      const userId = Number(payload.sub);
      if (
        !Number.isInteger(userId) ||
        userId < 1 ||
        typeof payload.exp !== 'number' ||
        typeof payload.name !== 'string' ||
        typeof payload.sid !== 'string' ||
        payload.sid === ''
      ) {
        return null;
      }
      return {
        expiresAt: new Date(payload.exp * 1000),
        name: payload.name,
        sessionId: payload.sid,
        userId: UserId.restore(userId),
      };
    } catch {
      return null;
    }
  }
}
