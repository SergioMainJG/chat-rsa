const UNSAFE_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

/** True for the methods a CSRF attack uses to change state. */
export function isUnsafeMethod(request: Request): boolean {
  return UNSAFE_METHODS.has(request.method.toUpperCase());
}

/** The request's `Origin` header, or null when it has none. */
export function originOf(request: Request): null | string {
  return request.headers.get('origin');
}

/** Whether the request carries an `Origin` header that is exactly one of `origins`. */
export function hasAllowedOrigin(request: Request, origins: readonly string[]): boolean {
  const origin = originOf(request);
  return origin !== null && origins.includes(origin);
}
