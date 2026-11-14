import type { AuthResponse, PublicUser } from '../../../shared/contracts/auth.contract.ts';
import type {
  HistoryPage,
  IdentityKeyView,
  RoomSummary,
  SenderKeyEnvelopeView,
} from '../../../shared/contracts/messaging.contract.ts';
import type { SenderKeyEnvelopeUpload } from '../crypto/messaging.crypto.session.ts';

import {
  arrayOf,
  isAuthResponse,
  isHistoryPage,
  isIdentityKeyView,
  isPublicUser,
  isRecord,
  isRoomReceipt,
  isRoomSummary,
  isSenderKeyEnvelopeView,
  type RoomReceipt,
} from './chat.api.guards.ts';

/**
 * What a REST call means for the page. `unauthorized` (a 401, or no token at all) has already been
 * reported through `onUnauthorized`, which sends the user to /sign-in.
 */
export type ApiOutcome<T> =
  | { readonly kind: 'failure'; readonly message: string; readonly status: number }
  | { readonly kind: 'not-found'; readonly message: string }
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  | { readonly kind: 'unauthorized' };

export type ChatApiDeps = {
  readonly fetch: FetchLike;
  readonly getToken: () => null | string;
  /** Called on every 401; the page clears the token and goes to /sign-in. */
  readonly onUnauthorized: () => void;
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type { RoomReceipt } from './chat.api.guards.ts';

/** Returned by a parser for a body of the wrong shape. */
const INVALID: unique symbol = Symbol('invalid body');

type Parse<T> = (body: unknown) => T | typeof INVALID;

export const NETWORK_ERROR = 'Network error. Check your connection.';
export const UNEXPECTED_RESPONSE = 'Unexpected response from the server';

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_AFTER_SECONDS = 1;

/** The REST calls of the chat page. Every call carries the JWT as a Bearer token. */
export class ChatApi {
  readonly #deps: ChatApiDeps;

  constructor(deps: ChatApiDeps) {
    this.#deps = deps;
  }

  async addMember(roomId: string, userId: number): Promise<ApiOutcome<RoomSummary>> {
    return this.#request(
      'POST',
      `${roomPath(roomId)}/members`,
      { userId },
      parseWith(isRoomSummary),
    );
  }

  async createRoom(name: string, memberIds: readonly number[]): Promise<ApiOutcome<RoomSummary>> {
    return this.#request('POST', '/api/rooms', { memberIds, name }, parseWith(isRoomSummary));
  }

  async findUser(name: string): Promise<ApiOutcome<PublicUser>> {
    return this.#request(
      'GET',
      `/api/users/${encodeURIComponent(name)}`,
      undefined,
      parseWith(isPublicUser),
    );
  }

  /** One page of a room's history, newest first; pass the previous page's `nextBefore` as `before`. */
  async history(
    roomId: string,
    { before, limit }: { readonly before?: string; readonly limit: number },
  ): Promise<ApiOutcome<HistoryPage>> {
    const query = new URLSearchParams();
    if (before !== undefined) {
      query.set('before', before);
    }
    query.set('limit', String(limit));
    return this.#request(
      'GET',
      `${roomPath(roomId)}/messages?${query.toString()}`,
      undefined,
      parseWith(isHistoryPage),
    );
  }

  async leaveRoom(roomId: string): Promise<ApiOutcome<null>> {
    return this.#request('DELETE', `${roomPath(roomId)}/members/me`, undefined, ignoreBody);
  }

  async listRooms(): Promise<ApiOutcome<RoomSummary[]>> {
    return this.#request('GET', '/api/rooms', undefined, parseWith(arrayOf(isRoomSummary)));
  }

  async publishIdentity(publicKey: string): Promise<ApiOutcome<null>> {
    return this.#request('PUT', '/api/keys/identity', { publicKey }, ignoreBody);
  }

  async receipts(roomId: string): Promise<ApiOutcome<RoomReceipt[]>> {
    return this.#request(
      'GET',
      `${roomPath(roomId)}/receipts`,
      undefined,
      parseWith(arrayOf(isRoomReceipt)),
    );
  }

  /** Exchanges the current JWT for a fresh one. */
  async refresh(): Promise<ApiOutcome<AuthResponse>> {
    return this.#request('POST', '/api/auth/refresh', undefined, parseWith(isAuthResponse));
  }

  async roomKeys(roomId: string): Promise<ApiOutcome<IdentityKeyView[]>> {
    return this.#request(
      'GET',
      `${roomPath(roomId)}/keys`,
      undefined,
      parseWith(arrayOf(isIdentityKeyView)),
    );
  }

  /** The id and name of every member of the room (members only). */
  async roomMembers(roomId: string): Promise<ApiOutcome<PublicUser[]>> {
    return this.#request(
      'GET',
      `${roomPath(roomId)}/members`,
      undefined,
      parseWith(arrayOf(isPublicUser)),
    );
  }

  /** Revokes this sign-in session on the server: the token and every token refreshed from it. */
  async signOut(): Promise<ApiOutcome<null>> {
    return this.#request('POST', '/api/auth/sign-out', undefined, ignoreBody);
  }

  /** Envelopes addressed to this user for the epoch. */
  async senderKeys(roomId: string, keyEpoch: number): Promise<ApiOutcome<SenderKeyEnvelopeView[]>> {
    return this.#request(
      'GET',
      `${roomPath(roomId)}/sender-keys?keyEpoch=${keyEpoch}`,
      undefined,
      parseWith(arrayOf(isSenderKeyEnvelopeView)),
    );
  }

  async uploadSenderKeys(
    roomId: string,
    keyEpoch: number,
    envelopes: readonly SenderKeyEnvelopeUpload[],
  ): Promise<ApiOutcome<null>> {
    return this.#request(
      'POST',
      `${roomPath(roomId)}/sender-keys`,
      {
        // The server rejects unknown keys: room and epoch travel once, in the path and the body.
        envelopes: envelopes.map(
          ({ authTag, ciphertext, ephemeralPublicKey, iv, recipientId }) => ({
            authTag,
            ciphertext,
            ephemeralPublicKey,
            iv,
            recipientId,
          }),
        ),
        keyEpoch,
      },
      ignoreBody,
    );
  }

  async #request<T>(
    method: string,
    url: string,
    body: unknown,
    parse: Parse<T>,
  ): Promise<ApiOutcome<T>> {
    const token = this.#deps.getToken();
    if (token === null) {
      this.#deps.onUnauthorized();
      return { kind: 'unauthorized' };
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const init: RequestInit = { headers, method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.#deps.fetch(url, init);
    } catch {
      return { kind: 'failure', message: NETWORK_ERROR, status: 0 };
    }
    const outcome = await outcomeOf(response, parse);
    if (outcome.kind === 'unauthorized') {
      this.#deps.onUnauthorized();
    }
    return outcome;
  }
}

