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

import signInEn from '../../../frontend/auth/sign-in.en.html';
import signInEs from '../../../frontend/auth/sign-in.es.html';
import signUpEn from '../../../frontend/auth/sign-up.en.html';
import signUpEs from '../../../frontend/auth/sign-up.es.html';
import indexEn from '../../../frontend/index.en.html';
import indexEs from '../../../frontend/index.es.html';
import chatEn from '../../../frontend/messaging/chat.en.html';
import chatEs from '../../../frontend/messaging/chat.es.html';
import { SOCKET_PATH } from '../../../shared/contracts/messaging.socket.contract.ts';
import {
  type Locale,
  localePath,
  LOCALES,
  type Page,
  PAGES,
} from '../../../shared/i18n/i18n.locale.ts';
import { NotFoundError } from '../domain/app.error.ts';
import { errorResponse } from './http.error-response.ts';
import { localeRedirectRoutes } from './locale-redirect.ts';
import { publicAssetRoutes } from './public-assets.ts';

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
  /**
   * Pages prebuilt by `buildPages` (production). Absent, the HTML imports are served as they are,
   * with hot reload in development but without the security headers.
   */
  readonly pages?: Readonly<Record<string, (request: Request) => Response>>;
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
  pages,
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
      ...publicAssetRoutes(),
      '/api/auth/sign-in': { POST: messaging ? messaging.guards.public(auth.signIn) : auth.signIn },
      '/api/auth/sign-up': { POST: messaging ? messaging.guards.public(auth.signUp) : auth.signUp },
      ...localeRedirectRoutes(),
      ...(pages ?? htmlImportPages()),
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
    '/api/auth/refresh': { POST: guards.session(refresh.refresh) },
    '/api/auth/sign-out': { POST: guards.session(signOut.signOut) },
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

/** The HTML imports, served as they are (hot reload in development), one route per locale page. */
function htmlImportPages(): Record<string, Bun.HTMLBundle> {
  const bundles: Record<Locale, Record<Page, Bun.HTMLBundle>> = {
    en: { chat: chatEn, home: indexEn, 'sign-in': signInEn, 'sign-up': signUpEn },
    es: { chat: chatEs, home: indexEs, 'sign-in': signInEs, 'sign-up': signUpEs },
  };
  return Object.fromEntries(
    LOCALES.flatMap((locale) =>
      PAGES.map((page) => [localePath(locale, page), bundles[locale][page]]),
    ),
  );
}
