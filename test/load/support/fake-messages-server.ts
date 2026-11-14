// The real HTTP server and WebSocket gateway, wired to the in-memory adapters as app.composition.ts
// wires the real ones, with one switchable defect per sabotage. The `honest` mode IS the real
// contract (same controllers, use cases, guards, gateway and default rate-limit policies as
// main.ts), so a probe that fails against a sabotage proves k6 caught that defect.
import type { SocketConnection } from '../../../src/backend/messaging/presentation/messaging.socket.connection.ts';
import type { UserId } from '../../../src/backend/user/domain/user.value-objects.ts';
import type { Profile } from '../k6-runner.ts';

import {
  InMemoryKeyDirectory,
  InMemoryMessageRepository,
  InMemoryReceiptRepository,
  InMemoryRoomRepository,
  InMemorySenderKeyRepository,
} from '../../../src/backend/messaging/application/messaging.fakes.test-support.ts';
import { HistoryUseCase } from '../../../src/backend/messaging/application/messaging.history.use-case.ts';
import {
  FetchSenderKeysUseCase,
  ListRoomKeysUseCase,
  PublishIdentityKeyUseCase,
  StoreSenderKeysUseCase,
} from '../../../src/backend/messaging/application/messaging.keys.use-case.ts';
import { ReceiptUseCase } from '../../../src/backend/messaging/application/messaging.receipt.use-case.ts';
import { ListReceiptsUseCase } from '../../../src/backend/messaging/application/messaging.receipts-list.use-case.ts';
import {
  AddMemberUseCase,
  CreateRoomUseCase,
  LeaveRoomUseCase,
  ListRoomMembersUseCase,
  ListRoomsUseCase,
} from '../../../src/backend/messaging/application/messaging.rooms.use-case.ts';
import { SendMessageUseCase } from '../../../src/backend/messaging/application/messaging.send-message.use-case.ts';
import { MemberDirectory } from '../../../src/backend/messaging/domain/messaging.repository.ts';
import { RoomId } from '../../../src/backend/messaging/domain/messaging.value-objects.ts';
import { createMessagingController } from '../../../src/backend/messaging/presentation/messaging.controller.ts';
import {
  createSocketGateway,
  type SocketGateway,
} from '../../../src/backend/messaging/presentation/messaging.socket.gateway.ts';
import { loadConfig } from '../../../src/backend/shared/config/env.config.ts';
import { createServer } from '../../../src/backend/shared/http/app.server.ts';
import { createGuards, type Guards } from '../../../src/backend/shared/http/http.guard.ts';
import { InMemoryRateLimiter } from '../../../src/backend/shared/rate-limit/rate-limit.in-memory.ts';
import { RateLimiter } from '../../../src/backend/shared/rate-limit/rate-limit.port.ts';
import {
  FakePasswordHasher,
  InMemorySessionRevocations,
  InMemoryUserDatasource,
} from '../../../src/backend/user/application/user.fakes.test-support.ts';
import { LookupUserUseCase } from '../../../src/backend/user/application/user.lookup.use-case.ts';
import { RefreshUseCase } from '../../../src/backend/user/application/user.refresh.use-case.ts';
import { SignInUseCase } from '../../../src/backend/user/application/user.sign-in.use-case.ts';
import {
  RevocationAwareTokenVerifier,
  SignOutUseCase,
} from '../../../src/backend/user/application/user.sign-out.use-case.ts';
import { SignUpUseCase } from '../../../src/backend/user/application/user.sign-up.use-case.ts';
import { UserRepositoryImpl } from '../../../src/backend/user/infrastructure/user.repository.impl.ts';
import {
  JoseTokenIssuer,
  JoseTokenVerifier,
  TOKEN_LIFETIME_SECONDS,
} from '../../../src/backend/user/infrastructure/user.security.jose.ts';
import {
  createAuthController,
  createRefreshController,
  createSignOutController,
  createUserController,
} from '../../../src/backend/user/presentation/user.controller.ts';
import { type ProbeRun, runK6Against } from './k6-probe.test-support.ts';

