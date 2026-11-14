// k6 load test for the messaging feature: REST rooms, keys, history and receipts, plus live `/ws`
// sessions. Run it through `bun run test:load [smoke|load|stress]`, which starts the pinned
// grafana/k6 image and deletes every user this run created.
// test/load/messages.load.sabotage.test.ts proves that each check below catches a real defect.
import type { Options, Scenario } from 'k6/options';

import { check } from 'k6';
import { b64encode } from 'k6/encoding';
import { scenario } from 'k6/execution';
import { batch, expectedStatuses, type RefinedResponse, request, type ResponseType } from 'k6/http';
import { Counter } from 'k6/metrics';
import { setTimeout } from 'k6/timers';
import { WebSocket } from 'k6/websockets';

/** K6 injects this global; declared here because tsconfig only loads Bun's global types. */
// eslint-disable-next-line no-underscore-dangle -- `__ENV` is the name k6 itself gives this global
declare const __ENV: Readonly<Record<string, string | undefined>>;

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3000';
const WS_URL = `${BASE_URL.replace(/^http/u, 'ws')}/ws`;
const PROFILE = __ENV.PROFILE ?? 'smoke';
const PASSWORD = 'correct-Horse-battery-st4ple';
const SOCKET_PROTOCOL = 'chat-rsa.v1';
/** Same rule as runUserPattern in k6-runner.ts: no default, so two runs never share names. */
const RUN_ID = __ENV.RUN_ID ?? '';
if (!/^[0-9a-z]{8,}$/u.test(RUN_ID)) {
  throw new Error(`RUN_ID must be at least 8 lower-case alphanumerics, got "${RUN_ID}"`);
}
/** Every messaging user is `load<RUN_ID>m<n>`, which the runner's cleanup pattern matches. */
const NAME_PREFIX = `load${RUN_ID}m`;
/** Users m0-m3 run the REST scenario, m4-m7 the live one and m8 the rate-limit burst. */
const GROUP_SIZE = 4;
const USER_COUNT = 2 * GROUP_SIZE + 1;
/** Messages sent per live iteration, read back in pages of HISTORY_PAGE. */
const MESSAGES = 5;
const HISTORY_PAGE = 2;
const FRAME_TIMEOUT_MS = 2000;
/** How long a socket keeps listening for a frame that must NOT arrive. */
const QUIET_MS = 300;
/** Requests fired at once by one user: past its bucket (capacity 60, refill 10/s). */
const BURST = 90;
const JWT_SEGMENT = /^[\w-]+$/u;

type Frame = Readonly<Record<string, unknown>> & { readonly type: string };

type Scenarios = Readonly<Record<string, Scenario>>;

type SetupData = { readonly users: readonly User[] };

type User = {
  readonly id: number;
  readonly name: string;
  readonly publicKey: string;
  readonly token: string;
};

// Budget against a real server with default limits: every request spends one token of the IP
// bucket (120, refill 20/s) and an authenticated one also one of its user bucket (60, refill 10/s).
// `smoke` stays below both; `stress` adds a burst that must be answered with 429.
const PROFILES: Readonly<Record<string, Scenarios>> = {
  load: {
    live: {
      duration: '2m',
      exec: 'live',
      executor: 'constant-arrival-rate',
      maxVUs: 10,
      preAllocatedVUs: 2,
      rate: 1,
      timeUnit: '2s',
    },
    rest: {
      duration: '2m',
      exec: 'rest',
      executor: 'constant-arrival-rate',
      maxVUs: 10,
      preAllocatedVUs: 2,
      rate: 1,
      timeUnit: '1s',
    },
  },
  smoke: {
    live: { exec: 'live', executor: 'shared-iterations', iterations: 3, vus: 1 },
    rest: { exec: 'rest', executor: 'shared-iterations', iterations: 3, vus: 1 },
  },
  // Concurrent sessions in shared rooms, plus one user bursting past its bucket. Against a real
  // server from one IP the IP bucket also runs out: raise RATE_LIMIT_IP_* for this profile.
  stress: {
    live: { exec: 'live', executor: 'shared-iterations', iterations: 12, vus: 4 },
    rate_limit: { exec: 'rateLimit', executor: 'shared-iterations', iterations: 1, vus: 1 },
    rest: { exec: 'rest', executor: 'shared-iterations', iterations: 12, vus: 4 },
  },
};

