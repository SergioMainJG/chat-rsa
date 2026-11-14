import type { RedisClient, SQL } from 'bun';

import type { AppConfig } from './shared/config/env.config.ts';
import type { Logger } from './shared/domain/logger.ts';
import type { MessagingServerDependencies } from './shared/http/app.server.ts';
import type { PasswordHasher, TokenIssuer } from './user/domain/user.security.ts';

import { HistoryUseCase } from './messaging/application/messaging.history.use-case.ts';
import {
  FetchSenderKeysUseCase,
  ListRoomKeysUseCase,
  PublishIdentityKeyUseCase,
  StoreSenderKeysUseCase,
} from './messaging/application/messaging.keys.use-case.ts';
import { ReceiptUseCase } from './messaging/application/messaging.receipt.use-case.ts';
import { ListReceiptsUseCase } from './messaging/application/messaging.receipts-list.use-case.ts';
import {
  AddMemberUseCase,
  CreateRoomUseCase,
  LeaveRoomUseCase,
  ListRoomMembersUseCase,
  ListRoomsUseCase,
} from './messaging/application/messaging.rooms.use-case.ts';
import { SendMessageUseCase } from './messaging/application/messaging.send-message.use-case.ts';
import {
  PostgresKeyDirectory,
  PostgresSenderKeyRepository,
} from './messaging/infrastructure/messaging.keys.postgresql.ts';
import { PostgresMemberDirectory } from './messaging/infrastructure/messaging.members.postgresql.ts';
import { PostgresMessageRepository } from './messaging/infrastructure/messaging.messages.postgresql.ts';
import { PostgresReceiptRepository } from './messaging/infrastructure/messaging.receipts.postgresql.ts';
import { PostgresRoomRepository } from './messaging/infrastructure/messaging.rooms.postgresql.ts';
import { createMessagingController } from './messaging/presentation/messaging.controller.ts';
import { createSocketGateway } from './messaging/presentation/messaging.socket.gateway.ts';
import { createGuards } from './shared/http/http.guard.ts';
import { ValkeyRateLimiter } from './shared/rate-limit/rate-limit.valkey.ts';
import { LookupUserUseCase } from './user/application/user.lookup.use-case.ts';
import { RefreshUseCase } from './user/application/user.refresh.use-case.ts';
import { SignInUseCase } from './user/application/user.sign-in.use-case.ts';
import {
  RevocationAwareTokenVerifier,
  SignOutUseCase,
} from './user/application/user.sign-out.use-case.ts';
import { SignUpUseCase } from './user/application/user.sign-up.use-case.ts';
import { PostgresUserDatasource } from './user/infrastructure/user.datasource.postgresql.ts';
import { UserRepositoryImpl } from './user/infrastructure/user.repository.impl.ts';
import {
  JoseTokenVerifier,
  TOKEN_LIFETIME_SECONDS,
} from './user/infrastructure/user.security.jose.ts';
import { ValkeySessionRevocations } from './user/infrastructure/user.session-revocations.valkey.ts';
import {
  type AuthController,
  createAuthController,
  createRefreshController,
  createSignOutController,
  createUserController,
} from './user/presentation/user.controller.ts';

export type AppAdapters = {
  readonly cache: RedisClient;
  readonly config: Pick<AppConfig, 'jwtSecret' | 'rateLimit'>;
  readonly hasher: PasswordHasher;
  readonly logger: Logger;
  readonly sql: SQL;
  readonly tokens: TokenIssuer;
};

export type AppComposition = {
  readonly auth: AuthController;
  readonly messaging: MessagingServerDependencies;
};

/** Wires every feature's use cases to its adapters. Shared by `main.ts` and the e2e tests. */
export function composeApp({
  cache,
  config,
  hasher,
  logger,
  sql,
  tokens,
}: AppAdapters): AppComposition {
  const users = new UserRepositoryImpl(new PostgresUserDatasource(sql));
  // A minute past one token lifetime: a refresh that passed its check just before the sign-out
  // signs its token in the same second, and `exp` is rounded to whole seconds.
  const revocations = new ValkeySessionRevocations(cache, TOKEN_LIFETIME_SECONDS + 60);
  const verifier = new RevocationAwareTokenVerifier(
    new JoseTokenVerifier(config.jwtSecret),
    revocations,
  );
  const rooms = new PostgresRoomRepository(sql);
  const messages = new PostgresMessageRepository(sql);
  const receipts = new PostgresReceiptRepository(sql);
  const keys = new PostgresKeyDirectory(sql);
  const senderKeys = new PostgresSenderKeyRepository(sql);
  const listRooms = new ListRoomsUseCase(rooms);

  const gateway = createSocketGateway({
    listRooms,
    logger,
    receipt: new ReceiptUseCase(rooms, messages, receipts),
    rooms,
    sendMessage: new SendMessageUseCase(rooms, messages),
    verifier,
  });

  return {
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
          history: new HistoryUseCase(rooms, messages),
          leaveRoom: new LeaveRoomUseCase(rooms),
          listReceipts: new ListReceiptsUseCase(rooms, receipts),
          listRoomKeys: new ListRoomKeysUseCase(rooms, keys),
          listRoomMembers: new ListRoomMembersUseCase(rooms, new PostgresMemberDirectory(sql)),
          listRooms,
          publishIdentityKey: new PublishIdentityKeyUseCase(keys),
          storeSenderKeys: new StoreSenderKeysUseCase(rooms, senderKeys),
        },
      }),
      gateway,
      guards: createGuards({
        limiter: new ValkeyRateLimiter(cache),
        logger,
        policies: config.rateLimit,
        verifier,
      }),
      refresh: createRefreshController(new RefreshUseCase(verifier, users, tokens), logger),
      signOut: createSignOutController(
        new SignOutUseCase(verifier, revocations, (sessionId) => {
          gateway.closeSession(sessionId);
        }),
        logger,
      ),
      users: createUserController({ lookup: new LookupUserUseCase(users) }, logger),
    },
  };
}