export const MESSAGES_SABOTAGES = [
  'honest',
  // Live socket: frames and upgrades.
  'duplicate-fan-out',
  'no-ack',
  'no-fan-out',
  'no-upgrade',
  'ready-without-rooms',
  'no-receipt-push',
  'no-rotation-push',
  'stale-epoch-wrong-code',
  // Session sockets: refresh push, `auth.refresh` frame, sign-out.
  'no-refresh-push',
  'refresh-frame-ignored',
  'sign-out-keeps-sockets',
  // History.
  'history-ascending',
  'history-overlap',
  'history-oversized',
  'non-member-history',
  'non-member-history-500',
  'bad-timestamp',
  // REST bodies.
  'room-created-alone',
  'rooms-list-empty',
  'lookup-wrong-user',
  'keys-missing-member',
  'join-wrong-members',
  'leave-stale-epoch',
  'sender-keys-500',
  'sender-keys-not-stored',
  'sender-keys-lost',
  'receipts-unordered',
  'receipts-stale',
  'members-without-names',
  'members-open',
  // Refresh and the session cookie.
  'refresh-token-in-body',
  'refresh-new-session',
  'refresh-cookie-readable',
  'refresh-cookie-lax',
  'refresh-hint-stale',
  'cookie-auth-ignored',
  // Stress burst.
  'no-rate-limit',
  'no-retry-after',
  'burst-503',
] as const;

export type FakeMessagesServer = {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
  /** Messages the repository stored, duplicates included when a sabotage lets them through. */
  readonly storedMessages: () => number;
};

export type MessagesProbe = ProbeRun & { readonly storedMessages: number };

export type MessagesSabotage = (typeof MESSAGES_SABOTAGES)[number];

type Frame = Record<string, unknown>;

/** Rewrites a frame the gateway is about to send; null drops it. */
type FrameRewrite = (frame: Frame) => Frame | null;

/** Rewrites the JSON body of responses to one route, keeping status and headers. */
type BodyRewrite = {
  readonly body: (value: unknown) => unknown;
  readonly method: string;
  readonly path: RegExp;
  /** Only responses with this status; any status when absent. */
  readonly status?: number;
};

const SECRET = 'fake-messages-server-secret-of-32-characters';
/** The server's default policies (env.config.ts): probes meet the real IP, user and sign-in buckets. */
const CONFIG = loadConfig({ JWT_SECRET: SECRET });
/** Unsafe requests from a foreign Origin are refused (CSRF); k6 sends none, with bearer tokens. */
const APP_ORIGINS = ['http://localhost:3000'];
/** As app.composition.ts: a minute past one token lifetime. */
const SIGNED_OUT_MEMORY_SECONDS = TOKEN_LIFETIME_SECONDS + 60;

const ROOM = String.raw`\/api\/rooms\/[^/]+`;

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numbers(value: unknown): number[] {
  return list(value).filter((entry) => typeof entry === 'number');
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? { ...value } : {};
}

const BODY_REWRITES: Partial<Record<MessagesSabotage, BodyRewrite>> = {
  // The 403 keeps every field but its timestamp, which is not a date at all.
  'bad-timestamp': {
    body: (value) => ({ ...object(value), timestamp: 'yesterday' }),
    method: 'GET',
    path: new RegExp(`^${ROOM}/messages$`, 'u'),
    status: 403,
  },
  // The member just added is missing from the answer.
  'join-wrong-members': {
    body: (value) => {
      const room = object(value);
      return { ...room, memberIds: numbers(room.memberIds).slice(0, -1) };
    },
    method: 'POST',
    path: new RegExp(`^${ROOM}/members$`, 'u'),
  },
  'keys-missing-member': {
    body: (value) => list(value).slice(1),
    method: 'GET',
    path: new RegExp(`^${ROOM}/keys$`, 'u'),
  },
  // The epoch the answer reports did not move.
  'leave-stale-epoch': {
    body: (value) => {
      const room = object(value);
      return { ...room, keyEpoch: Number(room.keyEpoch) - 1 };
    },
    method: 'DELETE',
    path: new RegExp(`^${ROOM}/members/me$`, 'u'),
  },
  'lookup-wrong-user': {
    body: (value) => {
      const user = object(value);
      return { ...user, id: Number(user.id) + 1 };
    },
    method: 'GET',
    path: /^\/api\/users\/[^/]+$/u,
  },
  'members-without-names': {
    body: (value) => list(value).map((member) => ({ id: object(member).id })),
    method: 'GET',
    path: new RegExp(`^${ROOM}/members$`, 'u'),
    status: 200,
  },
  'receipts-stale': {
    body: (value) =>
      list(value).map((entry) => Object.assign(object(entry), { delivered: null, read: null })),
    method: 'GET',
    path: new RegExp(`^${ROOM}/receipts$`, 'u'),
  },
  'receipts-unordered': {
    body: (value) => list(value).toReversed(),
    method: 'GET',
    path: new RegExp(`^${ROOM}/receipts$`, 'u'),
  },
  'refresh-token-in-body': {
    body: (value) => ({ ...object(value), token: 'leaked.in.body' }),
    method: 'POST',
    path: /^\/api\/auth\/refresh$/u,
  },
  // The creator is told the room holds only itself.
  'room-created-alone': {
    body: (value) => {
      const room = object(value);
      return { ...room, memberIds: numbers(room.memberIds).slice(0, 1) };
    },
    method: 'POST',
    path: /^\/api\/rooms$/u,
  },
  'rooms-list-empty': { body: () => [], method: 'GET', path: /^\/api\/rooms$/u },
  'sender-keys-lost': {
    body: () => [],
    method: 'GET',
    path: new RegExp(`^${ROOM}/sender-keys$`, 'u'),
  },
  'sender-keys-not-stored': {
    body: (value) => ({ ...object(value), stored: 0 }),
    method: 'POST',
    path: new RegExp(`^${ROOM}/sender-keys$`, 'u'),
  },
};

