import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import { adjacencyGraphs, dictionary } from '@zxcvbn-ts/language-common';

import type { FieldError } from '../../../shared/contracts/error.contract.ts';

import { brand, type Brand } from '../../shared/domain/brand.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';

export type PasswordHash = Brand<string, 'PasswordHash'>;
export type UserId = Brand<number, 'UserId'>;
type PasswordValue = Brand<string, 'Password'>;
type UserNameValue = Brand<string, 'UserName'>;

/** Longest accepted name; it is stored and copied into every token. */
export const MAX_NAME_LENGTH = 64;

/** Longest accepted password: zxcvbn-ts only scores the first 256 characters. */
export const MAX_PASSWORD_LENGTH = 256;

/** Lowest zxcvbn score (0-4) accepted as a password. */
export const MIN_PASSWORD_SCORE = 3;

const NAME_PATTERN = /^[\p{L}\p{N}]+$/u;

const zxcvbn = new ZxcvbnFactory({ dictionary, graphs: adjacencyGraphs });

export const UserId = {
  /** Rehydrates an id that the database generated. */
  restore(value: number): UserId {
    return brand<number, 'UserId'>(value);
  },
};

export const PasswordHash = {
  restore(value: string): PasswordHash {
    return brand<string, 'PasswordHash'>(value);
  },
};

/** Letters and numbers only, no spaces. */
export class UserName {
  private constructor(readonly value: UserNameValue) {}

  static create(raw: unknown): Result<UserName, FieldError> {
    if (typeof raw !== 'string' || raw.length === 0) {
      return err({ field: 'name', message: 'Name is required' });
    }
    if (raw.length > MAX_NAME_LENGTH) {
      return err({ field: 'name', message: `Name must be at most ${MAX_NAME_LENGTH} characters` });
    }
    if (!NAME_PATTERN.test(raw)) {
      return err({
        field: 'name',
        message: 'Name must contain only letters and numbers, without spaces',
      });
    }
    return ok(new UserName(brand<string, 'UserName'>(raw)));
  }

  /** Rehydrates a name that was validated before it was stored. */
  static restore(value: string): UserName {
    return new UserName(brand<string, 'UserName'>(value));
  }

  equals(other: UserName): boolean {
    return this.value === other.value;
  }
}

/** Plain-text password that passed the zxcvbn strength check. Never persisted. */
export class Password {
  private constructor(readonly value: PasswordValue) {}

  /** A new password (sign-up): present, bounded, and strong enough for zxcvbn. */
  static create(raw: unknown, userInputs: readonly string[] = []): Result<Password, FieldError> {
    const bounded = Password.forVerification(raw);
    if (!bounded.ok) {
      return bounded;
    }
    const { score } = zxcvbn.check(bounded.value.value, [...userInputs]);
    if (score < MIN_PASSWORD_SCORE) {
      return err({ field: 'password', message: 'Password is too weak' });
    }
    return bounded;
  }

  /**
   * A password to compare with a stored hash (sign-in): present and bounded, never
   * strength-checked, so accounts whose password predates the strength rule can still sign in.
   */
  static forVerification(raw: unknown): Result<Password, FieldError> {
    if (typeof raw !== 'string' || raw.length === 0) {
      return err({ field: 'password', message: 'Password is required' });
    }
    if (raw.length > MAX_PASSWORD_LENGTH) {
      return err({
        field: 'password',
        message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters`,
      });
    }
    return ok(new Password(brand<string, 'Password'>(raw)));
  }
}
