import type { FieldError } from '../../../shared/contracts/error.contract.ts';

import { ValidationError } from '../../shared/domain/app.error.ts';
import { err, ok, type Result } from '../../shared/domain/result.ts';
import { Password, UserName } from '../domain/user.value-objects.ts';

/** Raw request body: anything may arrive, so every field is validated. */
export type CredentialsInput = {
  readonly name?: unknown;
  readonly password?: unknown;
};

export type ValidCredentials = {
  readonly name: UserName;
  readonly password: Password;
};

/** Sign-up: a new password must also be strong, judged with the name as a user input. */
export function parseSignUpCredentials(
  input: CredentialsInput,
): Result<ValidCredentials, ValidationError> {
  return combine(
    UserName.create(input.name),
    Password.create(input.password, typeof input.name === 'string' ? [input.name] : []),
  );
}

/** Sign-in: the password is only compared with the stored hash, so it is not strength-checked. */
export function parseSignInCredentials(
  input: CredentialsInput,
): Result<ValidCredentials, ValidationError> {
  return combine(UserName.create(input.name), Password.forVerification(input.password));
}

/** Reports every failing field at once. */
function combine(
  name: Result<UserName, FieldError>,
  password: Result<Password, FieldError>,
): Result<ValidCredentials, ValidationError> {
  const errors: FieldError[] = [];
  if (!name.ok) {
    errors.push(name.error);
  }
  if (!password.ok) {
    errors.push(password.error);
  }

  if (!name.ok || !password.ok) {
    return err(new ValidationError(errors));
  }
  return ok({ name: name.value, password: password.value });
}