/** Maps a response to its outcome; `parse` returns INVALID for a body of the wrong shape. */
export async function outcomeOf<T>(response: Response, parse: Parse<T>): Promise<ApiOutcome<T>> {
  const text = await response.text().catch(() => '');
  const body = parseJson(text);
  if (response.ok) {
    const value = parse(body);
    return value === INVALID
      ? { kind: 'failure', message: UNEXPECTED_RESPONSE, status: response.status }
      : { kind: 'ok', value };
  }
  switch (response.status) {
    case 401: {
      return { kind: 'unauthorized' };
    }
    case 404: {
      return { kind: 'not-found', message: messageOf(body) };
    }
    case 429: {
      return { kind: 'rate-limited', retryAfterSeconds: retryAfter(response.headers) };
    }
    default: {
      return { kind: 'failure', message: messageOf(body), status: response.status };
    }
  }
}

/** Responses whose body the page does not need (204, or an echo it ignores). */
function ignoreBody(): null {
  return null;
}

function messageOf(body: unknown): string {
  return isRecord(body) && typeof body.message === 'string' && body.message !== ''
    ? body.message
    : 'Something went wrong. Please try again.';
}

function parseJson(text: string): unknown {
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseWith<T>(guard: (value: unknown) => value is T): Parse<T> {
  return (body) => (guard(body) ? body : INVALID);
}

function retryAfter(headers: Headers): number {
  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
}

function roomPath(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}`;
}
