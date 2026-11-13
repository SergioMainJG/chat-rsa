# messages

Objective: E2EE group messaging (rooms of 2..100) over Bun WebSockets plus REST history, with Sender Keys and an offline outbox.
Branch: `feat/messages`. Delivery: `chained-pr` (chain strategy asked at PR creation; commits are work units). Test runner: `bun test` (unit `./src`, integration/e2e `./test`).

## Specs

Quoted verbatim from `messages.feat.md`.

- S1. Transport: "**Bun WebSockets:** Use exclusively for real-time message delivery, typing indicators, presence states, and read receipts." / "**HTTP REST:** Use exclusively for loading historical messages (paginated by timestamp/hour), message search, and user profile management."
- S2. Heartbeat: "Server must manage WebSocket ping/pong frames to detect dead wires/zombie connections and free resources."
- S3. Graceful shutdown: "Server must trap `SIGTERM` to drain active connections, persist in-flight messages, and close sockets cleanly."
- S4. Client reconnection: "Frontend must detect network recovery and run an exponential backoff reconnection loop ($2^n$ seconds with jitter and a max cap)."
- S5. Server-side chronology: "Never trust client timestamps. Generate server-side time-ordered UUIDs (**UUIDv7**) and timestamps in PostgreSQL to enforce the canonical chronological history (`sent` -> `delivered` -> `read`)."
- S6. Idempotency: "Clients must attach a unique idempotency key per message so retries over unstable Wi-Fi never create duplicate records in PostgreSQL."
- S7. ACKs: "Emit a server-to-client WebSocket ACK frame once persisted in PostgreSQL to transition status to `delivered`. Transition status to `read` only when the recipient client confirms the message element is visible in the viewport (e.g., IntersectionObserver)."
- S8. Room bounds: "A chat room requires a minimum of 2 members and a maximum of 100. Active members can send and read messages even if the other 99 members are offline."
- S9. Offline outbox: "If the user sends messages while offline, the frontend must persist them locally (IndexedDB or SQLite) and flush them sequentially in order once the WebSocket connection is re-established."
- S10. WS auth: "Authenticate during the initial HTTP upgrade handshake via JWT. Support mid-session JWT refresh/revalidation over the active connection without dropping the socket; if renewal fails or is unauthorized, close gracefully with a custom WebSocket close code and error payload."
- S11. Room authorization: "Enforce strict membership checks so a user cannot read from, write to, or subscribe to a room they do not belong to."
- S12. Zero-trust HTTP: "Treat every HTTP request as untrusted—enforce strict schema validation and apply a Token Bucket rate limiter (keyed by user ID and IP) to mitigate spam and DDoS."
- S13. Crypto primitives: "Use native Web Crypto API / Bun crypto primitives (**X25519** ECDH for key agreement, **HKDF-SHA256** for key derivation, and **AES-256-GCM** with unique nonces/IVs for authenticated encryption) with zero third-party crypto dependencies."
- S14. Sender Keys: "Implement a **Sender Keys** scheme so a sender encrypts each message payload once per room using a symmetric chain key distributed encrypted to active room members, rotating keys on member join/leave events to preserve forward secrecy."
- S15. Key and search isolation: "Store private `CryptoKey` objects in IndexedDB marked as `extractable: false`. Because the server only stores opaque `ciphertext`, `iv`, and `authTag` blobs, move full-text message search entirely to the client-side local store (SQLite/IndexedDB) after decryption."
- S16. Schema: the DDL approved on 2026-11-12 (L3), appended to `sql/index.sql`.
- S17. Process: "Enforce strict test-first (RED -> GREEN -> REFACTOR) for every domain rule, value object invariant, and authorization guard." / "IMPORTANT: USE TS VANILLA & Bun implementations, only"

Assumptions (not stated by the user):

- A1. One device (one X25519 identity key) per user.
- A2. Single server node: room fan-out uses Bun's built-in pub/sub. Multi-node fan-out through Valkey is out of scope.
- A3. "user profile management" is read as publishing and reading identity public keys. No other profile feature is built.
- A4. The JWT travels in the upgrade request as the `Sec-WebSocket-Protocol` value `bearer.<jwt>` next to `chat-rsa.v1`, because browsers cannot set headers on a WebSocket.
- A5. Any room member can add members. A member can leave; the last 2 cannot (S8). Deleting a room is out of scope.
- A6. History pages are cursor-based on the UUIDv7 id; the "hour" window is a `since`/`until` ISO range converted to UUIDv7 bounds.

## Tasks

| ID  | Specs                         | Route  | Status  | Commit |
| --- | ----------------------------- | ------ | ------- | ------ |
| T1  | S5, S6, S8, S16               | inline | pending |        |
| T2  | S5, S6, S8, S11, S14, S17     | inline | pending |        |
| T3  | S6, S7, S8, S11, S14, S17     | inline | pending |        |
| T4  | S1, S12, S17                  | inline | pending |        |
| T5  | S1, S2, S3, S7, S10, S11, S17 | inline | pending |        |
| T6  | S13, S14, S15, S17            | inline | pending |        |
| T7  | S4, S7, S9, S17               | inline | pending |        |
| T8  | S1, S7, S15                   | inline | pending |        |
| T9  | all                           | inline | pending |        |

- T1: schema in `sql/index.sql` plus integration tests for the capacity, idempotency, and membership invariants.
- T2: messaging domain: value objects (ids, bytes, epoch, chain index, room name), Room and Message entities, ports.
- T3: use cases (create room, add/leave member, send message, history, receipts, identity keys, sender keys) and Postgres adapters with integration tests.
- T4: HTTP: JWT guard, strict schema validation, token-bucket rate limiter (Valkey, keyed by user ID and IP), REST routes.
- T5: WebSocket gateway: upgrade auth, frames, ACKs, receipts, typing, presence, refresh with custom close codes, heartbeat, SIGTERM drain.
- T6: client crypto: X25519/HKDF/AES-GCM, Sender Keys chain, non-extractable key store port.
- T7: client connection: backoff with jitter and cap, online/offline detection, outbox flushed in order, status state machine.
- T8: chat page: rooms, history, IntersectionObserver read receipts, typing, presence, local search.
- T9: e2e over real server + docs (`CLAUDE.md`).

Forecast: about 4500 authored changed lines, which is over the 400-line budget. Slices follow the tasks.

## Log

- L1 (2026-11-12): the user's request: "La infrastructura ya esta levantada, tambien el servidor. Ahora necesito que hagas todo lo especificado para @messages.feat.md". The spec text is quoted in S1-S17.
- L2: The database is PostgreSQL 18.6 with native `uuidv7()`; `uuid_extract_timestamp` is immutable, so `created_at` is generated from the id. There is no migration tool: `sql/index.sql` is idempotent and applied at startup. Drizzle was rejected because CLAUDE.md forbids ORMs.
- L3 (2026-11-12): "Sí, apruebo el schema, adelante". The schema was approved: watermark receipts on `room_members`, a member counter with an immediate max check and a deferred min check, epoch bumps on join/leave, and a sender-is-member trigger. It was probed on a throwaway database: applied twice, every invariant rejected its violation.
