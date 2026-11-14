import { RedisClient } from 'bun';
import { afterAll, describe, expect, test } from 'bun:test';

import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import {
  REVOKED_SESSION_KEY_PREFIX,
  ValkeySessionRevocations,
} from '../../src/backend/user/infrastructure/user.session-revocations.valkey.ts';

const client = new RedisClient(loadConfig().cacheUrl);
const runId = crypto.randomUUID();

afterAll(async () => {
  await client.del(`${REVOKED_SESSION_KEY_PREFIX}${runId}-a`, `${REVOKED_SESSION_KEY_PREFIX}${runId}-b`);
  client.close();
});

describe('ValkeySessionRevocations', () => {
  test('a revoked session is reported revoked for one token lifetime; others are not', async () => {
    const revocations = new ValkeySessionRevocations(client, 3600);

    expect(await revocations.isRevoked(`${runId}-a`)).toBe(false);
    await revocations.revoke(`${runId}-a`);

    expect(await revocations.isRevoked(`${runId}-a`)).toBe(true);
    expect(await revocations.isRevoked(`${runId}-b`)).toBe(false);
    const ttl = await client.ttl(`${REVOKED_SESSION_KEY_PREFIX}${runId}-a`);
    expect(ttl).toBeGreaterThan(3590);
    expect(ttl).toBeLessThanOrEqual(3600);
  });
});
