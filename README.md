# wetty-chat

Wetty Chat is a chat application with:

- `backend/`: Rust, Axum, Diesel, PostgreSQL
- `wetty-chat-mobile/`: React, Ionic, Vite PWA
- `wetty-chat-flutter/`: Flutter client

## Local development

**New to the project?** Follow the step-by-step beginner guide:

→ **[docs/local-setup.md](docs/local-setup.md)**

It covers installing Docker / Rust / Node on **macOS or Linux** (and verifying what you already have), running Postgres in Docker, configuring `backend/.env`, seeding the first user + permissions, bootstrapping a local JWT through `/auth/dev-session`, then starting the backend on the host and the frontend with Vite.

### Quick reference (experienced)

Prerequisites: Rust (`cargo` / `rustfmt`), Node.js (`^20.19` or `≥22.12`), Docker. Native build deps: on **macOS** `brew install pkg-config openssl@3 libpq`; on **Linux** `libpq-dev` / `pkg-config` / `libssl-dev`.

```bash
# 1. Postgres only (from repo root)
docker compose up -d postgres

# 2. Backend on the host
cd backend
cp .env.example .env
# Set DATABASE_URL to the compose credentials, JWT_SIGNING_KEY_BASE64,
# VAPID_* keys, S3_BUCKET_NAME, AWS_REGION — see .env.example
cargo run   # applies migrations automatically; API on :3000

# 3. Seed uid 1 + admin policy (once per fresh DB) — see docs/local-setup.md §6

# 4. Frontend
cd wetty-chat-mobile
npm ci && npm run dev
```

Compose Postgres URL:

```bash
DATABASE_URL=postgres://wetty_chat:NIM1gs7unjbQumYD@127.0.0.1:5432/wetty_chat
```

- Migrations run on backend startup.
- In Vite development, the PWA obtains a JWT from `POST /auth/dev-session` for its configured local uid. The request sends `X-Client-Id`; subsequent API requests use `Authorization: Bearer <token>`.
- `POST /auth/dev-session` is enabled automatically by a debug backend build. For a release build used only in local development, set `ENABLE_DEBUG_AUTH=true`.
- Attachments need real/local S3 (`docker compose up -d rustfs init-rustfs` + env from `.env.example`).

## Formatting and hooks

This repo includes a shared Git pre-commit hook at `.githooks/pre-commit`.

It runs:

- `cargo fmt` in `backend/`
- `npm run format` in `wetty-chat-mobile/`

To enable it in a clone:

```bash
git config core.hooksPath .githooks
```

## Useful commands

Backend:

```bash
cd backend
cargo fmt
cargo build
cargo clippy
```

Frontend:

```bash
cd wetty-chat-mobile
npm run format
npm run lint
npm run verify
```