const scenarios = PROFILES[PROFILE];
if (!scenarios) {
  throw new Error(`Unknown PROFILE "${PROFILE}". Use one of: ${Object.keys(PROFILES).join(', ')}`);
}

/** 429 answers of the stress burst; at least one is required. */
const rateLimited = new Counter('rate_limited');

export const options: Options = {
  scenarios,
  thresholds: {
    checks: ['rate>0.99'],
    // Each request declares its own expected statuses, so a 500 on an upload is a failure.
    'http_req_duration{scenario:live}': ['p(95)<500'],
    'http_req_duration{scenario:rest}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    ...('rate_limit' in scenarios && { rate_limited: ['count>0'] }),
  },
};

function bodyOf(response: RefinedResponse<ResponseType>): unknown {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function isJsonResponse(response: RefinedResponse<ResponseType>): boolean {
  const contentType = response.headers['Content-Type'] ?? '';
  return contentType.toLowerCase().startsWith('application/json');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsOf(value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return Array.isArray(value) ? value.filter((entry) => isRecord(entry)) : [];
}

/** The shared error format, with the exact status text, the request's path and an ISO timestamp. */
function hasErrorShape(
  response: RefinedResponse<ResponseType>,
  statusCode: number,
  statusText: string,
  path: string,
): boolean {
  const body = bodyOf(response);
  if (!isJsonResponse(response) || !isRecord(body)) {
    return false;
  }
  const { correlationId, message, timestamp } = body;
  return (
    response.status === statusCode &&
    body.statusCode === statusCode &&
    body.error === statusText &&
    body.path === path &&
    typeof correlationId === 'string' &&
    correlationId.length > 0 &&
    typeof message === 'string' &&
    message.length > 0 &&
    typeof timestamp === 'string' &&
    new Date(timestamp).toISOString() === timestamp
  );
}

function randomBase64(bytes: number): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(bytes)).buffer, 'std');
}

/**
 * One request; `expected` scopes which statuses count as success to it (k6 `responseCallback`), and
 * `name` is the route pattern, so room ids do not explode the URL tags.
 */
function api(
  method: string,
  path: string,
  init: {
    readonly body?: unknown;
    readonly expected: readonly number[];
    readonly name?: string;
    readonly token?: string;
  },
): RefinedResponse<ResponseType> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (init.token !== undefined) {
    headers.authorization = `Bearer ${init.token}`;
  }
  return request(
    method,
    `${BASE_URL}${path}`,
    init.body === undefined ? null : JSON.stringify(init.body),
    {
      headers,
      responseCallback: expectedStatuses(...init.expected),
      tags: { name: init.name ?? path },
    },
  );
}

/** Idempotent: a user left by an aborted run (409) is reused if its known password still works. */
export function setup(): SetupData {
  return {
    users: Array.from({ length: USER_COUNT }, (_, index) => signUp(`${NAME_PREFIX}${index}`)),
  };
}

function signUp(name: string): User {
  const created = api('POST', '/api/auth/sign-up', {
    body: { name, password: PASSWORD },
    expected: [201, 409],
  });
  const session =
    created.status === 409
      ? api('POST', '/api/auth/sign-in', { body: { name, password: PASSWORD }, expected: [200] })
      : created;
  const body = bodyOf(session);
  if (
    !isRecord(body) ||
    !isRecord(body.user) ||
    typeof body.user.id !== 'number' ||
    typeof body.token !== 'string'
  ) {
    throw new Error(`setup: could not sign in ${name} (${session.status}) at ${BASE_URL}`);
  }
  const publicKey = randomBase64(32);
  const published = api('PUT', '/api/keys/identity', {
    body: { publicKey },
    expected: [200],
    token: body.token,
  });
  const key = bodyOf(published);
  if (!isRecord(key) || key.publicKey !== publicKey || key.userId !== body.user.id) {
    throw new Error(`setup: identity key of ${name} was not published (${published.status})`);
  }
  return { id: body.user.id, name, publicKey, token: body.token };
}

/** The group's users rotated by iteration, so no single user bucket carries a whole scenario. */
type Room = { readonly id: string; readonly keyEpoch: number; readonly memberIds: number[] };

function addMember(owner: User, roomId: string, user: User): null | Room {
  const response = api('POST', `/api/rooms/${roomId}/members`, {
    body: { userId: user.id },
    expected: [201],
    name: '/api/rooms/:roomId/members',
    token: owner.token,
  });
  return response.status === 201 ? roomOf(bodyOf(response)) : null;
}

