# Auth hardening

Objective: fix every finding of the 2026-11-13 auth/authz review and move the JWT into an HttpOnly cookie. Branch: feat/messages (user owns git: no commits). Test runner: `bun test` (`bun run verify`, `bun run test:e2e`, `bun run test:integration`, `bun run test:load:probes`).

## Specs

- S1 (JWT secret, finding 1): `JWT_SECRET` is required and must be at least 32 characters. The hard-coded dev default is removed. Only `NODE_ENV=test` (set by `bun test`) may fall back to a test-only default. Otherwise `loadConfig` throws `JWT_SECRET must be set to at least 32 characters`.
- S2 (client IP behind a proxy, finding 2): new `TRUSTED_PROXY_IPS` (comma-separated, default empty). The rate-limit IP is the socket peer, except when the peer is in `TRUSTED_PROXY_IPS` and the request has a valid IP in `CF-Connecting-IP`, which is then used. `X-Forwarded-For` stays ignored. Applies to every guard (`authenticated`, `public`, `upgrade`).
- S3 (absolute session lifetime, finding 3): tokens carry `sst` (session start, epoch seconds), set at sign-in/sign-up and kept by refresh. `POST /api/auth/refresh` answers 401 once `now - sst > SESSION_MAX_AGE_SECONDS` (default 604800, 7 days). Tokens without `sst` are refused.
- S4 (HttpOnly JWT, user request): "el jwt tiene que ser httponly".
  - Sign-in, sign-up and refresh answer `{ user }` only (no `token` in any body) and set two cookies:
    - `chat_rsa_session=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=<token lifetime>`: the credential.
    - `chat_rsa_session_hint=<exp seconds>; Secure; SameSite=Strict; Path=/; Max-Age=<token lifetime>`: not a credential, readable by JS, used only by the frontend route guard. The server never authenticates with it.
  - Sign-out answers 204 and clears both cookies (`Max-Age=0`); an invalid session still gets both cleared (with its 401).
  - The server takes the token from `Authorization: Bearer` (programmatic clients: tests, k6) or from the `chat_rsa_session` cookie (browsers).
  - CSRF: `APP_ORIGINS` (comma-separated, default `http://localhost:<PORT>,http://127.0.0.1:<PORT>`). Any POST/PUT/PATCH/DELETE with an `Origin` header not in the list answers 403. A cookie-authenticated unsafe request without `Origin` answers 403. A `/ws` upgrade authenticated by the cookie needs an `Origin` in the list (403 otherwise).
  - WebSocket: browsers open `new WebSocket(url, ['chat-rsa.v1'])` and authenticate with the cookie. The `bearer.<jwt>` subprotocol stays accepted for programmatic clients. A successful `POST /api/auth/refresh` pushes `auth.refreshed { expiresAt }` to that session's open sockets. The browser client no longer sends `auth.refresh` frames; the frame stays for bearer clients.
  - Frontend: no token in `sessionStorage` or any JS-readable place. `ChatApi` sends no `Authorization` header (same-origin cookies). The route guard reads `chat_rsa_session_hint`. Sign-out deletes the hint cookie client-side even when the server call fails.
  - k6 scripts and fake servers read the session from the cookie.
- S5 (E2EE key pinning, finding 4): trust on first use. The first identity key seen for each other member is pinned in this user's key database. When the server later returns a different key for a pinned member, the client does not wrap sender keys for it. That room's messages stay pending in the outbox, other rooms keep sending, and the room shows `The security key of <name> changed. Messages to this room are paused until you trust the new key.` with a "Trust new key" action that re-pins the new key and resumes. The user's own key is not pinned (out of scope).
- S6 (sign-out socket race, finding 5a): a socket of a session that `closeSession` already closed is closed with 4001 as soon as it opens (the gateway remembers closed session ids for one token lifetime).
- S7 (per-account sign-in throttle, finding 5b): a token bucket per account name (`signin:<name>`, `RATE_LIMIT_SIGNIN_CAPACITY` default 10, `RATE_LIMIT_SIGNIN_REFILL` default 1/30 per second) is spent before the password hash is checked, for known and unknown names alike. When it is empty, the answer is 429 with `Retry-After`. Tradeoff accepted: someone can slow down sign-in for a known name.
- S8 (CSP, finding 5c): every page (`/`, `/chat`, `/sign-in`, `/sign-up`) carries `<meta http-equiv="Content-Security-Policy">` with `default-src 'self'; script-src 'self'; style-src 'self' 'sha256-<hash of the inline guard style>'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'`. An e2e test checks that the hash matches the served inline style.

## Tasks

- [x] T1 S1-S4, S6-S8 auth unit. Route: delegated writer A (writer trigger: parallel with T2, disjoint surfaces; context backstop). Risk: item 2 (auth), item 3 (auth API contract: body no longer has `token`). RED/GREEN for S1, S3, S4, S6, S8; S2, S7 and the cookie e2e were written together with the code.
- [x] T2 S5 key pinning unit. Route: delegated writer B (parallel with T1). Risk: item 2. RED (16 tests) then GREEN.
- [x] T3 Parent wiring of T2 in `chat.page.ts` and `chat.html` (key warnings list + "Trust new key" button), removed leftover `getToken` in B's test files, `scripts/pod.ts` passes `APP_ORIGINS` for the host port, seam check.
- [ ] T4 Independent verifier (Risk item 2).

## Log

- L1 (2026-11-13): "Necesito que corrijas todo eso, tambien, el jwt tiene que ser httponly" (referring to the auth/authz review: 1 default JWT secret with the dev server exposed; 2 shared rate-limit bucket behind the Cloudflare tunnel; 3 no absolute session lifetime; 4 E2EE does not resist a malicious server; 5 socket race at sign-out, no per-account sign-in throttle, no CSP).
- L2: Bun route handlers cannot return an HTML import, so the page guard stays client-side. A non-credential hint cookie carries the expiry, so the guard works with an HttpOnly token. CSP goes in a `<meta>` for the same reason.
- L3: Seam check (with a 48-character `JWT_SECRET` in the shell, since the local `.env` has a 9-character one that S1 now refuses): `bun run verify` 685 pass; `bun run test:e2e` 83 pass; `bun run test:integration` 95 pass; writer A reported `bun run test:load:probes` 101 pass. Chromium on the dev server: sign-up lands on /chat with the socket open, JS sees only `chat_rsa_session_hint`, `sessionStorage` is empty, sign-out clears both cookies, /chat then redirects to /sign-in. The CSP blocks Bun's dev-only inline beacon script (console error in development only).
- L4: The user must update `.env`: `JWT_SECRET` (>= 32 chars), `APP_ORIGINS` (add the tunnel URL), `TRUSTED_PROXY_IPS=127.0.0.1,::1` for the Cloudflare tunnel.
