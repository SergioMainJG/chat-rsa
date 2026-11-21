#!/usr/bin/env bash
# Boots the server image against the job's Postgres and Valkey services and checks that it
# answers, then stops it with SIGTERM and expects a clean exit.
#
#   .github/scripts/image-smoke.sh <image reference>
set -euo pipefail

IMAGE="${1:?usage: image-smoke.sh <image reference>}"
PORT="${SMOKE_PORT:-3000}"
BASE="http://localhost:${PORT}"
NAME=chat-rsa-smoke

# The server's own output is the first thing to read when a check fails.
trap 'docker logs "$NAME" || true; docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$NAME" --network host \
  -e PORT="$PORT" \
  -e DATABASE_URL=postgres://chat:chat@localhost:5432/chat \
  -e VALKEY_URL=redis://localhost:6379 \
  -e JWT_SECRET="$(openssl rand -base64 48)" \
  -e APP_ORIGINS="$BASE" \
  "$IMAGE"
curl --silent --fail --retry 30 --retry-delay 1 --retry-all-errors -o /dev/null "$BASE/robots.txt"

# expect <what> <actual> <expected>
expect() {
  echo "$1: $2"
  test "$2" = "$3"
}
status() { curl --silent --output /dev/null --write-out '%{http_code}' "$@"; }

expect "GET /es" "$(status "$BASE/es")" 200
expect "GET /en/chat" "$(status "$BASE/en/chat")" 200
expect "GET / redirects to a locale" "$(status "$BASE/")" 302
expect "pages are precompressed" \
  "$(curl --silent --output /dev/null --write-out '%header{content-encoding}' \
    --header 'accept-encoding: br' "$BASE/es")" br
expect "runs without root" "$(docker exec "$NAME" id -u)" 1000

docker stop --time 10 "$NAME" >/dev/null
expect "exit code after SIGTERM" "$(docker inspect --format '{{.State.ExitCode}}' "$NAME")" 0
