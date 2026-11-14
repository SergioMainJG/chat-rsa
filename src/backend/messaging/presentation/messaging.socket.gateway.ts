import type { Logger } from '../../shared/domain/logger.ts';
import type { BucketPolicy } from '../../shared/domain/token-bucket.ts';
import type { TokenVerifier } from '../../user/domain/user.security.ts';
import type { RoomEvents } from '../application/messaging.events.ts';
import type { ReceiptUseCase } from '../application/messaging.receipt.use-case.ts';
import type { ListRoomsUseCase } from '../application/messaging.rooms.use-case.ts';
import type { SendMessageUseCase } from '../application/messaging.send-message.use-case.ts';
import type { RoomRepository } from '../domain/messaging.repository.ts';

import {
  CloseCode,
  type ServerFrame,
  SOCKET_PROTOCOL,
} from '../../../shared/contracts/messaging.socket.contract.ts';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from '../../shared/domain/app.error.ts';
import { cookieOf, SESSION_COOKIE } from '../../shared/http/http.cookies.ts';
import { errorResponse } from '../../shared/http/http.error-response.ts';
import { hasAllowedOrigin } from '../../shared/http/http.origin.ts';
import { type Input, roomOfMember } from '../application/messaging.access.ts';
import { SocketConnection } from './messaging.socket.connection.ts';
import {
  bearerTokenOf,
  codeOf,
  encode,
  errorFrame,
  type FrameType,
  parseClientFrame,
  type ParsedFrame,
  refOf,
  ServiceUnavailableError,
} from './messaging.socket.frames.ts';
import { type Cancel, type Scheduler, systemScheduler } from './messaging.socket.scheduler.ts';

export type SocketGateway = {
  /**
   * Closes every socket of a signed-out session with 4001 (`auth_failed`), and remembers the
   * session so a socket of it that opens later (an upgrade verified just before the sign-out) is
   * closed the same way.
   */
  readonly closeSession: (sessionId: string) => void;
  readonly connectionCount: () => number;
  /** Stops new upgrades, waits for in-flight frames (sends being persisted), then closes with 1001. */
  readonly drain: () => Promise<void>;
  readonly events: RoomEvents;
  /** Frame tasks not settled yet; settled ones are forgotten, so this returns to 0 when idle. */
  readonly inFlightCount: () => number;
  /**
   * After `POST /api/auth/refresh`: moves the expiry of the session's sockets and pushes
   * `auth.refreshed` to them.
   */
  readonly renewSession: (sessionId: string, expiresAt: Date) => void;
  /** Handles `GET /ws`: undefined once upgraded, otherwise the JSON error response to return. */
  readonly upgrade: (
    request: Request,
    server: Bun.Server<SocketConnection>,
  ) => Promise<Response | undefined>;
  readonly websocket: Bun.WebSocketHandler<SocketConnection>;
};

export type SocketGatewayDependencies = {
  /** Per-socket frame budget. */
  readonly frameLimit?: BucketPolicy;
  readonly heartbeatIntervalMs?: number;
  /** A socket with no pong for this long is closed with 4008. Default: twice the interval. */
  readonly heartbeatTimeoutMs?: number;
  readonly listRooms: ListRoomsUseCase;
  readonly logger: Logger;
  readonly now?: () => number;
  /** `APP_ORIGINS`: a cookie-authenticated upgrade must come from one of these (CSRF). */
  readonly origins: readonly string[];
  readonly receipt: ReceiptUseCase;
  readonly rooms: RoomRepository;
  readonly scheduler?: Scheduler;
  readonly sendMessage: SendMessageUseCase;
  /** How long a closed session is remembered: at least one token lifetime. Default: one hour. */
  readonly signedOutMemoryMs?: number;
  readonly verifier: TokenVerifier;
};

type Handler = (ws: Socket, input: Input) => Promise<void>;

type Socket = Bun.ServerWebSocket<SocketConnection>;

/** A malformed frame costs this many tokens, so a few in a row close the socket with 1008. */
const BAD_FRAME_COST = 10;
const DEFAULT_SIGNED_OUT_MEMORY_MS = 3_600_000;
/** A cookie upgrade from an origin that is not allowed. */
const FORBIDDEN: unique symbol = Symbol('forbidden');
const DEFAULT_FRAME_LIMIT: BucketPolicy = { capacity: 30, refillPerSecond: 10 };
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
/** Largest valid frame: a 64 KiB ciphertext in base64 plus the other fields. */
const MAX_FRAME_BYTES = 128 * 1024;
/** Bun's `idleTimeout` is capped at 960 seconds. */
const MAX_IDLE_TIMEOUT_SECONDS = 960;
const OPEN = 1;