function createRoom(owner: User, other: User): null | Room {
  const response = api('POST', '/api/rooms', {
    body: { memberIds: [other.id], name: `load room ${scenario.iterationInTest}` },
    expected: [201],
    token: owner.token,
  });
  const room = roomOf(bodyOf(response));
  check(response, {
    'room is created with both members': (r) =>
      r.status === 201 && sameMembers(room, [owner.id, other.id]),
  });
  return room;
}

function rolesOf(users: readonly User[], group: number): User[] {
  const members = users.slice(group * GROUP_SIZE, (group + 1) * GROUP_SIZE);
  const shift = scenario.iterationInTest % members.length;
  return [...members.slice(shift), ...members.slice(0, shift)];
}

function roomOf(value: unknown): null | Room {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.keyEpoch !== 'number' ||
    !Array.isArray(value.memberIds)
  ) {
    return null;
  }
  return {
    id: value.id,
    keyEpoch: value.keyEpoch,
    memberIds: value.memberIds.filter((id) => typeof id === 'number'),
  };
}

function sameMembers(room: null | Room, ids: readonly number[]): boolean {
  return room !== null && sortedIds(room.memberIds) === sortedIds(ids);
}

function sortedIds(list: readonly number[]): string {
  return JSON.stringify(list.toSorted((left, right) => left - right));
}

/** REST surface: rooms, lookup, keys, membership rotation, sender keys, receipts and refresh. */
type Client = {
  readonly close: () => void;
  /** Every frame received matching `match`, consumed or not. */
  readonly count: (match: (frame: Frame) => boolean) => number;
  /** Resolves with (and consumes) the first matching frame, or null after the timeout. */
  readonly next: (match: (frame: Frame) => boolean) => Promise<Frame | null>;
  readonly send: (frame: Readonly<Record<string, unknown>>) => void;
};

