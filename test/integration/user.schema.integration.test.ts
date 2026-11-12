import type { ReservedSQL } from 'bun';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadConfig } from '../../src/backend/shared/config/env.config.ts';
import { createPostgresClient } from '../../src/backend/shared/database/postgres.config.ts';
import { applyUserSchema } from '../../src/backend/user/infrastructure/user.schema.ts';

// BUG-MEDIUM-07: tests always ran against a database where `users` already existed, so an empty
// applyUserSchema survived. Here the model is applied to a brand-new, isolated schema.

const sql = createPostgresClient({ max: 1, url: loadConfig().databaseUrl });
const schema = `schema_${crypto.randomUUID().replaceAll('-', '')}`;
let isolated: ReservedSQL;

beforeAll(async () => {
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  isolated = await sql.reserve();
  await isolated.unsafe(`SET search_path TO "${schema}"`);
});

afterAll(async () => {
  await isolated.release();
  await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await sql.close();
});

type Column = {
  readonly column_name: string;
  readonly data_type: string;
  readonly identity_generation: null | string;
  readonly is_nullable: string;
};

async function columns(): Promise<Column[]> {
  return isolated<Column[]>`
    SELECT column_name, data_type, is_nullable, identity_generation
    FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = 'users'
    ORDER BY ordinal_position
  `;
}

describe('applyUserSchema on an empty schema', () => {
  test('starts from a schema without a users table', async () => {
    expect(await columns()).toEqual([]);
  });

  test('creates the users table described by sql/index.sql', async () => {
    await applyUserSchema(isolated);

    expect(await columns()).toEqual([
      { column_name: 'id', data_type: 'integer', identity_generation: 'ALWAYS', is_nullable: 'NO' },
      { column_name: 'name', data_type: 'text', identity_generation: null, is_nullable: 'NO' },
      { column_name: 'password', data_type: 'text', identity_generation: null, is_nullable: 'NO' },
    ]);

    const constraints = await isolated<Array<{ readonly column_name: string; readonly constraint_type: string }>>`
      SELECT tc.constraint_type, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = ${schema} AND tc.table_name = 'users'
      ORDER BY tc.constraint_type
    `;
    expect([...constraints]).toEqual([
      { column_name: 'id', constraint_type: 'PRIMARY KEY' },
      { column_name: 'name', constraint_type: 'UNIQUE' },
    ]);
  });

  test('is idempotent, as main.ts applies it on every start', async () => {
    await applyUserSchema(isolated);
    await isolated`INSERT INTO users (name, password) VALUES ('kept', 'hash')`;

    await applyUserSchema(isolated);

    const rows = await isolated`SELECT name FROM users`;
    expect(rows).toEqual([{ name: 'kept' }]);
  });
});
