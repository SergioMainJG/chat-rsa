# Sign-out and session persistence

Objective: a sign-out button that ends the session for good (server-side revocation), plus an e2e journey proving a chat survives sign-out and sign-in. Branch: feat/messages (user owns git: no commits). Test runner: `bun test` (unit), `bun run test:e2e`.

## Specs

- S1 (button): "Agrega un boton para logout, que limpie completamente el jwt y el inicio de sesion, expirando totalmente cualquier indicio de volver a iniciar sesion."
  - The chat page has a sign-out button. It closes the socket, calls `POST /api/auth/sign-out`, clears `sessionStorage['chat-rsa.token']` even when the call fails, and replaces the location with `/sign-in` (no back navigation into the chat).
  - Server side, every token of that sign-in session is refused afterwards: REST (401), `POST /api/auth/refresh` (401), `/ws` upgrade (401) and `auth.refresh` frames (close 4001). Open sockets of the session are closed with 4001.
  - Assumption: E2EE keys and the decrypted local store stay on the device (per-user IndexedDB). Wiping them would make S2's "ven su chat como lo dejaron" impossible, since the server only holds ciphertext.
- S2 (e2e): "usuario crea una cuenta, crea un chat con otro usuario que ya ha hecho lo mismo, hablan 20 mensajes, y luego terminan sesion. Luego inician sesion y ven su chat como lo dejaron."

## Tasks

- [x] T1 S1 server: `sid` claim kept across refresh; revocation port (Valkey + in-memory); revocation-aware verifier; `POST /api/auth/sign-out`; gateway closes the session's sockets. Route: inline. Risk: item 2. RED observed (jose, refresh, sign-out, gateway, controller tests), GREEN. No commit (user owns git).
- [x] T2 S1 client: `ChatApi.signOut`, `ChatSession.signOut`, button in chat.html wired in chat.page.ts (+ bfcache `pageshow` guard). Route: inline. RED/GREEN in chat.session.test.ts.
- [x] T3 S2 e2e journey in test/e2e/messaging.clients.e2e.test.ts. Route: inline. Needed T3a and T3b to pass.
- [x] T3a S2 member names: `GET /api/rooms/:roomId/members` (members only, 403 otherwise) and the controller loads unknown names. RED/GREEN in chat.controller.member-names.test.ts, messaging use-case and controller tests.
- [x] T3b S2 receipts racing history: a read receipt that arrives before its message was lost; receipts are now remembered per room. RED/GREEN in chat.controller.member-names.test.ts.
- [x] T4 independent verifier (Risk item 2): S1 PASS, S2 PASS, no blockers. Applied advisories: revocation TTL +60 s margin, sign-out rejection handled in chat.page.ts. Open advisory: an upgrade whose check passes just before sign-out could open after closeSession (not reproduced in 25 runs).

## Log

- L1 (2026-11-13): "Agrega un boton para logout, que limpie completamente el jwt y el inicio de sesion, expirando totalmente cualquier indicio de volver a iniciar sesion. Pero tambien necesito que hagas testing e2e para: usuario crea una cuenta, crea un chat con otro usuario que ya ha hecho lo mismo, hablan 20 mensajes, y luego terminan sesion. Luego inician sesion y ven su chat como lo dejaron."
- L2: JWTs are stateless and `/api/auth/refresh` re-issues from any valid token, so clearing the browser alone would not expire the session; hence server revocation by session id. Revocation entries live for one token lifetime (a token of the session issued before the revocation expires by then; refresh is refused after it).
- L3: The S2 journey exposed two gaps: (1) after a fresh sign-in the client had no way to learn member names (they showed as "User <id>"), so `GET /api/rooms/:roomId/members` was added; (2) `openRoom` loads receipts and history in parallel and receipts were applied only to loaded messages, so own messages could fall back from "read" to "delivered".
- L4: Checks: `bun run verify` 595 pass; `bun run test:e2e` 63 pass (journey 3/3 runs); `bun run test:integration` 95 pass; `bun run test:load:probes` 98 pass.
- L5: Verifier report: no blockers; advisories 2 and 5 applied; scratch /tmp/tmp.h866M5Rzoi removed.