class Gateway {
  readonly events: RoomEvents = {
    membersChanged: (room, { added, removed }) => {
      const joined = this.socketsOf(added);
      for (const ws of joined) {
        this.join(ws, room.id);
        this.presenceSnapshot(ws, room.id, room.memberIds);
      }
      // A user whose welcome is still running is announced by it, with the fresh room list.
      const [announcer] = joined;
      if (announcer && added !== null && this.announced.has(added)) {
        this.publishFrom(announcer, room.id, {
          online: true,
          roomId: room.id,
          type: 'presence',
          userId: added,
        });
      }
      for (const ws of this.socketsOf(removed)) {
        this.leave(ws, room.id);
      }
      this.broadcast(room.id, { keyEpoch: room.keyEpoch, roomId: room.id, type: 'room.rotated' });
    },
    senderKeysAvailable: (roomId, keyEpoch, senderId) => {
      this.broadcast(roomId, { keyEpoch, roomId, senderId, type: 'sender-keys.available' });
    },
  };
  /** Users whose `online: true` was published; cleared when their last socket closes. */
  private readonly announced = new Set<number>();
  private readonly byUser = new Map<number, Set<Socket>>();
  /** Signed-out session ids and when they may be forgotten (epoch milliseconds). */
  private readonly closedSessions = new Map<string, number>();
  private readonly connections = new Set<Socket>();
  private draining = false;
  private readonly frameLimit: BucketPolicy;
  private readonly handlers: Readonly<Record<FrameType, Handler>> = {
    'auth.refresh': async (ws, input) => this.refresh(ws, input),
    'message.send': async (ws, input) => this.sendMessage(ws, input),
    receipt: async (ws, input) => this.receipt(ws, input),
    'room.subscribe': async (ws, input) => this.subscribe(ws, input),
    typing: async (ws, input) => this.typing(ws, input),
  };
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private server: Bun.Server<SocketConnection> | null = null;
  private stopHeartbeat: Cancel | null = null;

  constructor(private readonly deps: SocketGatewayDependencies) {
    this.frameLimit = deps.frameLimit ?? DEFAULT_FRAME_LIMIT;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? 2 * this.heartbeatIntervalMs;
    this.now = deps.now ?? Date.now;
    this.scheduler = deps.scheduler ?? systemScheduler;
  }

  closeSession(sessionId: string): void {
    const now = this.now();
    for (const [closed, forgetAt] of this.closedSessions) {
      if (forgetAt <= now) {
        this.closedSessions.delete(closed);
      }
    }
    this.closedSessions.set(
      sessionId,
      now + (this.deps.signedOutMemoryMs ?? DEFAULT_SIGNED_OUT_MEMORY_MS),
    );
    for (const ws of this.connections) {
      if (ws.data.sessionId === sessionId) {
        this.authFailed(ws, 'Signed out');
      }
    }
  }

  connectionCount(): number {
    return this.connections.size;
  }

