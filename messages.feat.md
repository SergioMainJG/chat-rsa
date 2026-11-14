Implement the **Messages** feature end-to-end across backend and frontend, following a strict domain-driven architecture (Controllers -> Application Use Cases -> Domain Entities with Value Objects -> Infrastructure Repositories).

### Architectural & Domain Constraints

1. **Transport & Protocol Separation:**
   - **Bun WebSockets:** Use exclusively for real-time message delivery, typing indicators, presence states, and read receipts.
   - **HTTP REST:** Use exclusively for loading historical messages (paginated by timestamp/hour), message search, and user profile management.
2. **Connection Lifecycle & Resilience (Server & Client):**
   - **Heartbeat:** Server must manage WebSocket ping/pong frames to detect dead wires/zombie connections and free resources.
   - **Graceful Shutdown:** Server must trap `SIGTERM` to drain active connections, persist in-flight messages, and close sockets cleanly.
   - **Client Reconnection:** Frontend must detect network recovery and run an exponential backoff reconnection loop ($2^n$ seconds with jitter and a max cap).
3. **Message Ordering, Idempotency & Delivery States:**
   - **Server-Side Chronology:** Never trust client timestamps. Generate server-side time-ordered UUIDs (**UUIDv7**) and timestamps in PostgreSQL to enforce the canonical chronological history (`sent` -> `delivered` -> `read`).
   - **Idempotency:** Clients must attach a unique idempotency key per message so retries over unstable Wi-Fi never create duplicate records in PostgreSQL.
   - **Application-Level ACKs:** Emit a server-to-client WebSocket ACK frame once persisted in PostgreSQL to transition status to `delivered`. Transition status to `read` only when the recipient client confirms the message element is visible in the viewport (e.g., IntersectionObserver).
4. **Room Capacity & Offline-First Queue:**
   - **Room Bounds:** A chat room requires a minimum of 2 members and a maximum of 100. Active members can send and read messages even if the other 99 members are offline.
   - **Offline Outbox:** If the user sends messages while offline, the frontend must persist them locally (IndexedDB or SQLite) and flush them sequentially in order once the WebSocket connection is re-established.
5. **Authentication, Authorization & Edge Security:**
   - **WS Auth & Token Renewal:** Authenticate during the initial HTTP upgrade handshake via JWT. Support mid-session JWT refresh/revalidation over the active connection without dropping the socket; if renewal fails or is unauthorized, close gracefully with a custom WebSocket close code and error payload.
   - **Room Authorization:** Enforce strict membership checks so a user cannot read from, write to, or subscribe to a room they do not belong to.
   - **Zero-Trust HTTP:** Treat every HTTP request as untrusted—enforce strict schema validation and apply a Token Bucket rate limiter (keyed by user ID and IP) to mitigate spam and DDoS.
6. **End-to-End Encryption (E2EE) & Zero-Knowledge Security:**
   - **Native Cryptographic Primitives:** Use native Web Crypto API / Bun crypto primitives (**X25519** ECDH for key agreement, **HKDF-SHA256** for key derivation, and **AES-256-GCM** with unique nonces/IVs for authenticated encryption) with zero third-party crypto dependencies.
   - **Group Key Distribution (2–100 Members):** Implement a **Sender Keys** scheme so a sender encrypts each message payload once per room using a symmetric chain key distributed encrypted to active room members, rotating keys on member join/leave events to preserve forward secrecy.
   - **Client-Side Key & Search Isolation:** Store private `CryptoKey` objects in IndexedDB marked as `extractable: false`. Because the server only stores opaque `ciphertext`, `iv`, and `authTag` blobs, move full-text message search entirely to the client-side local store (SQLite/IndexedDB) after decryption.

### Database Schema Approval Gate (Mandatory)

- Before writing any SQL migrations, Drizzle schema files, or source code, inspect the existing database setup and propose the exact **PostgreSQL schema** (tables, column types, primary/foreign keys, `UNIQUE` constraints for idempotency on `(sender_id, idempotency_key)`, `CHECK` constraints/triggers for room capacity `2..100`, per-recipient delivery/read receipt tracking, and composite indexes such as `(room_id, id DESC)` for chronological pagination).
- Present the complete DDL/schema proposal to me and **stop for my explicit approval** before creating or modifying any files.

### ODD Workflow Directives

- Classify this as a large feature, create `odd/tasks/messages.md` before writing code, and use `chained-pr` (or `single-pr` if preferred) as the delivery strategy.
- Inspect the existing repository structure first to map backend and frontend boundaries accurately before generating `## Specs` and `## Tasks`.
- Enforce strict test-first (RED -> GREEN -> REFACTOR) for every domain rule, value object invariant, and authorization guard.

IMPORTANT: USE TS VANILLA & Bun implementations, only
