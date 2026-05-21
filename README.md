# wetty-chat

Wetty Chat is a chat application with:

- `backend/`: Rust, Axum, Diesel, PostgreSQL
- `wetty-chat-mobile/`: React, Ionic, Vite PWA
- `wetty-chat-flutter/`: Flutter client

## Local development

### Prerequisites

- Rust toolchain with `cargo` and `rustfmt`
- Node.js and npm
- PostgreSQL 16+ or Docker
- On Linux, native backend builds typically also need PostgreSQL/OpenSSL dev packages such as `libpq-dev`, `pkg-config`, and `libssl-dev`

### Minimal backend setup

The backend reads its environment from `backend/.env`.

1. Copy the example file:

```bash
cd backend
cp .env.example .env
```

2. Update at least these values in `backend/.env`:

- `DATABASE_URL`
  Use a local PostgreSQL database, for example `postgres://wetty_chat:change_me@127.0.0.1:5432/wetty_chat`
- `AUTH_METHOD=UIDHeader`
  This is the recommended local setup. It allows the dev client to authenticate
  with `X-User-Id`. Leave unset, or set any value other than exact `UIDHeader`,
  to require JWT auth.
- `JWT_SIGNING_KEY_BASE64`
  Generate with `openssl rand -base64 32`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
  Generate with `npx web-push generate-vapid-keys`
- `S3_BUCKET_NAME`
  Required by the backend at startup
- `AWS_REGION`
  Required by the AWS SDK config chain

3. Discuz avatar variables are not needed for normal local development.

Notes:

- Embedded Diesel migrations run automatically on backend startup.
- If you plan to test attachments, also configure valid S3 credentials and optionally `S3_ENDPOINT_URL` for a local or S3-compatible object store.
- For local frontend development, `UIDHeader` auth works because the dev client sends `X-User-Id` automatically.
- For production, omit `AUTH_METHOD` or set it to a non-`UIDHeader` value so user routes require JWT auth.

### PostgreSQL

You need a running Postgres instance and a database matching `DATABASE_URL`.

Using local Postgres directly:

```bash
createdb wetty_chat
```

If your local Postgres user/password differ, update `DATABASE_URL` to match them.

Using Docker Compose from the repo root:

```bash
docker compose up -d postgres
```

The compose file exposes PostgreSQL on `127.0.0.1:5432`.
If you use that container, set:

```bash
DATABASE_URL=postgres://wetty_chat:NIM1gs7unjbQumYD@127.0.0.1:5432/wetty_chat
```

### Run the backend

```bash
cd backend
cargo run
```

Default ports:

- API: `http://localhost:3000`
- Metrics: `http://localhost:3001/metrics`

### Minimal frontend setup

The frontend uses the Vite dev server and proxies `/_api/*` to the backend.

1. Copy the example file:

```bash
cd wetty-chat-mobile
cp .env.example .env
```

2. Install dependencies:

```bash
cd wetty-chat-mobile
npm ci
```

3. Start the dev server:

```bash
npm run dev
```

By default the dev proxy targets `http://localhost:3000`. Override it with `API_PROXY_TARGET` only if your backend is running somewhere else.

The dev client sends:

- `X-User-Id` in development mode
- `X-Client-Id` when there is no JWT yet

That matches the recommended local backend setting `AUTH_METHOD=UIDHeader`.
Outside local development, keep `AUTH_METHOD` unset or set to a non-`UIDHeader`
value so the backend does not trust `X-User-Id`.

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
