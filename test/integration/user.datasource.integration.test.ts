import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../../src/backend/shared/database/postgres.config.ts';
import { ConflictError } from '../../src/backend/shared/domain/app.error.ts';
import { PasswordHash, UserName } from '../../src/backend/user/domain/user.value-objects.ts';
import { PostgresUserDatasource } from '../../src/backend/user/infrastructure/user.datasource.postgresql.ts';
import { applyUserSchema } from '../../src/backend/user/infrastructure/user.schema.ts';

const sql = createPostgresClient({ max: 2, url: loadConfig().databaseUrl });
const datasource = new PostgresUserDatasource(sql);
const name = UserName.restore(`it${crypto.randomUUID().replaceAll('-', '')}`);

beforeAll(async () => {
  await applyUserSchema(sql);
  // Applying the model twice must be harmless: the app does it on every start.
  await applyUserSchema(sql);
});

afterAll(async () => {
  await sql`DELETE FROM users WHERE name = ${name.value}`;
  await sql.close();
});

describe('PostgresUserDatasource', () => {
  test('creates a user and finds it by name', async () => {
    const created = await datasource.create({ name, passwordHash: PasswordHash.restore('hash') });
    const found = await datasource.findByName(name);

    expect(Number.isInteger(created.id)).toBe(true);
    expect(found?.id).toBe(created.id);
    expect(found?.name.value).toBe(name.value);
    expect(found?.passwordHash).toBe(PasswordHash.restore('hash'));
  });

  test('throws ConflictError on a duplicate name', async () => {
    const duplicate = datasource.create({ name, passwordHash: PasswordHash.restore('other') });

    const error: unknown = await duplicate.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictError);
  });

  test('returns null for an unknown name', async () => {
    expect(await datasource.findByName(UserName.restore('nobody0000000000'))).toBeNull();
  });
});
