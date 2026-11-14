#!/usr/bin/env bun
// Manages the local Podman pod. Containers run from upstream images; no Containerfile is used.
import { $ } from 'bun';

const POD = 'chat-rsa';
const ROOT = new URL('..', import.meta.url).pathname;

const IMAGES = {
  app: 'docker.io/oven/bun:canary',
  cache: 'docker.io/valkey/valkey:9.2-alpine',
  database: 'docker.io/library/postgres:18-alpine',
} as const;

// Host-side ports; container ports stay at their upstream defaults inside the pod.
const HOST_PORTS = {
  app: Bun.env.POD_APP_PORT ?? '3001',
  cache: Bun.env.POD_CACHE_PORT ?? '6380',
  database: Bun.env.POD_DB_PORT ?? '5433',
} as const;

async function podExists(): Promise<boolean> {
  const { exitCode } = await $`podman pod exists ${POD}`.nothrow().quiet();
  return exitCode === 0;
}

/**
 * The browser reaches the app on the host port, not the container's 3000, so that origin must be
 * allowed (CSRF check). `.env` (loaded by Bun here) can override it, e.g. with a tunnel URL.
 */
const APP_ORIGINS =
  Bun.env.APP_ORIGINS ?? `http://localhost:${HOST_PORTS.app},http://127.0.0.1:${HOST_PORTS.app}`;

async function startApp(): Promise<void> {
  await $`podman run -d --replace --pod ${POD} --name ${POD}-app \
    -v ${ROOT}:/app -w /app \
    -e DATABASE_URL=postgres://chat:chat@localhost:5432/chat \
    -e VALKEY_URL=redis://localhost:6379 \
    -e APP_ORIGINS=${APP_ORIGINS} \
    ${IMAGES.app} sh -c "bun install --frozen-lockfile && bun run dev"`;
}

async function startInfra(): Promise<void> {
  if (!(await podExists())) {
    await $`podman pod create --name ${POD} -p ${HOST_PORTS.app}:3000 -p ${HOST_PORTS.database}:5432 -p ${HOST_PORTS.cache}:6379`;
  }
  await $`podman run -d --replace --pod ${POD} --name ${POD}-db \
    -e POSTGRES_USER=chat -e POSTGRES_PASSWORD=chat -e POSTGRES_DB=chat \
    -v ${POD}-pgdata:/var/lib/postgresql \
    -v ${ROOT}sql:/docker-entrypoint-initdb.d:ro \
    ${IMAGES.database}`;
  await $`podman run -d --replace --pod ${POD} --name ${POD}-cache \
    -v ${POD}-valkeydata:/data \
    ${IMAGES.cache}`;
}

const commands: Record<string, () => Promise<unknown>> = {
  down: async () => $`podman pod rm -f --ignore ${POD}`,
  infra: startInfra,
  logs: async () => $`podman pod logs -f ${POD}`,
  status: async () => $`podman pod ps --filter name=${POD}`,
  up: async () => {
    await startInfra();
    await startApp();
  },
};

const command = commands[Bun.argv[2] ?? ''];
if (!command) {
  console.error(`Usage: bun scripts/pod.ts <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}
await command();
