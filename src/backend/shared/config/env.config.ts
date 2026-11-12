export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly cacheUrl: string;
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? "postgres://chat:chat@localhost:5433/chat",
    cacheUrl: env.VALKEY_URL ?? "redis://localhost:6380",
  };
}
