import { SignJWT } from 'jose';

import type { User } from '../domain/user.entity.ts';

import { TokenIssuer } from '../domain/user.security.ts';

export class JoseTokenIssuer extends TokenIssuer {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly expiresIn = '1h',
  ) {
    super();
    this.key = new TextEncoder().encode(secret);
  }

  override async issue(user: User): Promise<string> {
    return new SignJWT({ name: user.name.value })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(user.id))
      .setIssuedAt()
      .setExpirationTime(this.expiresIn)
      .sign(this.key);
  }
}
