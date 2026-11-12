import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "../../src/backend/shared/http/app.server.ts";

const server = createServer({ port: 0 });

afterAll(async () => {
  await server.stop(true);
});

describe("application over HTTP", () => {
  test("GET / serves the frontend", async () => {
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>chat-rsa</title>");
  });

  test("unknown routes return 404 JSON", async () => {
    const response = await fetch(new URL("/nope", server.url));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not Found" });
  });
});
