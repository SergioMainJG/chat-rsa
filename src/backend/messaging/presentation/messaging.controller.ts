import type { Logger } from '../../shared/domain/logger.ts';
import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { RoomEvents } from '../application/messaging.events.ts';
import type { HistoryUseCase } from '../application/messaging.history.use-case.ts';
import type {
  FetchSenderKeysUseCase,
  ListRoomKeysUseCase,
  PublishIdentityKeyUseCase,
  StoreSenderKeysUseCase,
} from '../application/messaging.keys.use-case.ts';
import type { ListReceiptsUseCase } from '../application/messaging.receipts-list.use-case.ts';
import type {
  AddMemberUseCase,
  CreateRoomUseCase,
  LeaveRoomUseCase,
  ListRoomMembersUseCase,
  ListRoomsUseCase,
} from '../application/messaging.rooms.use-case.ts';

import { ValidationError } from '../../shared/domain/app.error.ts';
import { readJsonObject, readQuery, unknownKeyErrors } from '../../shared/http/http.json-body.ts';
import { respond, resultResponse } from '../../shared/http/http.respond.ts';

/** Handler of a route without path parameters. */
export type ActorHandler = (request: Request, actor: UserId) => Promise<Response>;

export type MessagingController = {
  /** `POST /api/rooms/:roomId/members`, body `{ userId }`: 201. */
  readonly addMember: RoomHandler;
  /** `POST /api/rooms`, body `{ name, memberIds }`: 201. */
  readonly createRoom: ActorHandler;
  /** `GET /api/rooms/:roomId/sender-keys?keyEpoch`. */
  readonly fetchSenderKeys: RoomHandler;
  /** `GET /api/rooms/:roomId/messages?before&since&until&limit`. */
  readonly history: RoomHandler;
  /** `DELETE /api/rooms/:roomId/members/me`: 200. */
  readonly leaveRoom: RoomHandler;
  /** `GET /api/rooms`. */
  readonly listRooms: ActorHandler;
  /** `GET /api/rooms/:roomId/members`: `{ id, name }[]` of the members. */
  readonly members: RoomHandler;
  /** `PUT /api/keys/identity`, body `{ publicKey }`. */
  readonly publishIdentityKey: ActorHandler;
  /** `GET /api/rooms/:roomId/receipts`: `{ userId, delivered, read }[]`. */
  readonly receipts: RoomHandler;
  /** `GET /api/rooms/:roomId/keys`: the members' identity public keys. */
  readonly roomKeys: RoomHandler;
  /** `POST /api/rooms/:roomId/sender-keys`, body `{ keyEpoch, envelopes }`: 201. */
  readonly storeSenderKeys: RoomHandler;
};

export type MessagingControllerDependencies = {
  readonly events: RoomEvents;
  readonly logger: Logger;
  readonly useCases: MessagingUseCases;
};

export type MessagingUseCases = {
  readonly addMember: AddMemberUseCase;
  readonly createRoom: CreateRoomUseCase;
  readonly fetchSenderKeys: FetchSenderKeysUseCase;
  readonly history: HistoryUseCase;
  readonly leaveRoom: LeaveRoomUseCase;
  readonly listReceipts: ListReceiptsUseCase;
  readonly listRoomKeys: ListRoomKeysUseCase;
  readonly listRoomMembers: ListRoomMembersUseCase;
  readonly listRooms: ListRoomsUseCase;
  readonly publishIdentityKey: PublishIdentityKeyUseCase;
  readonly storeSenderKeys: StoreSenderKeysUseCase;
};

/** Handler of a `/api/rooms/:roomId/...` route; the router passes the raw path parameter. */
export type RoomHandler = (request: Request, actor: UserId, roomId: string) => Promise<Response>;

const ENVELOPE_KEYS = ['authTag', 'ciphertext', 'ephemeralPublicKey', 'iv', 'recipientId'];

/**
 * REST side of messaging (history, rooms, keys). Every handler reads its body or query strictly, so
 * an unknown field is a 400 before any use case runs, and room routes answer 403 to non-members.
 * Live sockets learn about a change through `RoomEvents`, only after it succeeded.
 */
