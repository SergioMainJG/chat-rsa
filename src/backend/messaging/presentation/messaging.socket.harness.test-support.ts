import { expect } from 'bun:test';

import type { BucketPolicy } from '../../shared/domain/token-bucket.ts';
import type { SocketConnection } from './messaging.socket.connection.ts';

import {
  BEARER_PREFIX,
  type ServerFrame,
  SOCKET_PATH,
  SOCKET_PROTOCOL,
} from '../../../shared/contracts/messaging.socket.contract.ts';
import { UserId } from '../../user/domain/user.value-objects.ts';
import {
  InMemoryReceiptRepository,
  InMemoryRoomRepository,
  zeros,
} from '../application/messaging.fakes.test-support.ts';
import { ReceiptUseCase } from '../application/messaging.receipt.use-case.ts';
import { CreateRoomUseCase, ListRoomsUseCase } from '../application/messaging.rooms.use-case.ts';
import { SendMessageUseCase } from '../application/messaging.send-message.use-case.ts';
import {
  FakeTokenVerifier,
  GatedMessageRepository,
  ManualScheduler,
} from './messaging.socket.fakes.test-support.ts';
import { createSocketGateway, type SocketGateway } from './messaging.socket.gateway.ts';

// A real Bun server and real WebSocket clients around the gateway, shared by the socket tests.

/** Large enough that no test except the flood tests hits the frame limit. */
const GENEROUS_LIMIT: BucketPolicy = { capacity: 10_000, refillPerSecond: 1 };
export const START = Date.UTC(2026, 10, 12, 12);
export const HOUR = 3_600_000;
export const ALICE = UserId.restore(1);
export const BOB = UserId.restore(2);
export const CAROL = UserId.restore(3);
export const MALLORY = UserId.restore(9);
export type Closed = { readonly code: number; readonly reason: string };
export type FrameOf<T extends ServerFrame['type']> = Extract<ServerFrame, { type: T }>;
type Waiter = {
  readonly match: (frame: ServerFrame) => boolean;
  readonly resolve: (frame: ServerFrame) => void;
};

/** A browser-like client that records every frame and lets tests wait for one. */
export type Harness = {
  readonly clients: Client[];
  readonly gateway: SocketGateway;
  readonly messages: GatedMessageRepository;
  /** Users whose pongs the server never sees, as if their wire went dead. */
  readonly muted: Set<number>;
  readonly pongs: { count: number };
  readonly rooms: InMemoryRoomRepository;
  readonly scheduler: ManualScheduler;
  readonly server: Bun.Server<SocketConnection>;
  readonly verifier: FakeTokenVerifier;
};

export class Client {
  readonly closed: Promise<Closed>;
  readonly frames: ServerFrame[] = [];
  private readonly taken = new Set<ServerFrame>();
  private readonly waiters: Waiter[] = [];

  constructor(readonly socket: WebSocket) {
    const closed = Promise.withResolvers<Closed>();
    this.closed = closed.promise;
    socket.addEventListener('close', (event) => {
      closed.resolve({ code: event.code, reason: event.reason });
    });
    socket.addEventListener('message', (event) => {
      const frame: ServerFrame = JSON.parse(String(event.data));
      this.frames.push(frame);
      const index = this.waiters.findIndex((waiter) => waiter.match(frame));
      if (index !== -1) {
        const [waiter] = this.waiters.splice(index, 1);
        this.taken.add(frame);
        waiter?.resolve(frame);
      }
    });
  }

  /** A server round trip: every frame published to this socket before it is now in `frames`. */
  async barrier(): Promise<void> {
    this.socket.send('barrier');
    await this.next('error', (frame) => frame.code === 'bad_frame');
  }

  count<T extends ServerFrame['type']>(
    type: T,
    match: (frame: FrameOf<T>) => boolean = () => true,
  ): number {
    return this.frames.filter((frame) => hasType(frame, type) && match(frame)).length;
  }

  async next<T extends ServerFrame['type']>(
    type: T,
    match: (frame: FrameOf<T>) => boolean = () => true,
  ): Promise<FrameOf<T>> {
    const accepts = (frame: ServerFrame): frame is FrameOf<T> =>
      hasType(frame, type) && match(frame);
    const early = this.frames.find(
      (frame): frame is FrameOf<T> => !this.taken.has(frame) && accepts(frame),
    );
    if (early) {
      this.taken.add(early);
      return early;
    }
    const waiter = Promise.withResolvers<FrameOf<T>>();
    this.waiters.push({
      match: accepts,
      resolve: (frame) => {
        if (accepts(frame)) {
          waiter.resolve(frame);
        }
      },
    });
    return waiter.promise;
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }
}

