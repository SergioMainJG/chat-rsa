import type { EncryptedPayloadWire, MessageView } from './messaging.contract.ts';

/**
 * WebSocket protocol between the chat page and `/ws`. Every frame is one JSON text message with a
 * `type` discriminator.
 *
 * Authentication: the browser cannot set headers on a WebSocket, so the JWT travels in the upgrade
 * request as a subprotocol: `new WebSocket(url, [SOCKET_PROTOCOL, BEARER_PREFIX + jwt])`. The
 * server answers with `SOCKET_PROTOCOL` only.
 */
export const SOCKET_PROTOCOL = 'chat-rsa.v1';
export const BEARER_PREFIX = 'bearer.';
export const SOCKET_PATH = '/ws';

/** Custom close codes (4000-4999 are reserved for applications). */
export const CloseCode = {
  /** The JWT expired, or a refresh was rejected. Sign in again, then reconnect. */
  AuthFailed: 4001,
  /** The server is shutting down (SIGTERM); reconnect with backoff. */
  GoingAway: 1001,
  /** The client stopped answering pings. */
  HeartbeatTimeout: 4008,
  /** The client sent frames faster than allowed or a malformed frame. */
  PolicyViolation: 1008,
} as const;

export type ClientFrame =
  | (EncryptedPayloadWire & {
      readonly chainIndex: number;
      readonly idempotencyKey: string;
      readonly keyEpoch: number;
      readonly roomId: string;
      readonly type: 'message.send';
    })
  | {
      readonly active: boolean;
      readonly roomId: string;
      readonly type: 'typing';
    }
  | {
      readonly kind: 'delivered' | 'read';
      readonly messageId: string;
      readonly roomId: string;
      readonly type: 'receipt';
    }
  /** Joins the live feed of a room the user was added to after connecting. */
  | { readonly roomId: string; readonly type: 'room.subscribe' }
  /** Replaces the connection's JWT before it expires, without reconnecting. */
  | { readonly token: string; readonly type: 'auth.refresh' };

export type ServerFrame =
  | {
      /** True when the idempotency key was already stored; `message` is the original. */
      readonly duplicate: boolean;
      readonly idempotencyKey: string;
      readonly message: MessageView;
      /** Persisted in PostgreSQL: the sender's copy is now `delivered`. */
      readonly type: 'message.ack';
    }
  | {
      readonly active: boolean;
      readonly roomId: string;
      readonly type: 'typing';
      readonly userId: number;
    }
  | {
      readonly code: SocketErrorCode;
      readonly message: string;
      /** The idempotency key or room id the error refers to, when there is one. */
      readonly ref: null | string;
      readonly type: 'error';
    }
  | {
      readonly delivered: null | string;
      readonly read: null | string;
      readonly roomId: string;
      readonly type: 'receipt';
      readonly userId: number;
    }
  | {
      readonly expiresAt: string;
      readonly roomIds: readonly string[];
      readonly type: 'ready';
      readonly userId: number;
    }
  | {
      readonly expiresAt: string;
      readonly type: 'auth.refreshed';
    }
  | {
      readonly keyEpoch: number;
      readonly roomId: string;
      /** Membership changed: senders must distribute a new chain key for this epoch. */
      readonly type: 'room.rotated';
    }
  | {
      readonly keyEpoch: number;
      readonly roomId: string;
      readonly senderId: number;
      /** New sender-key envelopes are stored; fetch them over REST. */
      readonly type: 'sender-keys.available';
    }
  | {
      readonly message: MessageView;
      readonly type: 'message.new';
    }
  | {
      readonly online: boolean;
      readonly roomId: string;
      readonly type: 'presence';
      readonly userId: number;
    }
  | {
      readonly online: readonly number[];
      readonly roomId: string;
      readonly type: 'presence.snapshot';
    };

/** Machine-readable error codes carried by `error` frames. */
export type SocketErrorCode =
  | 'auth_failed'
  | 'bad_frame'
  | 'conflict'
  | 'forbidden'
  | 'internal'
  | 'not_found'
  | 'rate_limited'
  | 'validation';