export function rest(data: SetupData): void {
  const [owner, peer, guest, outsider] = rolesOf(data.users, 0);
  if (!owner || !peer || !guest || !outsider) {
    throw new Error('rest: the REST group needs four users');
  }
  const room = createRoom(owner, peer);
  if (!room) {
    return;
  }
  const listed = api('GET', '/api/rooms', { expected: [200], token: owner.token });
  const lookup = api('GET', `/api/users/${peer.name}`, {
    expected: [200],
    name: '/api/users/:name',
    token: owner.token,
  });
  const keys = api('GET', `/api/rooms/${room.id}/keys`, {
    expected: [200],
    name: '/api/rooms/:roomId/keys',
    token: owner.token,
  });
  check(listed, {
    'rooms list includes the new room': (r) =>
      recordsOf(bodyOf(r)).some((entry) => entry.id === room.id),
  });
  check(lookup, {
    'user lookup returns {id, name}': (r) => {
      const body = bodyOf(r);
      return isRecord(body) && body.id === peer.id && body.name === peer.name;
    },
  });
  check(keys, {
    'room keys list every member': (r) => {
      const found = recordsOf(bodyOf(r));
      return (
        found.length === 2 &&
        [owner, peer].every((member) =>
          found.some((key) => key.userId === member.id && key.publicKey === member.publicKey),
        )
      );
    },
  });

  const joined = addMember(owner, room.id, guest);
  const left = api('DELETE', `/api/rooms/${room.id}/members/me`, {
    expected: [200],
    name: '/api/rooms/:roomId/members/me',
    token: guest.token,
  });
  const afterLeave = roomOf(bodyOf(left));
  check(joined, {
    'adding a member rotates the epoch': (r) =>
      r?.keyEpoch === room.keyEpoch + 1 && sameMembers(r, [owner.id, peer.id, guest.id]),
  });
  check(left, {
    'leaving rotates the epoch': (r) =>
      r.status === 200 &&
      afterLeave?.keyEpoch === room.keyEpoch + 2 &&
      sameMembers(afterLeave, [owner.id, peer.id]),
  });
  senderKeys(owner, peer, room.id, room.keyEpoch + 2);

  const history = api('GET', `/api/rooms/${room.id}/messages`, {
    expected: [403],
    name: '/api/rooms/:roomId/messages',
    token: outsider.token,
  });
  check(history, {
    'non-member history is 403': (r) =>
      hasErrorShape(r, 403, 'Forbidden', `/api/rooms/${room.id}/messages`),
  });
  const memberReceipts = api('GET', `/api/rooms/${room.id}/receipts`, {
    expected: [200],
    name: '/api/rooms/:roomId/receipts',
    token: owner.token,
  });
  check(memberReceipts, {
    'receipts list every member': (r) => {
      const ids = recordsOf(bodyOf(r)).map((entry) => entry.userId);
      // Ordered by user id, as the contract says.
      return JSON.stringify(ids) === sortedIds([owner.id, peer.id]);
    },
  });
  const refreshed = api('POST', '/api/auth/refresh', { expected: [200], token: owner.token });
  check(refreshed, {
    'refresh returns {user, token}': (r) => {
      const body = bodyOf(r);
      return (
        isRecord(body) &&
        isRecord(body.user) &&
        body.user.id === owner.id &&
        typeof body.token === 'string' &&
        body.token.split('.').length === 3 &&
        body.token.split('.').every((segment) => JWT_SEGMENT.test(segment))
      );
    },
  });
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function frameOf(data: unknown): Frame | null {
  try {
    const parsed: unknown = typeof data === 'string' ? JSON.parse(data) : null;
    return isFrame(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isFrame(value: unknown): value is Frame {
  return isRecord(value) && typeof value.type === 'string';
}

function senderKeys(sender: User, recipient: User, roomId: string, keyEpoch: number): void {
  const path = `/api/rooms/${roomId}/sender-keys`;
  const stored = api('POST', path, {
    body: {
      envelopes: [
        {
          authTag: randomBase64(16),
          ciphertext: randomBase64(48),
          ephemeralPublicKey: randomBase64(32),
          iv: randomBase64(12),
          recipientId: recipient.id,
        },
      ],
      keyEpoch,
    },
    expected: [201],
    name: '/api/rooms/:roomId/sender-keys',
    token: sender.token,
  });
  check(stored, {
    'sender-keys upload is 201': (r) => {
      const body = bodyOf(r);
      return r.status === 201 && isRecord(body) && body.stored === 1 && body.keyEpoch === keyEpoch;
    },
  });
  const fetched = api('GET', path, {
    expected: [200],
    name: '/api/rooms/:roomId/sender-keys',
    token: recipient.token,
  });
  check(fetched, {
    'sender keys reach the recipient': (r) => {
      const [envelope, ...others] = recordsOf(bodyOf(r));
      return (
        others.length === 0 &&
        envelope?.senderId === sender.id &&
        envelope.recipientId === recipient.id &&
        envelope.keyEpoch === keyEpoch
      );
    },
  });
}

/** Opens `/ws` with the JWT as a subprotocol, as the browser does; null when it fails to open. */
async function connect(user: User): Promise<Client | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, null, {
      headers: { 'Sec-WebSocket-Protocol': `${SOCKET_PROTOCOL}, bearer.${user.token}` },
      tags: { name: '/ws' },
    });
    const seen: Frame[] = [];
    const pending: Frame[] = [];
    const client: Client = {
      close: () => {
        ws.close();
      },
      count: (match) => seen.filter((frame) => match(frame)).length,
      next: async (match) => {
        const deadline = Date.now() + FRAME_TIMEOUT_MS;
        for (;;) {
          const index = pending.findIndex((frame) => match(frame));
          if (index !== -1) {
            return pending.splice(index, 1)[0] ?? null;
          }
          if (Date.now() >= deadline) {
            return null;
          }
          // eslint-disable-next-line no-await-in-loop -- waits for the next frame
          await delay(20);
        }
      },
      send: (frame) => {
        ws.send(JSON.stringify(frame));
      },
    };
    ws.addEventListener('message', (event) => {
      const frame = 'data' in event ? frameOf(event.data) : null;
      if (frame) {
        seen.push(frame);
        pending.push(frame);
      }
    });
    ws.addEventListener('open', () => {
      resolve(client);
    });
    ws.addEventListener('error', () => {
      resolve(null);
    });
  });
}

function isNewMessage(key: string): (frame: Frame) => boolean {
  return (frame) => frame.type === 'message.new' && messageOf(frame)?.idempotencyKey === key;
}

function messageOf(frame: Frame | null): null | Readonly<Record<string, unknown>> {
  return frame && isRecord(frame.message) ? frame.message : null;
}

