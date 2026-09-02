# Local development setup (beginner guide)

This guide gets a full local chat stack running on **macOS** or **Linux** with **no prior experience** assumed. By the end you will have:

- PostgreSQL running in Docker
- The Rust backend running **on your host** (easy to debug in an IDE / with `cargo`)
- The React/Ionic frontend PWA talking to that backend
- A seed user (`uid=1`) and admin-level permissions so you can create chats

Recommended layout for day-to-day work: **Postgres (and optionally object storage) in Docker; backend and frontend outside Docker.**

Commands that differ by OS are labeled **macOS** or **Linux**. Shared steps (clone, `.env`, `cargo run`, seed SQL, Vite) are the same on both.

---

## 0. What you need

| Tool | Purpose | Rough version |
|------|---------|---------------|
| Git | Clone the repo | any recent |
| Docker + Docker Compose | Run PostgreSQL | Docker 24+ |
| Rust (`rustc` / `cargo`) | Build & run the API | **1.95** (matches CI) |
| Node.js + npm | Frontend Vite app | **^20.19** or **≥22.12** |
| `openssl` | Generate JWT signing key | usually preinstalled / via Homebrew |
| `psql` (optional but helpful) | Insert the seed user | `libpq` / `postgresql-client` |
| Xcode Command Line Tools (macOS) | Compilers / headers for native crates | — |

### Native packages to compile the backend