/** Rewrites one `Set-Cookie` value of the refresh response. */
const REFRESH_COOKIE_REWRITES: Partial<Record<MessagesSabotage, (cookie: string) => string>> = {
  'refresh-cookie-lax': (cookie) =>
    cookie.startsWith('chat_rsa_session=')
      ? cookie.replace('SameSite=Strict', 'SameSite=Lax')
      : cookie,
  'refresh-cookie-readable': (cookie) =>
    cookie.startsWith('chat_rsa_session=') ? cookie.replace('HttpOnly; ', '') : cookie,
  // The hint lags one second behind the token's `exp`.
  'refresh-hint-stale': (cookie) => {
    const exp = /^chat_rsa_session_hint=(?<exp>\d+);/u.exec(cookie)?.groups?.exp;
    return exp === undefined ? cookie : cookie.replace(`=${exp};`, `=${Number(exp) - 1};`);
  },
};

const FRAME_REWRITES: Partial<Record<MessagesSabotage, FrameRewrite>> = {
  'no-ack': (frame) => (frame.type === 'message.ack' ? null : frame),
  'no-fan-out': (frame) => (frame.type === 'message.new' ? null : frame),
  'no-receipt-push': (frame) => (frame.type === 'receipt' ? null : frame),
  'no-rotation-push': (frame) => (frame.type === 'room.rotated' ? null : frame),
  'ready-without-rooms': (frame) => (frame.type === 'ready' ? { ...frame, roomIds: [] } : frame),
  'stale-epoch-wrong-code': (frame) =>
    frame.type === 'error' && frame.code === 'conflict' ? { ...frame, code: 'internal' } : frame,
};

/** `no-rate-limit`: a limiter that never refuses. */
class UnlimitedRateLimiter extends RateLimiter {
  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory adapter of an async port
  override async take(): ReturnType<RateLimiter['take']> {
    return { allowed: true, retryAfterSeconds: 0, state: { tokens: 1, updatedAt: Date.now() } };
  }
}

