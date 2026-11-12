export type AppConfig = {
  readonly cacheUrl: string;
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly port: number;
};

const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me';

export function loadConfig(env: Record<string, string | undefined> = Bun.env): AppConfig {
  const jwtSecret = env.JWT_SECRET ?? DEV_JWT_SECRET;
  if (env.NODE_ENV === 'production' && jwtSecret === DEV_JWT_SECRET) {
    throw new Error('JWT_SECRET must be set in production');
  }
  return {
    cacheUrl: env.VALKEY_URL ?? 'redis://localhost:6380',
    databaseUrl: env.DATABASE_URL ?? 'postgres://chat:chat@localhost:5433/chat',
    jwtSecret,
    port: Number(env.PORT ?? 3000),
  };
}
