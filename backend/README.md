# Backend

The backend is a Rust/Axum service backed by PostgreSQL and Diesel. It serves
HTTP APIs, JSON-RPC operations, and real-time updates for the PWA and other clients.

## Application boundaries

| Layer | Responsibility |
| --- | --- |
| `src/main.rs`, `src/config.rs`, `src/state.rs` | Startup, configuration, dependency wiring, and shared state. |
| `src/handlers/`, `src/rpc/` | HTTP and WebSocket transport, request decoding, session management, and response mapping. |
| `src/services/api/` | Shared application operations, authorization, transactions, and post-commit publication. |
| `src/services/` | Domain logic and integrations: messages, users, unread state, presence, media, search, and push. |
| `src/dto/`, `src/models.rs`, `src/schema/` | Wire contracts, database models, and Diesel schema definitions. |

Configuration is resolved once at startup from optional TOML plus environment
overrides; secret values remain outside TOML. See [application configuration](../docs/local-setup.md#application-configuration).

Transport adapters call shared application services rather than duplicating business
logic. Services receive the dependencies they need, not the entire `AppState`.
HTTP database operations and DB-capable authentication run on blocking workers;
request-body streaming stays on the async side.

## Storage and integrations

- **PostgreSQL** owns chat data, membership, preferences, and persisted activity.
  Embedded Diesel migrations run before the server starts serving requests.
- **Discuz** currently supplies user profiles and group information. Authentication
  uses JWT sessions; application authorization is checked for each operation.
- **S3-compatible storage** holds media; **Meilisearch** provides message search.
- Background workers handle push delivery through Web Push/APNs, media processing,
  search indexing, activity persistence, and maintenance.

Mutations commit before publishing their resulting events. Client ownership changes
are synchronous; routine activity bookkeeping is buffered so analytics writes do not
block warmed requests. Its failure and durability boundaries are documented in the
[metrics catalog](docs/metrics.md#client-tracking-and-daily-activity).

## API schemas

The running server publishes HTTP contracts at `/api-docs/openapi.json` and
JSON-RPC contracts at `/api-docs/openrpc.json`. Both can also be exported offline
with `--export-api-schemas <directory>`. These schemas, DTOs, and focused feature
docs own endpoint and payload details; this overview does not duplicate them.

## JSON-RPC sessions

`/ws` supports JSON-RPC and the legacy ticket-based WebSocket protocol. JSON-RPC
sessions authenticate once and retain verified identity, while authorization and
revocation checks remain enforced during the session. HTTP remains available for
uploads, resource delivery, and external/service-token integrations.

## Client WebSocket controls

Clients report application activity and subscribe to scoped presence and
conversation updates. RPC contracts are defined in `src/rpc/`; legacy command and
event types live in `src/dto/ws.rs`. Watch request IDs are optional correlation
values that clients can supply to reject stale snapshots.

## Scoped WebSocket presence

Presence combines a process-local connection registry with buffered and persisted
last-seen activity. Foreground state, connection liveness, and API activity are
separate concepts. Presence and live coordination currently assume a single backend
instance; multiple instances require shared coordination, not just sticky sessions.

## Individual presence privacy

Presence snapshots enforce discoverability, blocking, and reciprocal sharing
policies. Clients receive only the authorized exact or coarse state and must clear
information no longer included in their scope. Product behavior is described in the
[PWA requirements](../pwa/docs/requirements.md#在线状态与最近上线).

## Development

Use the shared [local development setup](../docs/local-setup.md) for infrastructure,
configuration, and launcher commands. Run `cargo build`, `cargo test`, and
`cargo clippy` from `backend/` as appropriate for the change.

### Isolated RPC regression runner

From the repository root, `node runspace/rpc-smoke.mjs` creates an isolated local
database and exercises HTTP, legacy WebSocket, and RPC behavior. `--keep` retains
the runtime for manual checks and prints the frontend proxy command. It requires
local runspace infrastructure and does not send media or push deliveries.

## Further reading

- [Metrics and operational contracts](docs/metrics.md)
- [Authentication and user-provider design](../docs/auth-provider/README.md)
- [Stickers](docs/stickers.md)
- [Speaking restrictions](docs/speaking-restrictions.md)
