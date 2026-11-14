import type {
  MessagingController,
  RoomHandler,
} from '../../messaging/presentation/messaging.controller.ts';
import type { SocketConnection } from '../../messaging/presentation/messaging.socket.connection.ts';
import type { SocketGateway } from '../../messaging/presentation/messaging.socket.gateway.ts';
import type {
  AuthController,
  RefreshController,
  SignOutController,
  UserController,
} from '../../user/presentation/user.controller.ts';
import type { GuardedRoute, Guards } from './http.guard.ts';

import signInPage from '../../../frontend/auth/sign-in.html';
import signUpPage from '../../../frontend/auth/sign-up.html';
import index from '../../../frontend/index.html';
import chatPage from '../../../frontend/messaging/chat.html';
import { SOCKET_PATH } from '../../../shared/contracts/messaging.socket.contract.ts';
import { NotFoundError } from '../domain/app.error.ts';
import { errorResponse } from './http.error-response.ts';

/** Everything the messaging feature mounts: REST routes behind the guards, and `/ws`. */
export type MessagingServerDependencies = {
  readonly controller: MessagingController;
  readonly gateway: SocketGateway;
  readonly guards: Guards;
  readonly refresh: RefreshController;
  readonly signOut: SignOutController;
  readonly users: UserController;
};

export type ServerDependencies = {
  readonly auth: AuthController;
  readonly development?: boolean;
  /** Absent in tests that only exercise sign-in and sign-up. */
  readonly messaging?: MessagingServerDependencies;
  readonly port: number;
};

/** Path parameters come from the route pattern; a missing one is never matched by Bun. */
type RouteRequest = Bun.BunRequest;

/** Without the messaging feature no route upgrades, so this handler never runs. */
const NO_SOCKETS: Bun.WebSocketHandler<SocketConnection> = {
  message: () => {
    // Unreachable: only `/ws` upgrades, and it is mounted with the messaging feature.
  },
};

export function createServer({
  auth,
  development = false,
  messaging,
  port,
}: ServerDependencies): Bun.Server<SocketConnection> {
  return Bun.serve<SocketConnection>({
    development,
    fetch: (request) =>
      errorResponse(
        request,
        new NotFoundError(`Route ${request.method} ${new URL(request.url).pathname} not found`),
      ),
    port,
    routes: {
      '/': index,
      '/api/auth/sign-in': { POST: messaging ? messaging.guards.public(auth.signIn) : auth.signIn },
      '/api/auth/sign-up': { POST: messaging ? messaging.guards.public(auth.signUp) : auth.signUp },
      '/chat': chatPage,
      '/sign-in': signInPage,
      '/sign-up': signUpPage,
      ...(messaging && messagingRoutes(messaging)),
    },
    websocket: messaging?.gateway.websocket ?? NO_SOCKETS,
  });
}

function messagingRoutes({
  controller,
  gateway,
  guards,
  refresh,
  signOut,
  users,
}: MessagingServerDependencies): Bun.Serve.RoutesWithUpgrade<SocketConnection, string> {
  const inRoom = (handler: RoomHandler): GuardedRoute<RouteRequest> =>
    guards.authenticated<RouteRequest>(async (request, actor) =>
      handler(request, actor, request.params.roomId ?? ''),
    );
  return {
    '/api/auth/refresh': { POST: guards.public(refresh.refresh) },
    '/api/auth/sign-out': { POST: guards.public(signOut.signOut) },
    '/api/keys/identity': { PUT: guards.authenticated(controller.publishIdentityKey) },
    '/api/rooms': {
      GET: guards.authenticated(controller.listRooms),
      POST: guards.authenticated(controller.createRoom),
    },
    '/api/rooms/:roomId/keys': { GET: inRoom(controller.roomKeys) },
    '/api/rooms/:roomId/members': {
      GET: inRoom(controller.members),
      POST: inRoom(controller.addMember),
    },
    '/api/rooms/:roomId/members/me': { DELETE: inRoom(controller.leaveRoom) },
    '/api/rooms/:roomId/messages': { GET: inRoom(controller.history) },
    '/api/rooms/:roomId/receipts': { GET: inRoom(controller.receipts) },
    '/api/rooms/:roomId/sender-keys': {
      GET: inRoom(controller.fetchSenderKeys),
      POST: inRoom(controller.storeSenderKeys),
    },
    '/api/users/:name': {
      GET: guards.authenticated<RouteRequest>(async (request, actor) =>
        users.lookup(request, actor, request.params.name ?? ''),
      ),
    },
    [SOCKET_PATH]: guards.upgrade<Bun.Server<SocketConnection>>(async (request, server) =>
      gateway.upgrade(request, server),
    ),
  };
}