let current: Harness | null = null;

export function hasType<T extends ServerFrame['type']>(
  frame: ServerFrame,
  type: T,
): frame is FrameOf<T> {
  return frame.type === type;
}

/** Closes every client and stops the server of the harness the last `start` created. */
export type HarnessOptions = {
  readonly frameLimit?: BucketPolicy;
  /** Replaces the room listing used by `welcome`, for tests that hold it open. */
  readonly listRooms?: (rooms: InMemoryRoomRepository) => ListRoomsUseCase;
};

export async function closeCode(client: Client): Promise<number> {
  const { code } = await client.closed;
  return code;
}

export async function connect(harness: Harness, token: string): Promise<Client> {
  const socket = new WebSocket(url(harness), [SOCKET_PROTOCOL, `${BEARER_PREFIX}${token}`]);
  const client = new Client(socket);
  harness.clients.push(client);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('WebSocket failed to open'));
    });
  });
  await client.next('ready');
  return client;
}

export async function room(
  harness: Harness,
  memberIds: readonly number[],
): Promise<{ id: string; keyEpoch: number }> {
  const created = await new CreateRoomUseCase(harness.rooms).execute(ALICE, {
    memberIds,
    name: 'Room',
  });
  if (!created.ok) {
    throw created.error;
  }
  return created.value;
}

export function sendFrame(
  target: { id: string; keyEpoch: number },
  idempotencyKey: string = crypto.randomUUID(),
): Record<string, unknown> {
  return {
    authTag: zeros(16),
    chainIndex: 0,
    ciphertext: 'AQID',
    idempotencyKey,
    iv: zeros(12),
    keyEpoch: target.keyEpoch,
    roomId: target.id,
    type: 'message.send',
  };
}

export function start(options: BucketPolicy | HarnessOptions = {}): Harness {
  const {
    frameLimit = GENEROUS_LIMIT,
    listRooms = (repository: InMemoryRoomRepository) => new ListRoomsUseCase(repository),
  } = 'capacity' in options ? { frameLimit: options } : options;
  const rooms = new InMemoryRoomRepository();
  const messages = new GatedMessageRepository();
  const receipts = new InMemoryReceiptRepository(rooms);
  const scheduler = new ManualScheduler(START);
  const verifier = new FakeTokenVerifier()
    .add('alice', ALICE, START + HOUR)
    .add('alice-short', ALICE, START + 10_000)
    .add('alice-later', ALICE, START + 20_000)
    .add('alice-phone', ALICE, START + HOUR, 'alice-phone-session')
    .add('bob', BOB, START + HOUR)
    .add('carol', CAROL, START + HOUR)
    .add('mallory', MALLORY, START + HOUR);
  const gateway = createSocketGateway({
    frameLimit,
    listRooms: listRooms(rooms),
    logger: { error: () => null },
    now: () => scheduler.now,
    receipt: new ReceiptUseCase(rooms, messages, receipts),
    rooms,
    scheduler,
    sendMessage: new SendMessageUseCase(rooms, messages),
    verifier,
  });
  const muted = new Set<number>();
  const pongs = { count: 0 };
  const server = Bun.serve({
    fetch: () => new Response('not found', { status: 404 }),
    port: 0,
    routes: { [SOCKET_PATH]: async (request, bunServer) => gateway.upgrade(request, bunServer) },
    websocket: {
      ...gateway.websocket,
      pong: (ws, data) => {
        if (!muted.has(ws.data.userId)) {
          void gateway.websocket.pong?.(ws, data);
          pongs.count += 1;
        }
      },
    },
  });
  current = { clients: [], gateway, messages, muted, pongs, rooms, scheduler, server, verifier };
  return current;
}

export async function stopHarness(): Promise<void> {
  const harness = current;
  current = null;
  if (harness) {
    for (const client of harness.clients) {
      client.socket.close();
    }
    await harness.server.stop(true);
  }
}

export function upgradeRequest(harness: Harness, protocol: null | string): Request {
  const headers = new Headers({ connection: 'Upgrade', upgrade: 'websocket' });
  if (protocol !== null) {
    headers.set('sec-websocket-protocol', protocol);
  }
  return new Request(`http://localhost:${harness.server.port}${SOCKET_PATH}`, { headers });
}

export function url(harness: Harness): string {
  return `ws://localhost:${harness.server.port}${SOCKET_PATH}`;
}

export async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(2);
  }
  expect(condition()).toBe(true);
}