function sendFrame(
  roomId: string,
  keyEpoch: number,
  idempotencyKey: string,
  chainIndex: number,
): Readonly<Record<string, unknown>> {
  return {
    authTag: randomBase64(16),
    chainIndex,
    ciphertext: randomBase64(64),
    idempotencyKey,
    iv: randomBase64(12),
    keyEpoch,
    roomId,
    type: 'message.send',
  };
}

/** Sends MESSAGES messages; returns the stored ids, oldest first. */
async function fanOut(
  sender: Client,
  receiver: Client,
  room: Room,
  senderId: number,
): Promise<{ readonly ids: string[]; readonly keys: string[] }> {
  const keys: string[] = [];
  const ids: string[] = [];
  for (let index = 0; index < MESSAGES; index += 1) {
    const key = crypto.randomUUID();
    keys.push(key);
    sender.send(sendFrame(room.id, room.keyEpoch, key, index));
    // eslint-disable-next-line no-await-in-loop -- one message at a time, like the client's outbox
    const ack = await sender.next(
      (frame) => frame.type === 'message.ack' && frame.idempotencyKey === key,
    );
    // eslint-disable-next-line no-await-in-loop -- the fan-out of this message
    const delivered = await receiver.next(isNewMessage(key));
    const stored = messageOf(ack);
    check(ack, {
      'send is acked with the stored message': (frame) =>
        frame?.duplicate === false &&
        typeof stored?.id === 'string' &&
        stored.idempotencyKey === key &&
        stored.roomId === room.id &&
        stored.senderId === senderId &&
        stored.keyEpoch === room.keyEpoch,
    });
    check(delivered, {
      'message.new reaches the other member': (frame) =>
        frame !== null && messageOf(frame)?.id === stored?.id,
    });
    if (typeof stored?.id === 'string') {
      ids.push(stored.id);
    }
  }
  return { ids, keys };
}

/** Pages the history newest first through `nextBefore`; null when a page is not a HistoryPage. */
function checkHistory(reader: User, roomId: string, sentIds: readonly string[]): void {
  const pages = readHistory(reader, roomId);
  const all = pages?.flat() ?? [];
  check(pages, {
    'history is newest first': (list) =>
      list !== null && all.every((id, index) => index === 0 || id < (all[index - 1] ?? '')),
    'history pages are complete': () =>
      JSON.stringify(all.toSorted()) === JSON.stringify(sentIds.toSorted()),
    'history pages are disjoint': () => new Set(all).size === all.length,
    'history pages hold at most the limit': (list) =>
      list?.every((page) => page.length <= HISTORY_PAGE) ?? false,
  });
}

function readHistory(reader: User, roomId: string): null | string[][] {
  const pages: string[][] = [];
  let before: null | string = null;
  for (let page = 0; page < 2 * MESSAGES; page += 1) {
    const query = `?limit=${HISTORY_PAGE}${before === null ? '' : `&before=${before}`}`;
    const response = api('GET', `/api/rooms/${roomId}/messages${query}`, {
      expected: [200],
      name: '/api/rooms/:roomId/messages',
      token: reader.token,
    });
    const body = bodyOf(response);
    if (!isRecord(body) || !Array.isArray(body.messages)) {
      return null;
    }
    pages.push(recordsOf(body.messages).map((message) => String(message.id)));
    if (typeof body.nextBefore !== 'string') {
      return pages;
    }
    before = body.nextBefore;
  }
  return pages;
}

/** Live surface: fan-out, an idempotent retry, receipts, epoch rotation and paged history. */
export async function live(data: SetupData): Promise<void> {
  const [owner, peer, guest] = rolesOf(data.users, 1);
  if (!owner || !peer || !guest) {
    throw new Error('live: the live group needs three users');
  }
  const room = createRoom(owner, peer);
  if (!room) {
    return;
  }
  const sender = await connect(owner);
  const receiver = await connect(peer);
  try {
    check(null, { 'ws upgrade opens both sockets': () => sender !== null && receiver !== null });
    if (!sender || !receiver) {
      return;
    }
    const ready = [await sender.next(isReady), await receiver.next(isReady)];
    check(ready, {
      'ready lists the room': (frames) =>
        frames.every((frame) => Array.isArray(frame?.roomIds) && frame.roomIds.includes(room.id)),
    });

    const { ids, keys } = await fanOut(sender, receiver, room, owner.id);
    await retry(sender, receiver, room, keys[0] ?? '', ids[0]);
    await readReceipts(sender, receiver, owner, peer, room.id, ids.at(-1));
    await rotation(sender, receiver, owner, guest, room);
    checkHistory(owner, room.id, ids);
  } finally {
    sender?.close();
    receiver?.close();
  }
}

