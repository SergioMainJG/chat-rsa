import { SQL } from 'bun';

export type PostgresOptions = {
  readonly max?: number;
  readonly url: string;
};

/** Creates the pooled Postgres client shared by every feature's datasources. */
export function createPostgresClient({ max = 10, url }: PostgresOptions): SQL {
  return new SQL({
    connectionTimeout: 10,
    idleTimeout: 30,
    max,
    url,
  });
}