/** The names of signed-up users, as PostgresMemberDirectory reads them from `users`. */
class UserNameDirectory extends MemberDirectory {
  constructor(private readonly users: InMemoryUserDatasource) {
    super();
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory adapter of an async port
  override async names(userIds: readonly UserId[]): Promise<ReadonlyMap<UserId, string>> {
    return new Map(
      this.users.users
        .filter((user) => userIds.includes(user.id))
        .map((user) => [user.id, user.name.value] as const),
    );
  }
}

/**
 * `duplicate-fan-out`: never finds a stored idempotency key, so `append` stores a retry as a new
 * message and the gateway fans it out again.
 */
class ForgetfulMessageRepository extends InMemoryMessageRepository {
  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory adapter of an async port
  override async findByIdempotencyKey(): ReturnType<
    InMemoryMessageRepository['findByIdempotencyKey']
  > {
    return null;
  }
}

/**
 * `history-overlap`: an inclusive cursor, so the last message of a page comes back first on the
 * next.
 */
class InclusiveCursorMessageRepository extends InMemoryMessageRepository {
  override async page(
    roomId: Parameters<InMemoryMessageRepository['page']>[0],
    query: Parameters<InMemoryMessageRepository['page']>[1],
  ): ReturnType<InMemoryMessageRepository['page']> {
    const { before } = query;
    const rows = await super.page(roomId, {
      ...query,
      before: null,
      limit: Number.MAX_SAFE_INTEGER,
    });
    return rows.filter((message) => before === null || message.id <= before).slice(0, query.limit);
  }
}

function messageRepositoryFor(sabotage: MessagesSabotage): InMemoryMessageRepository {
  if (sabotage === 'duplicate-fan-out') {
    return new ForgetfulMessageRepository();
  }
  if (sabotage === 'history-overlap') {
    return new InclusiveCursorMessageRepository();
  }
  return new InMemoryMessageRepository();
}

/** Runs the k6 messages script once against a fresh fake server with `sabotage`. */
export async function probeMessages(
  sabotage: MessagesSabotage,
  profile: Profile = 'smoke',
): Promise<MessagesProbe> {
  const server = startFakeMessagesServer(sabotage);
  try {
    const run = await runK6Against(server, { profile, script: 'messages.load.ts' });
    return { ...run, storedMessages: server.storedMessages() };
  } finally {
    await server.stop();
  }
}

/** The room's first member, standing in for an actor whose membership a sabotage ignores. */
async function firstMemberOr(
  rooms: InMemoryRoomRepository,
  rawRoomId: unknown,
  actor: UserId,
): Promise<UserId> {
  const roomId = RoomId.create(rawRoomId);
  const room = roomId.ok ? await rooms.findById(roomId.value) : null;
  return room?.memberIds[0] ?? actor;
}

/** History sabotages, around the real use case. */
class SabotagedHistoryUseCase extends HistoryUseCase {
  constructor(
    private readonly sabotage: MessagesSabotage,
    private readonly roomRepository: InMemoryRoomRepository,
    messages: InMemoryMessageRepository,
  ) {
    super(roomRepository, messages);
  }

  override async execute(
    ...[actor, rawRoomId, query]: Parameters<HistoryUseCase['execute']>
  ): ReturnType<HistoryUseCase['execute']> {
    if (this.sabotage === 'non-member-history') {
      // Membership is ignored: the history is read as if the caller were the room's first member.
      return super.execute(
        await firstMemberOr(this.roomRepository, rawRoomId, actor),
        rawRoomId,
        query,
      );
    }
    if (this.sabotage === 'history-oversized' && query.limit !== undefined) {
      // Pages hold twice the requested limit.
      return super.execute(actor, rawRoomId, { ...query, limit: String(2 * Number(query.limit)) });
    }
    const page = await super.execute(actor, rawRoomId, query);
    if (this.sabotage === 'non-member-history-500' && !page.ok) {
      // Refusing a non-member crashes instead of answering 403.
      throw new Error('sabotage: the history refusal crashed');
    }
    if (this.sabotage === 'history-ascending' && page.ok) {
      // Each page is right, cursor included, but its messages come oldest first.
      return { ...page, value: { ...page.value, messages: page.value.messages.toReversed() } };
    }
    return page;
  }
}

/** `members-open`: membership is ignored, so anyone may list a room's members. */
class OpenRoomMembersUseCase extends ListRoomMembersUseCase {
  constructor(
    private readonly roomRepository: InMemoryRoomRepository,
    directory: MemberDirectory,
  ) {
    super(roomRepository, directory);
  }