function isReady(frame: Frame): boolean {
  return frame.type === 'ready';
}

async function readReceipts(
  sender: Client,
  receiver: Client,
  owner: User,
  peer: User,
  roomId: string,
  lastId: string | undefined,
): Promise<void> {
  receiver.send({ kind: 'read', messageId: lastId, roomId, type: 'receipt' });
  const frame = await sender.next(
    (candidate) =>
      candidate.type === 'receipt' && candidate.userId === peer.id && candidate.roomId === roomId,
  );
  check(frame, {
    'read receipt reaches the sender': (receipt) =>
      receipt !== null &&
      typeof lastId === 'string' &&
      receipt.read === lastId &&
      receipt.delivered === lastId,
  });
  const listed = api('GET', `/api/rooms/${roomId}/receipts`, {
    expected: [200],
    name: '/api/rooms/:roomId/receipts',
    token: owner.token,
  });
  check(listed, {
    'receipts advance to the read message': (r) =>
      recordsOf(bodyOf(r)).some(
        (entry) => entry.userId === peer.id && entry.read === lastId && entry.delivered === lastId,
      ),
  });
}

async function retry(
  sender: Client,
  receiver: Client,
  room: Room,
  key: string,
  originalId: string | undefined,
): Promise<void> {
  sender.send(sendFrame(room.id, room.keyEpoch, key, 0));
  const ack = await sender.next(
    (frame) => frame.type === 'message.ack' && frame.idempotencyKey === key,
  );
  await delay(QUIET_MS);
  check(ack, {
    'retry is acked as a duplicate of the original': (frame) =>
      frame?.duplicate === true && messageOf(frame)?.id === originalId,
  });
  check(receiver, {
    'retry is not fanned out again': (client) => client.count(isNewMessage(key)) === 1,
  });
}

async function rotation(
  sender: Client,
  receiver: Client,
  owner: User,
  guest: User,
  room: Room,
): Promise<void> {
  const rotated = addMember(owner, room.id, guest);
  const announced = await sender.next(
    (frame) => frame.type === 'room.rotated' && frame.roomId === room.id,
  );
  check(announced, {
    'a join rotates the epoch for live sockets': (frame) =>
      rotated?.keyEpoch === room.keyEpoch + 1 && frame?.keyEpoch === rotated.keyEpoch,
  });
  const staleKey = crypto.randomUUID();
  sender.send(sendFrame(room.id, room.keyEpoch, staleKey, MESSAGES));
  const refused = await sender.next((frame) => frame.type === 'error' && frame.ref === staleKey);
  await delay(QUIET_MS);
  check(refused, {
    'a stale-epoch send is refused with conflict': (frame) =>
      frame?.code === 'conflict' && receiver.count(isNewMessage(staleKey)) === 0,
  });
}

/** Stress only: one user fires BURST requests at once and must be answered with 429s. */
export function rateLimit(data: SetupData): void {
  const user = data.users[2 * GROUP_SIZE];
  if (!user) {
    throw new Error('rateLimit: the rate-limit user is missing');
  }
  // A sample of 0 makes `count>0` fail, instead of skipping a metric that never got a sample.
  rateLimited.add(0);
  const responses = batch(
    Array.from({ length: BURST }, () => ({
      method: 'GET',
      params: {
        headers: { authorization: `Bearer ${user.token}` },
        responseCallback: expectedStatuses(200, 429),
        tags: { name: '/api/rooms' },
      },
      url: `${BASE_URL}/api/rooms`,
    })),
  );
  const limited = responses.filter((response) => response.status === 429);
  rateLimited.add(limited.length);
  check(responses, {
    'a burst is answered only with 200 or 429': (list) =>
      list.every((response) => response.status === 200 || response.status === 429),
    'a burst past the user bucket gets 429': () => limited.length > 0,
  });
  for (const response of limited) {
    check(response, {
      '429 carries an integer Retry-After of at least 1': (r) =>
        /^[1-9][0-9]*$/u.test(r.headers['Retry-After'] ?? ''),
      '429 has the shared error shape': (r) =>
        hasErrorShape(r, 429, 'Too Many Requests', '/api/rooms'),
    });
  }
}