  async drain(): Promise<void> {
    this.draining = true;
    await Promise.all(this.inFlight);
    for (const ws of this.connections) {
      this.closeWith(ws, CloseCode.GoingAway, 'Server is shutting down');
    }
    this.stopHeartbeat?.();
    this.stopHeartbeat = null;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Bun's own `idleTimeout` is only a backstop for a stalled heartbeat timer: twice the heartbeat
   * timeout, so the application heartbeat (with its 4008 close code) always fires first.
   */
  idleTimeoutSeconds(): number {
    return Math.min(MAX_IDLE_TIMEOUT_SECONDS, Math.ceil((2 * this.heartbeatTimeoutMs) / 1000));
  }

  open(ws: Socket): void {
    const connection = ws.data;
    if (this.isClosedSession(connection.sessionId)) {
      // Upgraded with a token verified just before its session was signed out.
      this.authFailed(ws, 'Signed out');
      return;
    }
    const sockets = this.byUser.get(connection.userId) ?? new Set<Socket>();
    sockets.add(ws);
    this.byUser.set(connection.userId, sockets);
    this.connections.add(ws);
    this.scheduleExpiry(ws, connection.expiresAt);
    this.stopHeartbeat ??= this.scheduler.repeat(this.heartbeatIntervalMs, () => {
      this.beat();
    });
    this.track(ws, async () => this.welcome(ws), null);
  }

  receive(ws: Socket, raw: Buffer | string): void {
    const connection = ws.data;
    // Frames that arrive while draining are not handled and not acked: the client's outbox resends
    // them after reconnecting, and the idempotency key prevents duplicates.
    if (this.draining || connection.isReleased) {
      return;
    }
    if (!connection.take(this.frameLimit, this.now(), 1)) {
      this.violation(ws);
      return;
    }
    const frame = parseClientFrame(raw);
    if (frame === null) {
      if (connection.take(this.frameLimit, this.now(), BAD_FRAME_COST)) {
        this.send(
          ws,
          errorFrame('bad_frame', 'Expected a JSON object with a known type and fields', null),
        );
      } else {
        this.violation(ws);
      }
      return;
    }
    this.track(ws, async () => this.dispatch(ws, frame), refOf(frame));
  }

  /** Frees the socket's timers, subscriptions and presence; idempotent. */
  release(ws: Socket): void {
    const connection = ws.data;
    const rooms = connection.release();
    if (rooms === null) {
      return;
    }
    this.connections.delete(ws);
    const sockets = this.byUser.get(connection.userId);
    sockets?.delete(ws);
    const lastSocket = sockets === undefined || sockets.size === 0;
    if (lastSocket) {
      this.byUser.delete(connection.userId);
      this.announced.delete(connection.userId);
    }
    for (const roomId of rooms) {
      if (ws.readyState === OPEN) {
        ws.unsubscribe(topicOf(roomId));
      }
      if (lastSocket) {
        this.broadcast(roomId, {
          online: false,
          roomId,
          type: 'presence',
          userId: connection.userId,
        });
      }
    }
    if (this.connections.size === 0) {
      this.stopHeartbeat?.();
      this.stopHeartbeat = null;
    }
  }

  renewSession(sessionId: string, expiresAt: Date): void {
    for (const ws of this.connections) {
      if (ws.data.sessionId === sessionId) {
        this.scheduleExpiry(ws, expiresAt.getTime());
        this.send(ws, { expiresAt: expiresAt.toISOString(), type: 'auth.refreshed' });
      }
    }
  }

  async upgrade(
    request: Request,
    server: Bun.Server<SocketConnection>,
  ): Promise<Response | undefined> {
    this.server = server;
    if (this.draining) {
      return shuttingDown(request);
    }
    const credential = this.credentialOf(request);
    if (credential === FORBIDDEN) {
      return errorResponse(request, new ForbiddenError('Origin not allowed'));
    }
    const claims = credential === null ? null : await this.deps.verifier.verify(credential);
    if (claims === null) {
      return errorResponse(
        request,
        new UnauthorizedError(
          `Sec-WebSocket-Protocol must list ${SOCKET_PROTOCOL} and one valid bearer token, or the request must carry a valid session cookie`,
        ),
      );
    }
    // Checked again: the drain may have started while the token was being verified.
    if (this.isDraining()) {
      return shuttingDown(request);
    }
    const upgraded = server.upgrade(request, {
      data: new SocketConnection(
        claims.userId,
        claims.sessionId,
        claims.expiresAt.getTime(),
        this.now(),
      ),
      // Only the protocol name is echoed back; the bearer entry is never part of the response.
      headers: { 'Sec-WebSocket-Protocol': SOCKET_PROTOCOL },
    });
    return upgraded
      ? undefined
      : errorResponse(request, new BadRequestError('Expected a WebSocket upgrade request'));
  }

  /**
   * The upgrade's token: a `bearer.<jwt>` subprotocol (programmatic clients), else the session
   * cookie when the subprotocols are only `chat-rsa.v1` (browsers). A cookie needs an allowed
   * `Origin`, since a foreign page could open the socket with it (cross-site WebSocket hijacking).
   */
  private authFailed(ws: Socket, message: string): void {
    this.send(ws, errorFrame('auth_failed', message, null));
    this.closeWith(ws, CloseCode.AuthFailed, message);
  }

  private beat(): void {
    const now = this.now();
    for (const ws of this.connections) {
      if (now - ws.data.lastPongAt >= this.heartbeatTimeoutMs) {
        this.closeWith(ws, CloseCode.HeartbeatTimeout, 'No pong received');
      } else {
        ws.ping();
      }
    }
  }

  private credentialOf(request: Request): null | string | typeof FORBIDDEN {
    const bearer = bearerTokenOf(request);
    if (bearer !== null) {
      return bearer;
    }
    const protocols = (request.headers.get('sec-websocket-protocol') ?? '')
      .split(',')
      .map((entry) => entry.trim());
    const cookie = cookieOf(request, SESSION_COOKIE);
    if (cookie === null || protocols.length !== 1 || protocols[0] !== SOCKET_PROTOCOL) {
      return null;
    }
    return hasAllowedOrigin(request, this.deps.origins) ? cookie : FORBIDDEN;
  }

  /** Sends to every socket subscribed to the room, the publishing user's sockets included. */
  private broadcast(roomId: string, frame: ServerFrame): void {
    this.server?.publish(topicOf(roomId), encode(frame));
  }

  private closeWith(ws: Socket, code: number, reason: string): void {
    this.release(ws);
    ws.close(code, reason);
  }

  private async dispatch(ws: Socket, frame: ParsedFrame): Promise<void> {
    if (ws.data.isReleased) {
      return;
    }
    if (this.now() >= ws.data.expiresAt) {
      this.authFailed(ws, 'Token expired');
      return;
    }
    await this.handlers[frame.type](ws, frame.input);
  }

  private fail(ws: Socket, error: unknown, ref: null | string): void {
    const code = error instanceof AppError ? codeOf(error) : 'internal';
    if (code === 'internal') {
      this.deps.logger.error(error);
    }
    const message =
      error instanceof AppError && code !== 'internal' ? error.message : 'Internal error';
    this.send(ws, errorFrame(code, message, ref));
  }

  private isClosedSession(sessionId: string): boolean {
    const forgetAt = this.closedSessions.get(sessionId);
    if (forgetAt === undefined) {
      return false;
    }
    if (forgetAt <= this.now()) {
      this.closedSessions.delete(sessionId);
      return false;
    }
    return true;
  }

  private isDraining(): boolean {
    return this.draining;
  }

  private join(ws: Socket, roomId: string): void {
    if (ws.readyState === OPEN && ws.data.join(roomId)) {
      ws.subscribe(topicOf(roomId));
    }
  }

  private leave(ws: Socket, roomId: string): void {
    if (ws.data.leave(roomId) && ws.readyState === OPEN) {
      ws.unsubscribe(topicOf(roomId));
    }
  }

  private presenceSnapshot(ws: Socket, roomId: string, memberIds: readonly number[]): void {
    this.send(ws, {
      online: memberIds.filter((id) => this.byUser.has(id)),
      roomId,
      type: 'presence.snapshot',
    });
  }

  /** Sends to the room's other sockets; after the sender closed, to the whole room. */
  private publishFrom(ws: Socket, roomId: string, frame: ServerFrame): void {
    if (ws.readyState === OPEN) {
      ws.publish(topicOf(roomId), encode(frame));
    } else {
      this.broadcast(roomId, frame);
    }
  }

  private async receipt(ws: Socket, input: Input): Promise<void> {
    const update = await this.deps.receipt.execute(ws.data.userId, input);
    if (!update.ok) {
      this.fail(ws, update.error, refOf({ input, type: 'receipt' }));
      return;
    }
    this.broadcast(update.value.roomId, { ...update.value, type: 'receipt' });
  }

  private async refresh(ws: Socket, input: Input): Promise<void> {
    const claims =
      typeof input.token === 'string' ? await this.deps.verifier.verify(input.token) : null;
    if (claims?.userId !== ws.data.userId || claims.sessionId !== ws.data.sessionId) {
      this.authFailed(ws, 'Token refresh rejected');
      return;
    }
    const expiresAt = claims.expiresAt.getTime();
    this.scheduleExpiry(ws, expiresAt);
    this.send(ws, { expiresAt: claims.expiresAt.toISOString(), type: 'auth.refreshed' });
  }

  private scheduleExpiry(ws: Socket, expiresAt: number): void {
    const cancel = this.scheduler.after(expiresAt - this.now(), () => {
      this.authFailed(ws, 'Token expired');
    });
    ws.data.renew(expiresAt, cancel);
  }

  private send(ws: Socket, frame: ServerFrame): void {
    if (ws.readyState === OPEN) {
      ws.send(encode(frame));
    }
  }

  private async sendMessage(ws: Socket, input: Input): Promise<void> {
    const sent = await this.deps.sendMessage.execute(ws.data.userId, input);
    if (!sent.ok) {
      this.fail(ws, sent.error, refOf({ input, type: 'message.send' }));
      return;
    }
    const { duplicate, message } = sent.value;
    // A retried key was already fanned out the first time; publishing again would duplicate it.
    if (!duplicate) {
      this.publishFrom(ws, message.roomId, { message, type: 'message.new' });
    }
    // Only now, after the use case returned, is the message persisted: the ack moves it to delivered.
    this.send(ws, {
      duplicate,
      idempotencyKey: message.idempotencyKey,
      message,
      type: 'message.ack',
    });
  }

  private socketsOf(userId: null | number): readonly Socket[] {
    return userId === null ? [] : [...(this.byUser.get(userId) ?? [])];
  }

  private async subscribe(ws: Socket, input: Input): Promise<void> {
    const room = await roomOfMember(this.deps.rooms, input.roomId, ws.data.userId);
    if (!room.ok) {
      this.fail(ws, room.error, refOf({ input, type: 'room.subscribe' }));
      return;
    }
    this.join(ws, room.value.id);
    this.presenceSnapshot(ws, room.value.id, room.value.memberIds);
  }

  /** Queues a frame task on its socket and remembers it until it settles, so `drain` can await it. */
  private track(ws: Socket, task: () => Promise<void>, ref: null | string): void {
    const settled = ws.data.enqueue(async () => {
      try {
        await task();
      } catch (error) {
        this.fail(ws, error, ref);
      }
    });
    this.inFlight.add(settled);
    void settled.finally(() => this.inFlight.delete(settled));
  }

  private async typing(ws: Socket, input: Input): Promise<void> {
    const ref = refOf({ input, type: 'typing' });
    if (typeof input.active !== 'boolean') {
      this.fail(
        ws,
        new ValidationError([{ field: 'active', message: 'active must be a boolean' }]),
        ref,
      );
      return;
    }
    const room = await roomOfMember(this.deps.rooms, input.roomId, ws.data.userId);
    if (!room.ok) {
      this.fail(ws, room.error, ref);
      return;
    }
    const { userId } = ws.data;
    this.publishFrom(ws, room.value.id, {
      active: input.active,
      roomId: room.value.id,
      type: 'typing',
      userId,
    });
  }

  private violation(ws: Socket): void {
    this.send(ws, errorFrame('rate_limited', 'Too many or malformed frames', null));
    this.closeWith(ws, CloseCode.PolicyViolation, 'Frame limit exceeded');
  }

  /** Subscribes the new socket to the user's rooms, then sends `ready`, presence and snapshots. */
  private async welcome(ws: Socket): Promise<void> {
    const connection = ws.data;
    const rooms = await this.deps.listRooms.execute(connection.userId);
    if (!rooms.ok) {
      this.fail(ws, rooms.error, null);
      return;
    }
    if (connection.isReleased) {
      return;
    }
    for (const room of rooms.value) {
      this.join(ws, room.id);
    }
    // Decided after the await, not at open: an earlier socket may have closed before announcing.
    const announce = !this.announced.has(connection.userId);
    this.announced.add(connection.userId);
    this.send(ws, {
      expiresAt: new Date(connection.expiresAt).toISOString(),
      roomIds: rooms.value.map((room) => room.id),
      type: 'ready',
      userId: connection.userId,
    });
    for (const room of rooms.value) {
      if (announce) {
        this.publishFrom(ws, room.id, {
          online: true,
          roomId: room.id,
          type: 'presence',
          userId: connection.userId,
        });
      }
      this.presenceSnapshot(ws, room.id, room.memberIds);
    }
  }
}

/**
 * The `/ws` endpoint: JWT auth at upgrade (bearer subprotocol or session cookie), room fan-out over
 * Bun pub/sub (`room:<id>` topics), heartbeat, token refresh and expiry, and a drain for graceful
 * shutdown.
 */
export function createSocketGateway(deps: SocketGatewayDependencies): SocketGateway {
  const gateway = new Gateway(deps);
  const now = deps.now ?? Date.now;
  return {
    closeSession: (sessionId) => {
      gateway.closeSession(sessionId);
    },
    connectionCount: () => gateway.connectionCount(),
    drain: async () => gateway.drain(),
    events: gateway.events,
    inFlightCount: () => gateway.inFlightCount(),
    renewSession: (sessionId, expiresAt) => {
      gateway.renewSession(sessionId, expiresAt);
    },
    upgrade: async (request, server) => gateway.upgrade(request, server),
    websocket: {
      close: (ws) => {
        gateway.release(ws);
      },
      idleTimeout: gateway.idleTimeoutSeconds(),
      maxPayloadLength: MAX_FRAME_BYTES,
      message: (ws, raw) => {
        gateway.receive(ws, raw);
      },
      open: (ws) => {
        gateway.open(ws);
      },
      pong: (ws) => {
        ws.data.pong(now());
      },
      // The gateway pings on its own schedule; Bun's automatic pings would only add noise.
      sendPings: false,
    },
  };
}

function shuttingDown(request: Request): Response {
  return errorResponse(request, new ServiceUnavailableError('The server is shutting down'));
}

function topicOf(roomId: string): string {
  return `room:${roomId}`;
}
