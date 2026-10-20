# Local development setup

Run PostgreSQL, Meilisearch, and RustFS in Docker, with the Rust backend and Angular/Ionic PWA on the host. The checkout-local `runspace` provides initialization, representative fake data, and launch commands without changing `backend/.env` or `pwa/.env.local`.

## Prerequisites

- Docker Engine / Docker Desktop with Docker Compose v2 or newer, running and accessible without `sudo`.
- A current stable Rust toolchain and native backend build dependencies.
- Node.js matching [`pwa/.nvmrc`](../pwa/.nvmrc), and npm.
- Python 3.10 or newer; the seeder uses only the standard library.
- FFmpeg for audio/voice transcoding when exercising those attachment paths.

On Debian / Ubuntu, install native backend dependencies with:

```bash
sudo apt install build-essential pkg-config libssl-dev libpq-dev
```

On macOS:

```bash
xcode-select --install
brew install pkg-config openssl@3 libpq
```

If OpenSSL is not found on Apple Silicon, expose its pkg-config directory before building:

```bash
export PKG_CONFIG_PATH="$(brew --prefix openssl@3)/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
```

Neither a host PostgreSQL installation, `psql`, Diesel CLI, nor an S3 CLI is required. Initialization uses the database container's `psql`, the backend's embedded migrations, and a one-shot AWS CLI container for bucket configuration.

## Initialize

From the repository root:

```bash
node runspace/dev.mjs init
```

Initialization:

1. Creates ignored `runspace/.env` if absent, with local endpoints, checkout-specific Compose project identity, and generated JWT, service-token, VAPID, and Meilisearch keys. Existing configuration and keys are retained.
2. Starts PostgreSQL 18, Meilisearch, and RustFS with persistent, project-scoped named volumes and loopback-only host ports.
3. Waits for the services and creates a public-download local S3 bucket, including upload CORS configuration. Uploads still require signed requests.
4. Builds the debug backend on the host and starts it temporarily. The backend applies the normal embedded migrations.
5. Seeds identities and administrator permissions through SQL, then creates chat content through the real APIs so message search, membership events, thread metadata, and unread state follow normal backend behavior.
6. Stops the temporary backend, leaving dependency containers running.

The temporary backend's output is in ignored `runspace/backend-init.log`. If initialization fails, correct the reported problem and run the same command again. Stop any backend already using this runspace's API or metrics port first; initialization does not attach to an unknown existing process.

The generated credentials and arbitrary-UID development authentication are for local use only. Do not deploy this configuration or expose these services publicly. No production backend, database, object store, or APNs key is needed.

### Default addresses

| Service | Address |
| --- | --- |
| PWA | http://localhost:14300 |
| Backend API | http://127.0.0.1:13000 |
| Backend metrics | http://127.0.0.1:13001/metrics |
| PostgreSQL | 127.0.0.1:15432 |
| Meilisearch | http://127.0.0.1:17700 |
| RustFS S3 endpoint | http://127.0.0.1:19000 |
| RustFS console | http://127.0.0.1:19001 |

PostgreSQL uses database/user `wetty_chat` and password `local-chat-password`. RustFS uses access key and secret `rustfsadmin`; the bucket is `chahua-local`. The generated Meilisearch master key is in `runspace/.env`.

These ports differ from the original checkout's standard ports. The Compose project name includes a hash of the checkout path, so its containers, network, and volumes do not reuse the original checkout's resources. Another copy using this same runspace workflow needs different host ports as well: edit its generated `.env`, keeping port settings, endpoint URLs, listen addresses, and CORS origins consistent.

## Run backend and PWA

In one terminal, from the repository root:

```bash
node runspace/dev.mjs backend
```

This builds the backend and runs the host binary with the runspace configuration. Ctrl+C stops it; Docker dependencies remain running.

In another terminal:

```bash
node runspace/dev.mjs pwa
```

The PWA launcher installs dependencies with `npm ci` if Angular CLI is absent, and starts the existing dev launcher with this runspace's API target and PWA port. If the checkout already has `node_modules` but its dependencies have changed, synchronize them first:

```bash
(cd pwa && npm ci)
```