  override async execute(
    ...[actor, rawRoomId]: Parameters<ListRoomMembersUseCase['execute']>
  ): ReturnType<ListRoomMembersUseCase['execute']> {
    return super.execute(await firstMemberOr(this.roomRepository, rawRoomId, actor), rawRoomId);
  }
}

export function startFakeMessagesServer(sabotage: MessagesSabotage): FakeMessagesServer {
  // Sabotages throw on purpose; a real defect in the honest mode still fails the k6 checks.
  const logger = { error: () => null };
  const datasource = new InMemoryUserDatasource();
  const users = new UserRepositoryImpl(datasource);
  const hasher = new FakePasswordHasher();
  const tokens = new JoseTokenIssuer(SECRET);
  const revocations = new InMemorySessionRevocations();
  const verifier = new RevocationAwareTokenVerifier(new JoseTokenVerifier(SECRET), revocations);
  const rooms = new InMemoryRoomRepository();
  const messages = messageRepositoryFor(sabotage);
  const receipts = new InMemoryReceiptRepository(rooms);
  const keys = new InMemoryKeyDirectory();
  const senderKeys = new InMemorySenderKeyRepository();
  const listRooms = new ListRoomsUseCase(rooms);
  const directory = new UserNameDirectory(datasource);
  const limiter =
    sabotage === 'no-rate-limit' ? new UnlimitedRateLimiter() : new InMemoryRateLimiter();

  const storeSenderKeys = new StoreSenderKeysUseCase(rooms, senderKeys);
  if (sabotage === 'sender-keys-500') {
    storeSenderKeys.execute = async () => {
      throw new Error('sabotage: sender-key storage is down');
    };
  }

  const gateway = createSocketGateway({
    listRooms,
    logger,
    origins: APP_ORIGINS,
    receipt: new ReceiptUseCase(rooms, messages, receipts),
    rooms,
    sendMessage: new SendMessageUseCase(rooms, messages),
    signedOutMemoryMs: SIGNED_OUT_MEMORY_SECONDS * 1000,
    verifier,
  });
  const guards = createGuards({
    limiter,
    logger,
    origins: APP_ORIGINS,
    policies: CONFIG.rateLimit,
    trustedProxyIps: [],
    verifier,
  });
  // `refresh-new-session`: refresh signs a token of a brand-new session instead of keeping it.
  const refreshTokens =
    sabotage === 'refresh-new-session'
      ? { issue: async (user: Parameters<JoseTokenIssuer['issue']>[0]) => tokens.issue(user) }
      : tokens;

  const server = createServer({
    auth: createAuthController(
      {
        signIn: new SignInUseCase(users, hasher, tokens, {
          limiter,
          policy: CONFIG.rateLimit.signin,
        }),
        signUp: new SignUpUseCase(users, hasher, tokens),
      },
      logger,
      TOKEN_LIFETIME_SECONDS,
    ),
    messaging: {
      controller: createMessagingController({
        events: gateway.events,
        logger,
        useCases: {
          addMember: new AddMemberUseCase(rooms),
          createRoom: new CreateRoomUseCase(rooms),
          fetchSenderKeys: new FetchSenderKeysUseCase(rooms, senderKeys),
          history: new SabotagedHistoryUseCase(sabotage, rooms, messages),
          leaveRoom: new LeaveRoomUseCase(rooms),
          listReceipts: new ListReceiptsUseCase(rooms, receipts),
          listRoomKeys: new ListRoomKeysUseCase(rooms, keys),
          listRoomMembers:
            sabotage === 'members-open'
              ? new OpenRoomMembersUseCase(rooms, directory)
              : new ListRoomMembersUseCase(rooms, directory),
          listRooms,
          publishIdentityKey: new PublishIdentityKeyUseCase(keys),
          storeSenderKeys,
        },
      }),
      gateway: sabotagedGateway(sabotage, gateway),
      guards: sabotagedGuards(sabotage, guards),
      refresh: createRefreshController(
        new RefreshUseCase(
          verifier,
          users,
          refreshTokens,
          { sessionMaxAgeSeconds: CONFIG.sessionMaxAgeSeconds },
          (sessionId, expiresAt) => {
            if (sabotage !== 'no-refresh-push') {
              gateway.renewSession(sessionId, expiresAt);
            }
          },
        ),
        logger,
        TOKEN_LIFETIME_SECONDS,
      ),
      signOut: createSignOutController(
        new SignOutUseCase(verifier, revocations, (sessionId) => {
          if (sabotage !== 'sign-out-keeps-sockets') {
            gateway.closeSession(sessionId);
          }
        }),
        logger,
      ),
      users: createUserController({ lookup: new LookupUserUseCase(users) }, logger),
    },
    port: 0,
  });

  rewriteOutgoingFrames(server, FRAME_REWRITES[sabotage]);

  return {
    baseUrl: `http://localhost:${server.port}`,
    stop: async () => {
      await gateway.drain();
      await server.stop(true);
    },
    storedMessages: () => messages.messages.length,
  };
}

/** The response with its JSON body rewritten, when `rewrite` applies to this request. */
async function rewriteBody(
  request: Request,
  response: Response,
  rewrite: BodyRewrite | undefined,
): Promise<Response> {
  if (
    request.method !== rewrite?.method ||
    !rewrite.path.test(new URL(request.url).pathname) ||
    (rewrite.status !== undefined && response.status !== rewrite.status)
  ) {
    return response;
  }
  const body: unknown = await response.json();
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return Response.json(rewrite.body(body), { headers, status: response.status });
}

/** The response with each `Set-Cookie` value rewritten. */
function rewriteCookies(
  response: Response,
  rewrite: ((cookie: string) => string) | undefined,
): Response {
  if (rewrite === undefined) {
    return response;
  }
  const cookies = response.headers.getSetCookie();
  response.headers.delete('set-cookie');
  for (const cookie of cookies) {
    response.headers.append('set-cookie', rewrite(cookie));
  }
  return response;
}

/** Response-level sabotages, applied after the real guard and handler answered. */
function sabotagedGuards(sabotage: MessagesSabotage, guards: Guards): Guards {
  let limited = 0;
  const after = async (request: Request, response: Response): Promise<Response> => {
    if (response.status === 429 && sabotage === 'no-retry-after') {
      const headers = new Headers(response.headers);
      headers.delete('retry-after');
      return new Response(response.body, { headers, status: response.status });
    }
    if (response.status === 429 && sabotage === 'burst-503') {
      // Every other refusal of the burst is a 503 instead of a 429.
      limited += 1;
      if (limited % 2 === 0) {
        return new Response(response.body, { headers: response.headers, status: 503 });
      }
    }
    return rewriteCookies(
      await rewriteBody(request, response, BODY_REWRITES[sabotage]),
      REFRESH_COOKIE_REWRITES[sabotage],
    );
  };
  return {
    authenticated: (handler) => {
      const route = guards.authenticated(handler);
      return async (request, server) => {
        if (sabotage === 'cookie-auth-ignored' && !request.headers.has('authorization')) {
          // The guard no longer reads the session cookie: only bearer clients get in.
          request.headers.delete('cookie');
        }
        return after(request, await route(request, server));
      };
    },
    public: guards.public,
    session: (handler) => {
      const route = guards.session(handler);
      return async (request, server) => after(request, await route(request, server));
    },
    upgrade: guards.upgrade,
  };
}

/** The frame `data` encodes after `rewrite`, or null when it drops the frame. */
function rewriteFrame(rewrite: FrameRewrite | undefined, data: string): null | string {
  const parsed: unknown = JSON.parse(data);
  if (rewrite === undefined || typeof parsed !== 'object' || parsed === null) {
    return data;
  }
  const frame = rewrite({ ...parsed });
  return frame === null ? null : JSON.stringify(frame);
}

/**
 * Frame sabotages, applied to every frame the gateway sends on a socket or publishes through it or
 * through the server (receipts and rotations are broadcast by the server).
 */
function rewriteOutgoingFrames(
  target: Bun.Server<SocketConnection> | Bun.ServerWebSocket<SocketConnection>,
  rewrite: FrameRewrite | undefined,
): void {
  if (rewrite === undefined) {
    return;
  }
  const publish = target.publish.bind(target);
  Object.defineProperty(target, 'publish', {
    value: (topic: string, data: string, compress?: boolean) => {
      const out = rewriteFrame(rewrite, data);
      return out === null ? 0 : publish(topic, out, compress);
    },
  });
  if ('send' in target) {
    const send = target.send.bind(target);
    Object.defineProperty(target, 'send', {
      value: (data: string, compress?: boolean) => {
        const out = rewriteFrame(rewrite, data);
        return out === null ? 0 : send(out, compress);
      },
    });
  }
}

/** Upgrade and frame sabotages around the real gateway. */
function sabotagedGateway(sabotage: MessagesSabotage, gateway: SocketGateway): SocketGateway {
  const rewrite = FRAME_REWRITES[sabotage];
  const handler = gateway.websocket;
  return {
    ...gateway,
    upgrade: async (request, server) =>
      sabotage === 'no-upgrade'
        ? new Response('Upgrade refused', { status: 403 })
        : gateway.upgrade(request, server),
    websocket: {
      ...handler,
      message: (ws, raw) => {
        if (sabotage === 'refresh-frame-ignored' && String(raw).includes('"type":"auth.refresh"')) {
          return;
        }
        void handler.message?.(ws, raw);
      },
      open: (ws) => {
        rewriteOutgoingFrames(ws, rewrite);
        void handler.open?.(ws);
      },
    },
  };
}