export function createMessagingController({
  events,
  logger,
  useCases,
}: MessagingControllerDependencies): MessagingController {
  /** A failing listener must not turn a committed change into an error response. */
  function notify(announce: () => void): void {
    try {
      announce();
    } catch (error) {
      logger.error(error);
    }
  }

  return {
    addMember: async (request, actor, roomId) =>
      respond(request, logger, async () => {
        const body = await readJsonObject(request, ['userId']);
        const result = await useCases.addMember.execute(actor, roomId, body);
        if (result.ok) {
          const added = typeof body.userId === 'number' ? body.userId : null;
          notify(() => {
            events.membersChanged(result.value, { added, removed: null });
          });
        }
        return resultResponse(request, result, 201);
      }),
    createRoom: async (request, actor) =>
      respond(request, logger, async () => {
        const body = await readJsonObject(request, ['memberIds', 'name']);
        return resultResponse(request, await useCases.createRoom.execute(actor, body), 201);
      }),
    fetchSenderKeys: async (request, actor, roomId) =>
      respond(request, logger, async () => {
        const query = readQuery(new URL(request.url), ['keyEpoch']);
        return resultResponse(
          request,
          await useCases.fetchSenderKeys.execute(actor, roomId, query),
        );
      }),
    history: async (request, actor, roomId) =>
      respond(request, logger, async () => {
        const query = readQuery(new URL(request.url), ['before', 'limit', 'since', 'until']);
        return resultResponse(request, await useCases.history.execute(actor, roomId, query));
      }),
    leaveRoom: async (request, actor, roomId) =>
      respond(request, logger, async () => {
        readQuery(new URL(request.url), []);
        const result = await useCases.leaveRoom.execute(actor, roomId);
        if (result.ok) {
          notify(() => {
            events.membersChanged(result.value, { added: null, removed: actor });
          });
        }
        return resultResponse(request, result);
      }),
    listRooms: async (request, actor) =>
      respond(request, logger, async () => {
        readQuery(new URL(request.url), []);
        return resultResponse(request, await useCases.listRooms.execute(actor));
      }),
    members: async (request, actor, roomId) =>
      respond(request, logger, async () => {
        readQuery(new URL(request.url), []);
        return resultResponse(request, await useCases.listRoomMembers.execute(actor, roomId));
      }),
    publishIdentityKey: async (request, actor) =>
      respond(request, logger, async () => {
        const body = await readJsonObject(request, ['publicKey']);
        return resultResponse(request, await useCases.publishIdentityKey.execute(actor, body));
      }),
    receipts: async (request, actor, roomId) =>
      respond(request, logger, async () => {
        readQuery(new URL(request.url), []);
        return resultResponse(request, await useCases.listReceipts.execute(actor, roomId));
      }),
    roomKeys: async (request, actor, roomId) =>
      respond(request, logger, async () => {
        readQuery(new URL(request.url), []);
        return resultResponse(request, await useCases.listRoomKeys.execute(actor, roomId));
      }),
    storeSenderKeys: async (request, actor, roomId) =>
      respond(request, logger, async () => {
        const body = await readJsonObject(request, ['envelopes', 'keyEpoch']);
        rejectUnknownEnvelopeKeys(body.envelopes);
        const result = await useCases.storeSenderKeys.execute(actor, { ...body, roomId });
        if (result.ok) {
          notify(() => {
            events.senderKeysAvailable(roomId, result.value.keyEpoch, actor);
          });
        }
        return resultResponse(request, result, 201);
      }),
  };
}

/** Envelopes are nested objects, so their keys are checked here; their values by the use case. */
function rejectUnknownEnvelopeKeys(envelopes: unknown): void {
  if (!Array.isArray(envelopes)) {
    return;
  }
  const errors = envelopes.flatMap((entry: unknown, index) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? unknownKeyErrors(entry, ENVELOPE_KEYS, `envelopes[${index}].`)
      : [],
  );
  if (errors.length > 0) {
    throw new ValidationError(errors);
  }
}
