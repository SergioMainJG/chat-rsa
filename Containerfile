# Production image of the chat-rsa server (Bun + vanilla TypeScript).
#
#   podman build --platform linux/amd64 -t chat-rsa:latest .
#
# The server runs from source: with NODE_ENV=production it bundles the pages in src/frontend with
# Bun.build at startup, serves public/ at the root and applies sql/index.sql, so those three
# directories ship as they are. Postgres and Valkey are not part of this image.

ARG BUN_VERSION=1.4.4

# --- Production dependencies only (jose, @zxcvbn-ts/*) ----------------------------------------
FROM docker.io/oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# --- Runtime -----------------------------------------------------------------------------------
FROM docker.io/oven/bun:${BUN_VERSION}-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bunfig.toml tsconfig.json ./
COPY --chown=bun:bun sql ./sql
COPY --chown=bun:bun public ./public
COPY --chown=bun:bun src ./src

# The upstream image ships an unprivileged `bun` user; nothing here needs root.
USER bun

EXPOSE 3000

# Exec form: Bun is PID 1 and receives SIGTERM directly, so the graceful shutdown in main.ts
# (drain sockets, stop HTTP, close pools) runs when the platform stops the container.
CMD ["bun", "src/backend/main.ts"]
