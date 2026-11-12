import { loadConfig } from "./shared/config/env.config.ts";
import { createServer } from "./shared/http/app.server.ts";

const config = loadConfig();

const server = createServer({
  port: config.port,
  development: Bun.env.NODE_ENV !== "production",
});

console.info(`chat-rsa listening on ${server.url}`);
