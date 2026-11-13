# Repository Guidelines

## Project Structure & Module Organization

See [README.md](README.md) for the backend architecture and source layout. The PWA lives in `../pwa/`; a separate Apple client also uses this backend.

Parse server-wide configuration in `src/config.rs` (`AppConfig::from_env`), not in handlers or `main`. Search, push, and ID settings are resolved there as well and injected into their services. Services take narrow dependencies, never `AppState`; transport adapters extract and pass the required pieces.

## Documentation

- Keep `README.md` a short, current architecture overview: major components, dependencies, boundaries, and links.
- Do not append per-feature implementation notes, endpoint/field catalogs, tuning constants, investigation results, rollout history, or work journals to the README.
- Update documentation only when a lasting contract changes. Put necessary details in the existing focused document, generated API schemas, or a nearby code comment; do not duplicate them or create a document for every change.
- Keep this file focused on contributor rules, not feature implementation history.

## Auth

Auth uses JWTs (`src/utils/auth.rs`), with authorization policy in `src/services/authz.rs`. User identity is currently sourced from Discuz tables (`src/schema/discuz*.rs`, `src/services/user.rs`). A design plan for extracting a proper auth/user-provider boundary lives in `docs/auth-provider/` at the repo root — read it before making auth-related changes.

## Design background

- The application is designed to handle 20K users, and ~2k messages a day (combined across all users).
- Expect around 5K users in a large chat group.

## HTTP Request Efficiency

- Minimize HTTP request amplification: consider how a single user action or server event can trigger follow-up requests across connected clients, conversations, or list items. Avoid unnecessary per-item fetches and repeated refreshes; batch, deduplicate, or coalesce requests where practical.
- When implementation complexity is comparable and the user experience is equivalent, prefer the existing WebSocket connection for real-time updates over HTTP polling or follow-up fetches. Include enough state in WebSocket events to apply updates directly when practical, rather than making every recipient fetch the same state again.

## API Serialization
- All API should use camel case for field naming
- use `#[serde(rename_all="camelCase")]
- Data transfer objects are stored in the `dto` submodule.

## Database & Index

- When making changes related to the database, be extra careful and review all queries using table / index you are changing.
- When designing new table / column / queries, make sure to also consider if it needs a corressponding index.
- Pay extra attention if you are modifying queries related to messages, thread, reactions. These are high volumn tables, and have huge performance impact.
- On these high volume / large table, if after modification we have index no longer in use, be sure to highlight that and ask the user if we can drop those index.
- When introducing a query, think about **Is this the most efficient way to query this?** before proceeding.

## Build, Test, and Development Commands

Run backend work from `backend/`:

- For local development, run `node runspace/dev.mjs dev` from the repository root, or `node runspace/dev.mjs backend` for only the backend. These load shared infrastructure settings and worktree-specific ports, and use bacon to rebuild/restart on changes. See `docs/local-setup.md` at the repository root.
- `cargo build` verifies the Rust backend compiles.
- `cargo test` runs the test suite (inline `#[test]`/`#[tokio::test]` modules).
- `cargo clippy` checks lint issues before review.
- `diesel migration run` applies local PostgreSQL migrations.

## Prometheus metrics

The complete metric contract is in [docs/metrics.md](docs/metrics.md). When adding,
removing, renaming, or changing the labels, units, buckets, or recording semantics
of a metric family, you MUST update that catalog in the same change.

## Coding Style & Naming Conventions

Rust uses edition 2021 and strict lints: `unsafe_code` is forbidden and `unused_must_use` is denied. Use `cargo fmt`, `snake_case` for modules/functions, and `PascalCase` for types.
Keep Axum handlers grouped by feature, and move database logic into services or models.

## Database Related

- Use diesel DSL when ever possible. Raw SQL (`sql_query`) is an accepted fallback in performance-critical hot paths (e.g. `src/services/threads.rs`, unread counting) where the DSL can't express the query efficiently — but justify new raw SQL and keep it in services, not handlers
- Never manually create migration, new migration should always be generated via `diesel migration generate`
- When writing queries make sure to verify that we do not trigger a table scan of too many rows
