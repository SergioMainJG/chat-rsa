/** Expected failures travel as values; unexpected ones are thrown. */
export type Result<T, E> =
  { readonly error: E; readonly ok: false } | { readonly ok: true; readonly value: T };

export function err<E>(error: E): Result<never, E> {
  return { error, ok: false };
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Success without a value, for guards. */
export function okVoid(): Result<void, never> {
  return { ok: true, value: undefined };
}
