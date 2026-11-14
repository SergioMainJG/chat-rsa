import { afterEach, describe, expect, test } from 'bun:test';

import type { RoomSummary } from '../../../shared/contracts/messaging.contract.ts';
import type { AppError } from '../../shared/domain/app.error.ts';
import type { Result } from '../../shared/domain/result.ts';
import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { InMemoryRoomRepository } from '../application/messaging.fakes.test-support.ts';

import { BEARER_PREFIX, SOCKET_PROTOCOL } from '../../../shared/contracts/messaging.socket.contract.ts';
import { AddMemberUseCase, ListRoomsUseCase } from '../application/messaging.rooms.use-case.ts';
import {
  ALICE,
  BOB,
  CAROL,
  Client,
  connect,
  type Harness,
  room,
  start,
  stopHarness,
  url,
  waitUntil,
} from './messaging.socket.harness.test-support.ts';

// BUG-HIGH-07: presence must match who is really connected, whatever order sockets open and close
// in, and a member added over REST must see and be seen like any other member.

afterEach(stopHarness);

/** Holds every room listing (the first step of `welcome`) until `open()`. */
class GatedListRooms extends ListRoomsUseCase {
  private gate: null | PromiseWithResolvers<null> = null;

  close(): void {
    this.gate = Promise.withResolvers<null>();
  }

  override async execute(actor: UserId): Promise<Result<RoomSummary[], AppError>> {
    await this.gate?.promise;
    return super.execute(actor);
  }

  open(): void {
    this.gate?.resolve(null);
    this.gate = null;
  }
}

function gatedHarness(): { harness: Harness; listRooms: GatedListRooms } {
  const built: { listRooms?: GatedListRooms } = {};
  const harness = start({
    listRooms: (rooms: InMemoryRoomRepository) => {
      built.listRooms = new GatedListRooms(rooms);
      return built.listRooms;
    },
  });
  const { listRooms } = built;
  if (!listRooms) {
    throw new Error('listRooms was not built');
  }
  return { harness, listRooms };
}

/** Opens a socket without waiting for `ready`, which a gated `welcome` holds back. */
async function openOnly(harness: Harness, token: string): Promise<Client> {
  const client = new Client(new WebSocket(url(harness), [SOCKET_PROTOCOL, `${BEARER_PREFIX}${token}`]));
  harness.clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.socket.addEventListener('open', () => {
      resolve();
    });
    client.socket.addEventListener('error', () => {
      reject(new Error('WebSocket failed to open'));
    });
  });
  return client;
}

describe('presence.snapshot', () => {
  test('lists only the members that are connected', async () => {
    const harness = start();
    const trio = await room(harness, [BOB, CAROL]);
    const alice = await connect(harness, 'alice');
    expect(await alice.next('presence.snapshot')).toEqual({
      online: [ALICE],
      roomId: trio.id,
      type: 'presence.snapshot',
    });

    const bob = await connect(harness, 'bob');
    expect(await bob.next('presence.snapshot')).toEqual({
      online: [ALICE, BOB],
      roomId: trio.id,
      type: 'presence.snapshot',
    });
  });
});

describe('concurrent sockets of one user', () => {
  test('the user is announced online when the first socket closes before its welcome finished', async () => {
    const { harness, listRooms } = gatedHarness();
    const duo = await room(harness, [BOB]);
    const bob = await connect(harness, 'bob');

    listRooms.close();
    const first = await openOnly(harness, 'alice');
    const second = await openOnly(harness, 'alice');
    first.socket.close();
    await waitUntil(() => harness.gateway.connectionCount() === 2);
    listRooms.open();

    await second.next('ready');
    expect(await bob.next('presence')).toEqual({ online: true, roomId: duo.id, type: 'presence', userId: ALICE });
    await bob.barrier();
    expect(bob.count('presence')).toBe(1);
  });

  test('a user announced once is not announced again by a second socket', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const bob = await connect(harness, 'bob');
    await connect(harness, 'alice');
    await connect(harness, 'alice');
    await bob.barrier();
    expect(bob.count('presence', (frame) => frame.userId === ALICE && frame.roomId === duo.id)).toBe(1);
  });

  test('after the last socket closed, a new socket announces the user again', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const bob = await connect(harness, 'bob');
    const first = await connect(harness, 'alice');
    first.socket.close();
    expect(await bob.next('presence', (frame) => !frame.online)).toEqual({
      online: false,
      roomId: duo.id,
      type: 'presence',
      userId: ALICE,
    });

    await connect(harness, 'alice');
    await bob.barrier();
    expect(bob.count('presence', (frame) => frame.online)).toBe(2);
  });
});

describe('membersChanged', () => {
  test('an added member gets the room snapshot and the room sees them online', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    const carol = await connect(harness, 'carol');

    const added = await new AddMemberUseCase(harness.rooms).execute(ALICE, duo.id, { userId: CAROL });
    if (!added.ok) {
      throw added.error;
    }
    harness.gateway.events.membersChanged(added.value, { added: CAROL, removed: null });

    expect(await carol.next('presence.snapshot')).toEqual({
      online: [ALICE, CAROL],
      roomId: duo.id,
      type: 'presence.snapshot',
    });
    expect(await alice.next('presence', (frame) => frame.userId === CAROL)).toEqual({
      online: true,
      roomId: duo.id,
      type: 'presence',
      userId: CAROL,
    });
    expect(await carol.next('room.rotated')).toEqual({
      keyEpoch: added.value.keyEpoch,
      roomId: duo.id,
      type: 'room.rotated',
    });
  });

  test('an added member whose welcome is still running is announced once, by the welcome', async () => {
    const { harness, listRooms } = gatedHarness();
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');
    listRooms.close();
    const carol = await openOnly(harness, 'carol');
    await waitUntil(() => harness.gateway.connectionCount() === 2);

    const added = await new AddMemberUseCase(harness.rooms).execute(ALICE, duo.id, { userId: CAROL });
    if (!added.ok) {
      throw added.error;
    }
    harness.gateway.events.membersChanged(added.value, { added: CAROL, removed: null });
    listRooms.open();

    await carol.next('ready');
    await alice.next('presence', (frame) => frame.userId === CAROL);
    await alice.barrier();
    expect(alice.count('presence', (frame) => frame.userId === CAROL)).toBe(1);
  });

  test('an added member who is offline is not announced', async () => {
    const harness = start();
    const duo = await room(harness, [BOB]);
    const alice = await connect(harness, 'alice');

    const added = await new AddMemberUseCase(harness.rooms).execute(ALICE, duo.id, { userId: CAROL });
    if (!added.ok) {
      throw added.error;
    }
    harness.gateway.events.membersChanged(added.value, { added: CAROL, removed: null });

    await alice.next('room.rotated');
    await alice.barrier();
    expect(alice.count('presence', (frame) => frame.userId === CAROL)).toBe(0);
  });
});