Open http://localhost:14300. HTTP and WebSocket traffic use the PWA's development proxy to the local backend. This launcher does not load `pwa/.env.local` or use a preset `CHAHUA_DEV_TOKEN`; a fresh browser session automatically obtains a development session for UID 1. Existing browser login state still takes precedence, as described in the [PWA README](../pwa/README.md).

Do not substitute `npm start`: that command targets production. Plain `npm run dev` uses the standard backend/PWA ports rather than the isolated runspace ports; use the launcher above for this stack.

### IDE / direct Cargo workflow

Use `runspace` as the backend working directory so its `.env` is loaded instead of `backend/.env`:

```bash
cd runspace
cargo run --manifest-path ../backend/Cargo.toml
```

For an IDE, use the same working directory and the `backend/Cargo.toml` manifest / `wetty-chat-backend` executable. No backend container is involved.

## Seeded data

The initial fixture set contains:

- 100 fake users, UIDs 1–100, with deterministic names, profiles, and three user-group tags. All email addresses use `example.test`.
- UID 1 (`Avery Chen 001`) with the global administrator policy. Other users remain ordinary members.
- Four public groups: **Town Square** (100 members), **Project Aurora** (25), **Book Club** (30), and **Weekend Plans** (16).
- Three friendship-backed DMs: users 1–2, 1–3, and 4–5.
- 219 text messages, including four thread roots with four text replies each; normal membership and friendship events bring the initial message total to 389.
- Reactions and mixed chat/thread read states. UID 1 starts with read group history and unread DMs; other users have unread group history.

Search for `seed-search-lantern` to exercise message search.

To switch the PWA's development identity, use its browser console:

```javascript
sessionStorage.setItem('uid', '7');
location.reload();
```

For manually authenticated API calls:

```bash
curl -sS http://127.0.0.1:13000/auth/dev-session \
  -H 'Content-Type: application/json' \
  -H 'X-Client-Id: local-dev-client' \
  -d '{"uid":1}'
```

Use the returned token as `Authorization: Bearer <token>`.

### Repeated initialization

`init` is additive, not a reset. It retains generated keys and records fixture progress in ignored `runspace/seed-state.json`, tied to the PostgreSQL cluster identity. Repeating initialization does not duplicate seeded messages or reset completed fixtures' read states, edited descriptions, or user-created conversations. Do not delete the progress file to refresh data.

With the backend already running, seed or resume fixture creation without starting another backend:

```bash
node runspace/dev.mjs seed
```

## Day-to-day container management

From the repository root:

```bash
node runspace/dev.mjs up       # Start dependencies and ensure the bucket is configured
node runspace/dev.mjs stop     # Stop dependencies, retaining all data

docker compose -f runspace/docker-compose.yml ps
docker compose -f runspace/docker-compose.yml logs postgres
```

Stop host backend/PWA processes separately with Ctrl+C.

For a deliberately clean environment, first stop those host processes. The following command **permanently deletes this runspace project's database, search index, and uploaded files**:

```bash
docker compose -f runspace/docker-compose.yml down -v
node runspace/dev.mjs init
```

The new PostgreSQL cluster identity causes the seeder to create fresh fixtures. Keys in `runspace/.env` are retained. Do not run `down -v` when you want to preserve development data.

## Troubleshooting

- **Port occupied:** stop the conflicting process or consistently change the relevant ports and URLs in `runspace/.env`. The initializer refuses to start over an existing API or metrics listener.
- **Backend build fails:** check Rust and native build prerequisites above. Initialization does not install a host toolchain.
- **Initialization fails after starting the backend:** inspect `runspace/backend-init.log`; rerun `init` after fixing the cause.
- **Development session returns 404:** use this runspace's launcher/configuration; it enables local debug authentication. Do not enable arbitrary-UID authentication on a production service.
- **Unknown user / missing groups:** confirm the frontend targets port 13000 and that initialization completed; inspect browser login state before assuming UID 1 is active.
- **PWA module-resolution errors:** run `(cd pwa && npm ci)` to align installed dependencies with the lockfile.
- **Uploads fail:** check RustFS health, use this runspace's `S3_ENDPOINT_URL` and `S3_BASE_URL`, and rerun `node runspace/dev.mjs up` to ensure bucket policy and CORS are configured.