**macOS** (Homebrew — install Homebrew first if needed: https://brew.sh):

```bash
xcode-select --install   # if you have never installed Command Line Tools
brew install pkg-config openssl@3 libpq
brew link --force libpq  # puts `psql` on your PATH; follow any brew hints if this warns
```

Apple Silicon Macs sometimes need OpenSSL visible to the Rust build. If `cargo build` later fails to find OpenSSL, add this to `~/.zshrc` (then open a new terminal):

```bash
export PKG_CONFIG_PATH="$(brew --prefix openssl@3)/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
```

**Linux (Debian / Ubuntu):**

```bash
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev libpq-dev postgresql-client
```

---

## 1. Check what you already have

Run these one at a time. If a command prints a version, you already have that tool.

```bash
git --version
docker --version
docker compose version
rustc --version
cargo --version
node --version
npm --version
openssl version
psql --version
```

**How to read the results**

- `command not found` → install that tool in the next section.
- Node must be `v20.19.x` or `v22.12+` (Vite 7 requirement). `v20.18` or `v21` will fail.
- Rust should be recent; if `cargo run` later fails on language features, update with `rustup update`.
- On macOS, if `git` or `clang` is missing, run `xcode-select --install` first.

---

## 2. Install missing tools

Skip any subsection whose tools already work.

### 2.1 Docker

**macOS — Docker Desktop**

1. Download and install [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/).
2. Open **Docker Desktop** from Applications and wait until it says Docker is running.
3. Verify in Terminal:

```bash
docker run --rm hello-world
docker compose version
```

If `docker` is not found, quit and reopen Terminal after install (PATH is updated when Docker Desktop starts).

**Linux (Debian / Ubuntu) — Docker Engine:**

```bash
# If `docker` is missing:
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Log out and back in (or reboot) so the `docker` group applies, then verify:

```bash
docker run --rm hello-world
docker compose version
```

If `docker` works only with `sudo`, the group membership did not take effect yet.

### 2.2 Rust

Same on macOS and Linux:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Choose the default install when prompted, then reload your shell:

```bash
source "$HOME/.cargo/env"
rustc --version
cargo --version
```

Optional but useful for schema work later (needs `libpq` / OpenSSL from §0):

```bash
cargo install diesel_cli --no-default-features --features postgres
```

You do **not** need Diesel CLI just to run the app — migrations are applied automatically on startup.

### 2.3 Node.js

Use an official LTS that satisfies `^20.19 || >=22.12`. [nvm](https://github.com/nvm-sh/nvm) works the same on macOS and Linux:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# restart the shell (or `source ~/.nvm/nvm.sh`), then:
nvm install 22
node --version   # should be v22.12+ or a recent v20.19+
npm --version
```

**Alternatives**

- **macOS:** `brew install node@22` (then follow brew’s PATH instructions for that formula).
- **Linux:** [NodeSource](https://github.com/nodesource/distributions) if you prefer apt packages over nvm.

### 2.4 Clone the repository

```bash
git clone <YOUR_REPO_URL> chahua-im
cd chahua-im
```

Optional: enable the repo’s pre-commit format hooks:

```bash
git config core.hooksPath .githooks
```

---

## 3. Start PostgreSQL in Docker

From the **repository root**:

```bash
docker compose up -d postgres
```

Check that it is healthy:

```bash
docker compose ps
docker compose logs postgres --tail 20
```

Compose starts Postgres **18** on `127.0.0.1:5432` with:

| Setting | Value |
|---------|-------|
| User | `wetty_chat` |
| Password | `NIM1gs7unjbQumYD` |
| Database | `wetty_chat` (created automatically from the username) |

Quick connectivity check:

```bash
psql "postgres://wetty_chat:NIM1gs7unjbQumYD@127.0.0.1:5432/wetty_chat" -c 'SELECT 1;'
```

You should see `1`.

> **Port already in use?** Something else is bound to 5432. Either stop that service, or change the host port mapping in `docker-compose.yml` (for example `"5433:5432"`) and use that port in `DATABASE_URL`.

---

## 4. Configure the backend (`.env`)

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env`. At minimum set the values below.

### 4.1 Database (Docker Compose credentials)

```bash
DATABASE_URL=postgres://wetty_chat:NIM1gs7unjbQumYD@127.0.0.1:5432/wetty_chat
```

### 4.2 JWT signing key

The backend requires a JWT key at startup:

```bash
openssl rand -base64 32
```

Paste the output into:

```bash
JWT_SIGNING_KEY_BASE64=<paste here>
```

### 4.3 Local debug sessions

`cargo run` builds the backend in debug mode, which enables `POST /auth/dev-session` for local development. It issues a JWT for a seeded user; it does not accept an identity header. If you intentionally run a release build locally, set `ENABLE_DEBUG_AUTH=true` to enable this endpoint.

To obtain a token manually for the seeded user, send a valid `X-Client-Id` while creating the session:

```bash
curl -sS -X POST http://localhost:3000/auth/dev-session \
  -H 'Content-Type: application/json' \
  -H 'X-Client-Id: local-dev-client' \
  -d '{"uid":1}'
```

The response is `{"token":"<jwt>"}`. Use that value as `Authorization: Bearer <jwt>` for API calls. The Vite development client performs this bootstrap automatically for its configured local uid.

### 4.4 Web Push (VAPID) keys

Also required at startup:

```bash
npx --yes web-push generate-vapid-keys
```

Copy the printed public/private keys into `.env`:

```bash
VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>
VAPID_SUBJECT=mailto:dev@example.com
```

### 4.5 S3 / attachments (required env vars)

The process will not start without these names set. For **basic chat API work** you can leave placeholders and skip real object storage until you need uploads:

```bash
S3_BUCKET_NAME=wetty-chat-local-dev
AWS_REGION=us-west-2
```

When you need attachments locally, start a MinIO-compatible store from the repo root and uncomment the matching lines in `.env.example`:

```bash
# from repo root
docker compose up -d rustfs init-rustfs
```

Then in `backend/.env`:

```bash
S3_ENDPOINT_URL=http://127.0.0.1:9000
AWS_ACCESS_KEY_ID=rustfsadmin
AWS_SECRET_ACCESS_KEY=rustfsadmin
S3_BASE_URL=http://127.0.0.1:9000/wetty-chat-local-dev
```

### 4.6 Optional CORS

If you ever call the API from a browser origin other than the Vite proxy, set:

```bash
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

With the default Vite proxy you usually do not need this.

Discuz avatar variables and Meilisearch can stay commented out for a first run.

---

## 5. Run the backend on the host

Still in `backend/`:

```bash
cargo run
```

The first build downloads crates and can take several minutes. On success you should see the API listening.

| Service | URL |
|---------|-----|
| API | http://localhost:3000 |
| Metrics | http://localhost:3001/metrics |

**Migrations:** Diesel migrations under `backend/migrations/` are **embedded** and applied automatically on startup. You do not need to run `diesel migration run` for a normal local setup.

Leave this terminal open. Open a second terminal for the next steps.

## 6. Create the initial user and permissions

An empty database has **no users** and **no one assigned** the admin policy. Create the seeded user before bootstrapping a local JWT or using the frontend; otherwise the user profile shows as `Unknown` and creating chats will fail authorization.

Identity lives in Discuz-compatible tables (`discuz.common_member`). The frontend defaults to **uid `1`** when it requests its development session.

### 6.1 Insert a development user

```bash
psql "postgres://wetty_chat:NIM1gs7unjbQumYD@127.0.0.1:5432/wetty_chat" <<'SQL'
INSERT INTO discuz.common_member (uid, loginname, username, email, groupid, regdate)
VALUES (
  1,
  'devuser',
  'devuser',
  'dev@example.com',
  10,
  extract(epoch from now())::bigint
)
ON CONFLICT (uid) DO NOTHING;
SQL
```

`username` is unique and limited to 50 characters.

### 6.2 Grant permission to create chats (and more)

Migrations seed a reserved policy `permission_admin` (`id = 1`) with `permission.all`, but it is **not assigned to anyone**. Assign it to your user:

```bash
psql "postgres://wetty_chat:NIM1gs7unjbQumYD@127.0.0.1:5432/wetty_chat" <<'SQL'
INSERT INTO policy_assignments (id, subject_type, subject_id, policy_id, created_at, updated_at)
VALUES (1, 'user', 1, 1, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
SQL
```

Verify:

```bash
psql "postgres://wetty_chat:NIM1gs7unjbQumYD@127.0.0.1:5432/wetty_chat" -c \
  "SELECT uid, username FROM discuz.common_member; SELECT * FROM policy_assignments;"
```

---

## 7. Run the frontend

In a new terminal:

```bash
cd wetty-chat-mobile
cp .env.example .env   # optional; only needed to override the API proxy
npm ci
npm run dev
```

Open the URL Vite prints (typically http://localhost:5173).

How the pieces connect:

- Dev API calls go to `/_api/...` on the Vite origin.
- Vite proxies `/_api` → `http://localhost:3000` (override with `API_PROXY_TARGET` in `.env` if needed).
- In development, the client requests `POST /auth/dev-session` for its configured local uid and sends `X-Client-Id` with that bootstrap request.
- The backend returns a JWT, which the client stores and sends as `Authorization: Bearer <token>` on API calls.

---

## 8. Smoke-check

1. Backend terminal shows requests without panicking.
2. Frontend loads without a blank error screen.
3. You can open or create a conversation (needs the policy assignment from §6).
4. Optional API check: create a development session, copy its `token`, then use it as a bearer token:

```bash
curl -sS -X POST http://localhost:3000/auth/dev-session \
  -H 'Content-Type: application/json' \
  -H 'X-Client-Id: local-dev-client' \
  -d '{"uid":1}'

curl -sS -H 'Authorization: Bearer <token from the previous response>' \
  http://localhost:3000/users/me
```

---

## 9. Day-to-day workflow

| Want to… | Do this |
|----------|---------|
| Start DB | `docker compose up -d postgres` (repo root) |
| Start API | `cd backend && cargo run` |
| Start UI | `cd wetty-chat-mobile && npm run dev` |
| Stop DB | `docker compose stop postgres` |
| Reset DB data | `docker compose down -v` then start postgres again, re-run backend (migrations), re-run §6 |
| Format before commit | enable `.githooks`, or run `cargo fmt` / `npm run format` |

Debug the backend like any local Rust binary: breakpoints in your IDE, `RUST_LOG=debug cargo run`, etc. Postgres stays in Docker so you do not need a native Postgres install.

---

## 10. Troubleshooting

| Symptom | Likely fix |
|---------|------------|
| `docker: command not found` (macOS) | Install/start **Docker Desktop**; reopen Terminal |
| `POST /auth/dev-session` returns `404` | Run `cargo run` (debug builds enable it), or set `ENABLE_DEBUG_AUTH=true` only for a local release build |
| `docker: permission denied` (Linux) | Re-login after `usermod -aG docker`, or use rootless Docker |
| `connection refused` on 5432 | `docker compose up -d postgres`; check `docker compose ps` |
| `password authentication failed` | `DATABASE_URL` must match compose user/password above |
| Backend exits on missing env | Fill `JWT_SIGNING_KEY_BASE64`, VAPID keys, `S3_BUCKET_NAME`, `AWS_REGION` |
| Username shows `Unknown` | Missing `discuz.common_member` row for uid `1` |
| Cannot create chat | Missing `policy_assignments` row for uid `1` → policy `1` |
| Frontend cannot reach API | Backend not on `:3000`, or wrong `API_PROXY_TARGET` |
| `npm ci` / Vite engine error | Upgrade Node to ^20.19 or ≥22.12 |
| Linker / OpenSSL / pq errors on `cargo build` (**macOS**) | `brew install pkg-config openssl@3 libpq`; set `PKG_CONFIG_PATH` as in §0; ensure Xcode CLT installed |
| Linker / OpenSSL / pq errors on `cargo build` (**Linux**) | Install `libssl-dev`, `libpq-dev`, `pkg-config`, `build-essential` |
| `psql: command not found` (**macOS**) | `brew install libpq && brew link --force libpq` |
| Port 5432 already in use (**macOS**) | Local Postgres from Homebrew may be running; `brew services stop postgresql@…` or change the compose host port |

---

## Related files

- Root overview (shorter): [`README.md`](../README.md)
- Backend env template: [`backend/.env.example`](../backend/.env.example)
- Compose services: [`docker-compose.yml`](../docker-compose.yml)
- Frontend proxy notes: [`wetty-chat-mobile/.env.example`](../wetty-chat-mobile/.env.example)
