import { decodeJwt, jwtVerify, SignJWT } from 'jose';

import type { User } from '../domain/user.entity.ts';

import {
  type IssuedToken,
  type SessionRef,
  type TokenClaims,
  TokenIssuer,
  TokenVerifier,
} from '../domain/user.security.ts';
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

  override async issue(user: User, existing?: SessionRef): Promise<IssuedToken> {
    const session = existing ?? { id: crypto.randomUUID(), startedAt: new Date() };
    const token = await new SignJWT({
      name: user.name.value,
      sid: session.id,
      sst: Math.floor(session.startedAt.getTime() / 1000),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(user.id))
      .setIssuedAt()
      .setExpirationTime(this.expiresIn)
      .sign(this.key);
    return { expiresAt: new Date(expiryOf(token) * 1000), token };
  }
}

/** The `exp` this issuer just signed; read back so the cookie hint matches the token exactly. */
function expiryOf(token: string): number {
  const exp: unknown = decodeJwt(token).exp;
  if (typeof exp !== 'number') {
    throw new TypeError('Issued token has no expiry');
  }
  return exp;
}

/**
 * Verifies tokens from `JoseTokenIssuer`: HS256 only, with a numeric subject, a session id, a
 * numeric session start and an expiry.
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
        payload.sid === '' ||
        typeof payload.sst !== 'number' ||
        !Number.isFinite(payload.sst)
      ) {
        return null;
      }
      return {
        expiresAt: new Date(payload.exp * 1000),
        name: payload.name,
        sessionId: payload.sid,
        sessionStartedAt: new Date(payload.sst * 1000),
        userId: UserId.restore(userId),
      };
    } catch {
      return null;
    }
  }
}
