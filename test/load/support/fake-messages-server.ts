// The real HTTP server and WebSocket gateway, wired to the in-memory adapters, with one switchable
// defect per sabotage. The `honest` mode IS the real contract (same controllers, use cases, guards
// and gateway as main.ts), so a probe that fails against a sabotage proves k6 caught that defect.
import type { SocketConnection } from '../../../src/backend/messaging/presentation/messaging.socket.connection.ts';

import {
  InMemoryKeyDirectory,
  InMemoryMemberDirectory,
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
import { RoomId } from '../../../src/backend/messaging/domain/messaging.value-objects.ts';
import { createMessagingController } from '../../../src/backend/messaging/presentation/messaging.controller.ts';
import { createSocketGateway } from '../../../src/backend/messaging/presentation/messaging.socket.gateway.ts';
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
import { SignOutUseCase } from '../../../src/backend/user/application/user.sign-out.use-case.ts';
import { SignUpUseCase } from '../../../src/backend/user/application/user.sign-up.use-case.ts';
import { UserRepositoryImpl } from '../../../src/backend/user/infrastructure/user.repository.impl.ts';
import {
  JoseTokenIssuer,
  JoseTokenVerifier,
} from '../../../src/backend/user/infrastructure/user.security.jose.ts';
import {
  createAuthController,
  createRefreshController,
  createSignOutController,
  createUserController,
} from '../../../src/backend/user/presentation/user.controller.ts';

export const MESSAGES_SABOTAGES = [
  'honest',
  'duplicate-fan-out',
  'history-ascending',
  'history-overlap',
  'no-ack',
  'non-member-history',
  'sender-keys-500',
  'no-rate-limit',
  'no-retry-after',
] as const;
export type FakeMessagesServer = {
  readonly baseUrl: string;
  /** Messages the repository stored, duplicates included when a sabotage lets them through. */
  readonly stop: () => Promise<void>;
  readonly storedMessages: () => number;
};

export type MessagesSabotage = (typeof MESSAGES_SABOTAGES)[number];

const SECRET = 'fake-messages-server-secret';
/** Default user bucket of env.config.ts, so the stress burst meets the real per-user limit. */
const USER_POLICY = { capacity: 60, refillPerSecond: 10 };
/**
 * Every request of a probe comes from one loopback address. The real IP bucket (120, 20/s) is
 * replaced by a large one so the rate-limit burst is decided by the user bucket alone.
 */
const IP_POLICY = { capacity: 100_000, refillPerSecond: 100_000 };

/** `no-rate-limit`: a limiter that never refuses. */
class UnlimitedRateLimiter extends RateLimiter {
  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory adapter of an async port
  override async take(): ReturnType<RateLimiter['take']> {
    return { allowed: true, retryAfterSeconds: 0, state: { tokens: 1, updatedAt: Date.now() } };
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

/** `history-ascending` and `history-overlap`: a page query that breaks newest-first cursors. */
class MisorderedMessageRepository extends InMemoryMessageRepository {
  constructor(private readonly mode: 'ascending' | 'overlap') {
    super();
  }

  override async page(
    roomId: Parameters<InMemoryMessageRepository['page']>[0],
    query: Parameters<InMemoryMessageRepository['page']>[1],
  ): ReturnType<InMemoryMessageRepository['page']> {
    if (this.mode === 'ascending') {
      const rows = await super.page(roomId, query);
      return rows.toReversed();
    }
    // An inclusive cursor: the last message of a page comes back first on the next one.
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
  if (sabotage === 'history-ascending' || sabotage === 'history-overlap') {
    return new MisorderedMessageRepository(
      sabotage === 'history-ascending' ? 'ascending' : 'overlap',
    );
  }
  return new InMemoryMessageRepository();
}

/** `no-retry-after`: the 429 keeps its body but loses its `Retry-After` header. */
export function startFakeMessagesServer(sabotage: MessagesSabotage): FakeMessagesServer {
  // Sabotages throw on purpose; a real defect in the honest mode still fails the k6 checks.
  const logger = { error: () => null };
  const users = new UserRepositoryImpl(new InMemoryUserDatasource());
  const hasher = new FakePasswordHasher();
  const tokens = new JoseTokenIssuer(SECRET);
  const verifier = new JoseTokenVerifier(SECRET);
  const rooms = new InMemoryRoomRepository();
  const messages = messageRepositoryFor(sabotage);
  const receipts = new InMemoryReceiptRepository(rooms);
  const keys = new InMemoryKeyDirectory();
  const senderKeys = new InMemorySenderKeyRepository();
  const listRooms = new ListRoomsUseCase(rooms);

  const history = new HistoryUseCase(rooms, messages);
  if (sabotage === 'non-member-history') {
    // Membership is ignored: the history is read as if the caller were the room's first member.
    const execute = history.execute.bind(history);
    history.execute = async (actor, rawRoomId, query) => {
      const roomId = RoomId.create(rawRoomId);
      const room = roomId.ok ? await rooms.findById(roomId.value) : null;
      return execute(room?.memberIds[0] ?? actor, rawRoomId, query);
    };
  }
  const storeSenderKeys = new StoreSenderKeysUseCase(rooms, senderKeys);
  if (sabotage === 'sender-keys-500') {
    storeSenderKeys.execute = async () => {
      throw new Error('sabotage: sender-key storage is down');
    };
  }

  const gateway = createSocketGateway({
    listRooms,
    logger,
    receipt: new ReceiptUseCase(rooms, messages, receipts),
    rooms,
    sendMessage: new SendMessageUseCase(rooms, messages),
    verifier,
  });
  const websocket: Bun.WebSocketHandler<SocketConnection> =
    sabotage === 'no-ack' ? droppingAcks(gateway.websocket) : gateway.websocket;

  const guards = createGuards({
    limiter: sabotage === 'no-rate-limit' ? new UnlimitedRateLimiter() : new InMemoryRateLimiter(),
    logger,
    policies: { ip: IP_POLICY, user: USER_POLICY },
    verifier,
  });

  const server = createServer({
    auth: createAuthController(
      {
        signIn: new SignInUseCase(users, hasher, tokens),
        signUp: new SignUpUseCase(users, hasher, tokens),
      },
      logger,
    ),
    messaging: {
      controller: createMessagingController({
        events: gateway.events,
        logger,
        useCases: {
          addMember: new AddMemberUseCase(rooms),
          createRoom: new CreateRoomUseCase(rooms),
          fetchSenderKeys: new FetchSenderKeysUseCase(rooms, senderKeys),
          history,
          leaveRoom: new LeaveRoomUseCase(rooms),
          listReceipts: new ListReceiptsUseCase(rooms, receipts),
          listRoomKeys: new ListRoomKeysUseCase(rooms, keys),
          listRoomMembers: new ListRoomMembersUseCase(rooms, new InMemoryMemberDirectory()),
          listRooms,
          publishIdentityKey: new PublishIdentityKeyUseCase(keys),
          storeSenderKeys,
        },
      }),
      gateway: { ...gateway, websocket },
      guards: sabotage === 'no-retry-after' ? withoutRetryAfter(guards) : guards,
      refresh: createRefreshController(new RefreshUseCase(verifier, users, tokens), logger),
      signOut: createSignOutController(
        new SignOutUseCase(verifier, new InMemorySessionRevocations(), (sessionId) => {
          gateway.closeSession(sessionId);
        }),
        logger,
      ),
      users: createUserController({ lookup: new LookupUserUseCase(users) }, logger),
    },
    port: 0,
  });

  return {
    baseUrl: `http://localhost:${server.port}`,
    stop: async () => {
      await gateway.drain();
      await server.stop(true);
    },
    storedMessages: () => messages.messages.length,
  };
}

async function stripRetryAfter(response: Promise<Response>): Promise<Response> {
  const original = await response;
  if (original.status !== 429) {
    return original;
  }
  const headers = new Headers(original.headers);
  headers.delete('retry-after');
  return new Response(original.body, { headers, status: original.status });
}

function withoutRetryAfter(guards: Guards): Guards {
  return {
    authenticated: (handler) => {
      const route = guards.authenticated(handler);
      return async (request, server) => stripRetryAfter(route(request, server));
    },
    public: guards.public,
    upgrade: guards.upgrade,
  };
}

/** `no-ack`: every socket silently drops the `message.ack` frames the gateway sends it. */
function droppingAcks(
  handler: Bun.WebSocketHandler<SocketConnection>,
): Bun.WebSocketHandler<SocketConnection> {
  return {
    ...handler,
    open: (ws) => {
      const send = ws.send.bind(ws);
      Object.defineProperty(ws, 'send', {
        value: (data: string, compress?: boolean) =>
          data.includes('"type":"message.ack"') ? 0 : send(data, compress),
      });
      void handler.open?.(ws);
    },
  };
}
