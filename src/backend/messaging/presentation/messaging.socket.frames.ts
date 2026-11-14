import type { Input } from '../application/messaging.access.ts';

import {
  BEARER_PREFIX,
  type ClientFrame,
  type ServerFrame,
  SOCKET_PROTOCOL,
  type SocketErrorCode,
} from '../../../shared/contracts/messaging.socket.contract.ts';
import { AppError } from '../../shared/domain/app.error.ts';

export type FrameType = ClientFrame['type'];

/** A client frame whose shape was checked; its values are still checked by the use cases. */
export type ParsedFrame = {
  readonly input: Input;
  readonly type: FrameType;
};

/** Every field each client frame may carry; any other field makes the frame a `bad_frame`. */
const FRAME_FIELDS: Readonly<Record<FrameType, readonly string[]>> = {
  'auth.refresh': ['token', 'type'],
  'message.send': [
    'authTag',
    'chainIndex',
    'ciphertext',
    'idempotencyKey',
    'iv',
    'keyEpoch',
    'roomId',
    'type',
  ],
  receipt: ['kind', 'messageId', 'roomId', 'type'],
  'room.subscribe': ['roomId', 'type'],
  typing: ['active', 'roomId', 'type'],
};

/** Returned by `upgrade` while the gateway drains for a shutdown. */
export class ServiceUnavailableError extends AppError {
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * The JWT of an upgrade request: `Sec-WebSocket-Protocol` must list `chat-rsa.v1` and exactly one
 * non-empty `bearer.<jwt>` entry. Null for anything else.
 */
export function bearerTokenOf(request: Request): null | string {
  const header = request.headers.get('sec-websocket-protocol');
  if (header === null) {
    return null;
  }
  const entries = header.split(',').map((entry) => entry.trim());
  const bearers = entries.filter((entry) => entry.startsWith(BEARER_PREFIX));
  const [bearer] = bearers;
  if (!entries.includes(SOCKET_PROTOCOL) || bearers.length !== 1 || bearer === undefined) {
    return null;
  }
  const token = bearer.slice(BEARER_PREFIX.length);
  return token.length > 0 ? token : null;
}

/** The socket error code of an `AppError`, by HTTP status. */
export function codeOf(error: AppError): SocketErrorCode {
  const codes: Readonly<Record<number, SocketErrorCode>> = {
    400: 'validation',
    401: 'auth_failed',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    429: 'rate_limited',
  };
  return codes[error.statusCode] ?? 'internal';
}

export function encode(frame: ServerFrame): string {
  return JSON.stringify(frame);
}

export function errorFrame(
  code: SocketErrorCode,
  message: string,
  ref: null | string,
): ServerFrame {
  return { code, message, ref, type: 'error' };
}

/**
 * Strict frame parsing: a text frame holding one JSON object with a known `type` and no field
 * outside that type's list. Null for anything else (binary, invalid JSON, arrays, unknown types).
 */
export function parseClientFrame(raw: Buffer | string): null | ParsedFrame {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = parseJson(raw);
  if (!isRecord(value) || !isFrameType(value.type)) {
    return null;
  }
  const allowed = FRAME_FIELDS[value.type];
  return Object.keys(value).every((key) => allowed.includes(key))
    ? { input: value, type: value.type }
    : null;
}

/** The id an error frame refers to: the idempotency key of a send, the room id otherwise. */
export function refOf(frame: ParsedFrame): null | string {
  const ref = frame.type === 'message.send' ? frame.input.idempotencyKey : frame.input.roomId;
  return typeof ref === 'string' ? ref : null;
}

function isFrameType(value: unknown): value is FrameType {
  return typeof value === 'string' && Object.hasOwn(FRAME_FIELDS, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
