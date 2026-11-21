import { afterEach, describe, expect, test } from 'bun:test';

import type { RoomSummary } from '../../../shared/contracts/messaging.contract.ts';
import type { AppError } from '../../shared/domain/app.error.ts';
import type { Result } from '../../shared/domain/result.ts';
import type { UserId } from '../../user/domain/user.value-objects.ts';
import type { InMemoryRoomRepository } from '../application/messaging.fakes.test-support.ts';

import { BEARER_PREFIX, SOCKET_PROTOCOL } from '../../../shared/contracts/messaging.socket.contract.ts';
import { LeaveRoomUseCase, ListRoomsUseCase } from '../application/messaging.rooms.use-case.ts';
import {
  BOB,
  CAROL,
  Client,
  connect,
  type Harness,
  room,
  sendFrame,
  start,
  stopHarness,
  url,
  waitUntil,
} from './messaging.socket.harness.test-support.ts';

// A member who leaves while their socket is still looking up its rooms (welcome) or a room
// (room.subscribe) must not end up subscribed to that room once the lookup resumes.

afterEach(stopHarness);

/** A gate that a lookup reaches after it has read the repository, and waits at until `open()`. */
class Gate {
  private readonly reached = Promise.withResolvers<null>();
  private readonly released = Promise.withResolvers<null>();
  private used = false;

  /** Holds only the first caller, so lookups after the race run normally. */
  async hold(): Promise<void> {
    if (this.used) {
      return;
    }
    this.used = true;
    this.reached.resolve(null);
    await this.released.promise;
  }

  open(): void {
    this.released.resolve(null);
  }

  async waitReached(): Promise<void> {
    await this.reached.promise;
  }
}

/** Reads the rooms first, then waits: the result it returns is already stale when it resumes. */
class StaleListRooms extends ListRoomsUseCase {
  readonly gate = new Gate();

  override async execute(actor: UserId): Promise<Result<RoomSummary[], AppError>> {
    const result = await super.execute(actor);
    await this.gate.hold();
    return result;
  }
}

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

/** Carol leaves over REST; returns the room's new key epoch. */
async function leave(harness: Harness, roomId: string): Promise<number> {
  const left = await new LeaveRoomUseCase(harness.rooms).execute(CAROL, roomId);
  if (!left.ok) {
    throw left.error;
  }
  harness.gateway.events.membersChanged(left.value, { added: null, removed: CAROL });
  return left.value.keyEpoch;
}

/** Alice sends to the room; Bob (still a member) must get it, Carol must not. */
async function expectOnlyMembersReceive(
  harness: Harness,
  target: { id: string; keyEpoch: number },
  bob: Client,
  carol: Client,
): Promise<void> {
  const alice = await connect(harness, 'alice');
  alice.send(sendFrame(target));
  await bob.next('message.new');
  await carol.barrier();
  expect(carol.count('message.new')).toBe(0);
}

describe('leaving while a membership lookup is in flight', () => {
  test('welcome: a member who left during the room listing is not subscribed to that room', async () => {
    const built: { listRooms?: StaleListRooms } = {};
    const harness = start({
      listRooms: (rooms: InMemoryRoomRepository) => {
        built.listRooms = new StaleListRooms(rooms);
        return built.listRooms;
      },
    });
    const { listRooms } = built;
    if (!listRooms) {
      throw new Error('listRooms was not built');
    }
    const trio = await room(harness, [BOB, CAROL]);
    const carol = await openOnly(harness, 'carol');
    await listRooms.gate.waitReached();

    const keyEpoch = await leave(harness, trio.id);
    listRooms.gate.open();

    const ready = await carol.next('ready');
    expect(ready.roomIds).toEqual([]);
    const bob = await connect(harness, 'bob');
    await waitUntil(() => harness.gateway.connectionCount() === 2);
    await expectOnlyMembersReceive(harness, { id: trio.id, keyEpoch }, bob, carol);
  });

  test('room.subscribe: a member who left during the room lookup is not subscribed again', async () => {
    const harness = start();
    const trio = await room(harness, [BOB, CAROL]);
    const bob = await connect(harness, 'bob');
    const carol = await connect(harness, 'carol');
    const gate = new Gate();
    const { rooms } = harness;
    const findById = rooms.findById.bind(rooms);
    rooms.findById = async (id) => {
      const found = await findById(id);
      await gate.hold();
      return found;
    };

    carol.send({ roomId: trio.id, type: 'room.subscribe' });
    await gate.waitReached();
    const keyEpoch = await leave(harness, trio.id);
    gate.open();

    expect(await carol.next('error')).toMatchObject({ code: 'forbidden', type: 'error' });
    await expectOnlyMembersReceive(harness, { id: trio.id, keyEpoch }, bob, carol);
  });
});
