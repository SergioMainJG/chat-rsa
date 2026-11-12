#!/usr/bin/env bun
// Manages the local Podman pod. Containers run from upstream images; no Containerfile is used.
import { $ } from "bun";

const POD = "chat-rsa";
const ROOT = new URL("..", import.meta.url).pathname;

const IMAGES = {
  database: "docker.io/library/postgres:18-alpine",
  cache: "docker.io/valkey/valkey:9.2-alpine",
  app: "docker.io/oven/bun:canary",
} as const;

// Host-side ports; container ports stay at their upstream defaults inside the pod.
const HOST_PORTS = {
  app: Bun.env.POD_APP_PORT ?? "3001",
  database: Bun.env.POD_DB_PORT ?? "5433",
  cache: Bun.env.POD_CACHE_PORT ?? "6380",
} as const;

async function podExists(): Promise<boolean> {
  return (await $`podman pod exists ${POD}`.nothrow().quiet()).exitCode === 0;
}

async function startInfra(): Promise<void> {
  if (!(await podExists())) {
    await $`podman pod create --name ${POD} -p ${HOST_PORTS.app}:3000 -p ${HOST_PORTS.database}:5432 -p ${HOST_PORTS.cache}:6379`;
  }
  await $`podman run -d --replace --pod ${POD} --name ${POD}-db \
    -e POSTGRES_USER=chat -e POSTGRES_PASSWORD=chat -e POSTGRES_DB=chat \
    -v ${POD}-pgdata:/var/lib/postgresql \
    ${IMAGES.database}`;
  await $`podman run -d --replace --pod ${POD} --name ${POD}-cache \
    -v ${POD}-valkeydata:/data \
    ${IMAGES.cache}`;
}

async function startApp(): Promise<void> {
  await $`podman run -d --replace --pod ${POD} --name ${POD}-app \
    -v ${ROOT}:/app -w /app \
    -e DATABASE_URL=postgres://chat:chat@localhost:5432/chat \
    -e VALKEY_URL=redis://localhost:6379 \
    ${IMAGES.app} sh -c "bun install --frozen-lockfile && bun run dev"`;
}

const commands: Record<string, () => Promise<unknown>> = {
  infra: startInfra,
  up: async () => {
    await startInfra();
    await startApp();
  },
  down: () => $`podman pod rm -f --ignore ${POD}`,
  status: () => $`podman pod ps --filter name=${POD}`,
  logs: () => $`podman pod logs -f ${POD}`,
};

const command = commands[Bun.argv[2] ?? ""];
if (!command) {
  console.error(`Usage: bun scripts/pod.ts <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}
await command();
