import { describe, expect, test } from 'bun:test';

import { openIndexedDbOutbox } from './connection/messaging.outbox.indexed-db.ts';
import { IndexedDbKeyStore } from './crypto/messaging.crypto.key-store.ts';
import { IndexedDbLocalMessageStore } from './search/messaging.search.ts';

/** Records which databases are opened, then refuses to open them (Bun has no IndexedDB). */
class RecordingFactory implements IDBFactory {
  readonly opened: string[] = [];

  cmp(): number {
    throw new Error('not used');
  }

  async databases(): Promise<IDBDatabaseInfo[]> {
    throw new Error('not used');
  }

  deleteDatabase(): IDBOpenDBRequest {
    throw new Error('not used');
  }

  open(name: string): IDBOpenDBRequest {
    this.opened.push(name);
    throw new Error('not opened');
  }
}

describe('browser stores are scoped per user', () => {
  test('two users on one browser open different key, message and outbox databases', async () => {
    const factory = new RecordingFactory();
    const opening = (userId: number): Array<Promise<unknown>> => [
      new IndexedDbKeyStore(userId, factory).getIdentity(),
      new IndexedDbLocalMessageStore(userId, factory).listByRoom('room'),
      openIndexedDbOutbox(userId, factory),
    ];

    const results = await Promise.allSettled([...opening(1), ...opening(2)]);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(factory.opened).toEqual([
      'chat-rsa.keys.1',
      'chat-rsa.messages.1',
      'chat-rsa.outbox.1',
      'chat-rsa.keys.2',
      'chat-rsa.messages.2',
      'chat-rsa.outbox.2',
    ]);
  });
});
