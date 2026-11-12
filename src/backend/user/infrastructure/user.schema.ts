import type { SQL } from 'bun';

import schema from '../../../../sql/index.sql' with { type: 'text' };

/**
 * Applies the users table model. The pod also runs `sql/` on a fresh volume, so this only matters
 * for databases created before the model existed (existing volumes, CI service containers).
 */
export async function applyUserSchema(sql: SQL): Promise<void> {
  await sql.unsafe(schema);
}
