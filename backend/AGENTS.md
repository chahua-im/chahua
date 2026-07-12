# Repository Guidelines

## Project Structure & Module Organization

This repository contains three apps plus shared docs and API collections. `backend/` is the Rust API server; core modules live in `src/handlers`, `src/services`, `src/utils`, `src/schema`, `src/dto` (API data transfer objects), `src/models.rs` (Diesel models), and `src/metrics.rs` (Prometheus metrics), with Diesel migrations in `migrations/`. Routing and app wiring live in `src/main.rs`.

Real-time messaging uses WebSockets: ticket-based WS auth, handlers in `src/handlers/ws/`, payloads in `src/dto/ws.rs`, connection registry in `src/services/ws_registry.rs`. Background work (e.g. push notifications via web-push/APNs) lives in `src/services/background.rs` and `src/services/push/`. Message full-text search is backed by Meilisearch (`src/services/message_search/`); media is stored in S3.

## Auth

Auth uses JWTs (`src/utils/auth.rs`), with authorization policy in `src/services/authz.rs`. User identity is currently sourced from Discuz tables (`src/schema/discuz*.rs`, `src/services/user.rs`). A design plan for extracting a proper auth/user-provider boundary lives in `docs/auth-provider/` at the repo root — read it before making auth-related changes.

## Design background

- The application is designed to handle 20K users, and ~2k messages a day (combined across all users).
- Expect around 5K users in a large chat group.

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

- `cargo run` starts the API on port 3000 (binds `0.0.0.0:3000`, overridable via `APP_ADDR`). A separate Prometheus metrics server binds port 3001 (`METRICS_ADDR`).
- `cargo build` verifies the Rust backend compiles.
- `cargo test` runs the test suite (inline `#[test]`/`#[tokio::test]` modules).
- `cargo clippy` checks lint issues before review.
- `diesel migration run` applies local PostgreSQL migrations.

## Coding Style & Naming Conventions

Rust uses edition 2021 and strict lints: `unsafe_code` is forbidden and `unused_must_use` is denied. Use `cargo fmt`, `snake_case` for modules/functions, and `PascalCase` for types.
Keep Axum handlers grouped by feature, and move database logic into services or models.

## Database Related

- Use diesel DSL when ever possible. Raw SQL (`sql_query`) is an accepted fallback in performance-critical hot paths (e.g. `src/services/threads.rs`, unread counting) where the DSL can't express the query efficiently — but justify new raw SQL and keep it in services, not handlers
- Never manually create migration, new migration should always be generated via `diesel migration generate`
- When writing queries make sure to verify that we do not trigger a table scan of too many rows
