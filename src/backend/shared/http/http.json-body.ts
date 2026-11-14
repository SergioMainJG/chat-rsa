import type { FieldError } from '../../../shared/contracts/error.contract.ts';

import {
  AppError,
  BadRequestError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../domain/app.error.ts';

/** Untrusted request body or query string; values still need a value object before use. */
export type JsonObject = Readonly<Record<string, unknown>>;

export const MAX_JSON_BODY_BYTES = 64 * 1024;

export class PayloadTooLargeError extends AppError {
  readonly statusCode = 413;

  constructor(message: string) {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

/** Media type without parameters, lower-cased. */
function mediaTypeOf(request: Request): string {
  return (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * The body as text, refusing more than `max` bytes. A declared length is checked first, and the
 * stream is cut off as soon as it passes the cap, so a lying or missing length cannot exhaust
 * memory.
 */
async function readCappedText(request: Request, max: number): Promise<string> {
  const tooLarge = new PayloadTooLargeError(`Request body must be at most ${max} bytes`);
  if (Number(request.headers.get('content-length') ?? 0) > max) {
    throw tooLarge;
  }
  if (!request.body) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request.body) {
    total += chunk.byteLength;
    if (total > max) {
      throw tooLarge;
    }
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** One error per key that is not in `allowed`, with `prefix` before nested field names. */
export function unknownKeyErrors(
  record: object,
  allowed: readonly string[],
  prefix = '',
): FieldError[] {
  return Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ field: `${prefix}${key}`, message: 'Unknown field' }));
}

/**
 * Strict JSON body: `application/json` only (415), at most 64 KiB (413), a JSON object (400), and
 * no keys outside `allowedKeys` (400 listing each one).
 */
export async function readJsonObject(
  request: Request,
  allowedKeys: readonly string[],
): Promise<JsonObject> {
  if (mediaTypeOf(request) !== 'application/json') {
    throw new UnsupportedMediaTypeError('Content-Type must be application/json');
  }
  const body = parseJson(await readCappedText(request, MAX_JSON_BODY_BYTES));
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestError('Request body must be a JSON object');
  }
  const unknown = unknownKeyErrors(body, allowedKeys);
  if (unknown.length > 0) {
    throw new ValidationError(unknown);
  }
  return Object.fromEntries(Object.entries(body));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError('Request body must be valid JSON');
  }
}

/** Strict query string: each allowed parameter at most once, and nothing else. */
export function readQuery(url: URL, allowedKeys: readonly string[]): JsonObject {
  const errors: FieldError[] = [];
  const seen = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!allowedKeys.includes(key)) {
      errors.push({ field: key, message: 'Unknown field' });
    } else if (seen.has(key)) {
      errors.push({ field: key, message: 'Repeated field' });
    } else {
      seen.set(key, value);
    }
  }
  if (errors.length > 0) {
    throw new ValidationError(errors);
  }
  return Object.fromEntries(seen);
}
