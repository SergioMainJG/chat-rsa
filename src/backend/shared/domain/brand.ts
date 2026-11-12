declare const brandSymbol: unique symbol;

/** Nominal type: a `Brand<number, 'UserId'>` is not assignable from a plain number. */
export type Brand<T, Name extends string> = T & { readonly [brandSymbol]: Name };

/**
 * The only place a raw value is sealed as a nominal type. Callers must validate (or trust the
 * source, such as the database) before branding.
 */
export function brand<T, Name extends string>(value: T): Brand<T, Name> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a brand only exists at the type level, so sealing it requires one assertion
  return value as Brand<T, Name>;
}
