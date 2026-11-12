import { expect, test } from "bun:test";
import { loadConfig } from "./env.config.ts";

test("loadConfig falls back to local defaults", () => {
  expect(loadConfig({})).toEqual({
    port: 3000,
    databaseUrl: "postgres://chat:chat@localhost:5433/chat",
    cacheUrl: "redis://localhost:6380",
  });
});

test("loadConfig reads values from the environment", () => {
  const config = loadConfig({
    PORT: "8080",
    DATABASE_URL: "postgres://u:p@db:5432/x",
    VALKEY_URL: "redis://cache:6379",
  });
  expect(config).toEqual({
    port: 8080,
    databaseUrl: "postgres://u:p@db:5432/x",
    cacheUrl: "redis://cache:6379",
  });
});
