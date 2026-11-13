# Local development

All Git worktrees share PostgreSQL, Meilisearch, RustFS, development keys, and seed progress in one Docker Compose project. Each worktree runs its own Rust backend and Angular PWA, with separate ports and build outputs.

## Prerequisites

- Docker with Compose, accessible to your user without `sudo`.
- Rust and native backend dependencies. On Debian/Ubuntu: `sudo apt install build-essential pkg-config libssl-dev libpq-dev`. On macOS: Xcode command line tools and `brew install pkg-config openssl@3 libpq`.
- Node.js matching `pwa/.nvmrc`, npm, and Python 3.10+ for seeding.
- Bacon for backend rebuild/restart: `cargo install --locked bacon`.
- FFmpeg when testing audio/voice transcoding.

The launcher supports Linux and macOS and requires `pkill` to stop Cargo's child during rebuilds. Host PostgreSQL, S3 tools, and Diesel CLI are not required. Frontend-only online development needs Git, Node.js, and npm; it does not need Docker or Rust.

## Start development

Run launcher commands from the current worktree's repository root.

For a fresh local environment with test data:

```bash
node runspace/dev.mjs init
node runspace/dev.mjs dev
```

`init` creates configuration and shared services, configures the bucket, temporarily runs the backend to apply migrations, and seeds fixtures. It requires this worktree's backend to be stopped. To prepare a fresh environment **without fixtures**, use `up` instead of `init`, then run `dev`.

Bucket initialization uses the official AWS CLI container from Amazon ECR Public (`public.ecr.aws/aws-cli/aws-cli`). It creates the bucket only when absent and reapplies anonymous download access and CORS for GET, PUT, and HEAD, exposing `ETag`. No host AWS CLI or MinIO client is needed.

For daily use or an existing shared database:

```bash
node runspace/dev.mjs dev
```

`dev` starts shared services and both application processes without seeding. Backend startup applies pending migrations. Bacon rebuilds/restarts after changes to Rust sources, manifests, `Cargo.lock`, `build.rs`, and migrations; fixing a compilation error and saving resumes the backend. Angular handles frontend hot reload.

The launcher prints the frontend URL and labels backend/frontend logs. Ctrl+C stops the application processes and their descendants; shared Docker services keep running. Stop those separately with `node runspace/dev.mjs infra-stop`.

Frontend dependencies are installed with `npm ci` when Angular CLI is absent. After switching branches or changing dependency files, run `(cd pwa && npm ci)` to synchronize installed dependencies with the lockfile.

To verify the backend without starting shared services, run `cargo build` and `cargo test` from `backend/`. Database-backed tests require `WETTY_TEST_DATABASE_URL` pointing to a migrated development database; they skip when it is unset.

## Commands

| Command (`node runspace/dev.mjs …`) | Behavior                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `init`                              | Prepare shared services, apply migrations, and seed/resume fixtures                                         |
| `dev`                               | Start shared services, backend watcher, and frontend                                                        |
| `backend`                           | Start only the backend watcher; shared services must already be running                                     |
| `pwa`                               | Start only the frontend; its local backend must be started separately                                       |
| `pwa --online`                      | Start an HTTPS frontend targeting production; no local backend or shared services required                  |
| `up`                                | Create missing configuration and start shared services/configure the bucket, without migrations or fixtures |
| `infra-stop`                        | Stop shared services for **all worktrees**, retaining data                                                  |
| `seed`                              | Seed/resume fixtures; shared services and this worktree's backend must be running                           |
| `reindex`                           | Apply pending migrations and rebuild the shared search index; PostgreSQL and Meilisearch must be running    |
| `compose …`                         | Run Compose with the shared project/configuration, e.g. `compose ps` or `compose logs postgres`             |

In `pwa/`, `npm start` and `npm run dev` invoke `pwa`; `npm run dev:online` invokes `pwa --online`. These start **only the frontend**. Online mode connects to production and must not be used for write tests.

## Worktrees and configuration

Once shared services have been initialized, a new worktree needs no additional `init`:

```bash
git worktree add ../chahua-feature -b feature
cd ../chahua-feature
node runspace/dev.mjs dev
```

Each worktree keeps its own `backend/target` and `pwa/node_modules`. Removing a linked worktree does not remove shared Docker data. Database writes, migrations, and search-index changes affect every worktree. This setup does not synchronize backend caches or WebSocket connections across processes; connect test browsers to the same backend for real-time interactions.

| File                                        | Scope and creation                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `<git-common-dir>/runspace/.env`            | Shared service settings and credentials; created by `init` or `up`. Required for local mode, optional for `pwa --online` |
| `runspace/.env`                             | This worktree's four application ports and optional `PWA_HOST`; automatically created if absent                          |
| `<git-common-dir>/runspace/seed-state.json` | Shared fixture progress, written by seeding                                                                              |
| `pwa/.env.local`                            | Optional `CHAHUA_DEV_TOKEN` preset; not required for startup                                                             |

Locate the Git common directory with `git rev-parse --path-format=absolute --git-common-dir`. Shared files live outside the tracked tree; worktree env files are ignored. Keep credentials out of commits. The launcher supplies backend configuration through the process environment; a separate `backend/.env` is unnecessary. Production frontend builds do not load these development env files.

`COMPOSE_PROJECT_NAME` selects the shared containers and named volumes; changing it selects a different data stack. All worktrees using the same stack must use its infrastructure endpoints and credentials, including `MEILI_MASTER_KEY`, JWT/service-token keys, and VAPID keys. Infrastructure ports are fixed settings, not automatically allocated: separate Compose projects on the same host need distinct ports and matching URLs. A port collision can indicate another stack already owns those ports; `dev` starts infrastructure just like `init` and `up`.

The worktree port file contains values allocated starting from:

```dotenv
API_PORT=13000
METRICS_PORT=13001
PWA_PORT=14300
ONLINE_PWA_PORT=14301
```

Automatic allocation avoids listening ports and ports saved by other registered worktrees, including stopped ones. Saved assignments persist. Missing, invalid, or duplicate ports within the worktree/shared configuration are rejected with the file and field names; a port occupied by a running process is also an error. Edit this file to change persistent application ports, then restart the affected processes. Backend addresses, local proxy targets, and localhost CORS origins derive from these values.

Shared service defaults are loopback-only:

| Service        | Host endpoint            |
| -------------- | ------------------------ |
| PostgreSQL     | `127.0.0.1:15432`        |
| Meilisearch    | `http://127.0.0.1:17700` |
| RustFS API     | `http://127.0.0.1:19000` |
| RustFS console | `http://127.0.0.1:19001` |

If changing a shared service port, update both its `*_PORT` setting and corresponding URLs in the shared env file, then run `up` and restart affected application processes. For example, `POSTGRES_PORT` and the port in `DATABASE_URL` must match.

## Application configuration

The backend accepts one optional non-secret TOML file selected by `CHAHUA_CONFIG_PATH`.
Use an absolute path; a relative path is resolved from the backend process's working
directory. With no file selected, existing environment-only deployments continue to work.
Resolution is **defaults → TOML → existing environment variables**, including values
supplied by runspace or the container image. Settings are loaded once; restart to apply changes.
A missing selected file emits a warning and falls back to environment variables and
defaults. Other read errors, malformed TOML, and unknown fields fail startup.

Start from [`backend/config.example.toml`](../backend/config.example.toml):

```bash
cp backend/config.example.toml backend/config.local.toml
CHAHUA_CONFIG_PATH="$PWD/backend/config.local.toml" node runspace/dev.mjs dev
```

The file covers server binds/CORS, logging, media settings and region, development
authentication, avatars, message search, public push/APNs metadata, node IDs, and link-preview request headers.
Runspace's generated bind/storage environment still wins,
preserving worktree isolation. The Docker image defaults to `/config/config.toml`;
if it is absent, the backend warns and uses environment variables and defaults.
Mount custom TOML read-only at that path, for example with
`--mount type=bind,src=/absolute/path/config.toml,dst=/config/config.toml,readonly`.
Set `CHAHUA_CONFIG_PATH` to override the container path. Do not bake environment-specific
configuration or credentials into the image.

`DATABASE_URL`, JWT/service-token signing keys, `VAPID_PRIVATE_KEY`, `MEILI_MASTER_KEY`,
`APNS_PRIVATE_KEY_PATH`, and AWS credentials remain environment/provider-chain settings,
not TOML values. Keep actual private key files protected as before. Public metadata such
as `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, APNs key/team IDs and topic may be in TOML.

Each `[[link_previews.sites]]` entry has a required `host` and an optional `headers`
map. Hosts match exact canonical hostnames, not wildcards or inherited subdomain rules.
Literal non-secret headers are allowed; secrets use explicit environment references:

```toml
[[link_previews.sites]]
host = "example.com"
headers = {
    User-Agent = "chahua-link-preview/1.0",
    Cookie = { env = "PREVIEW_EXAMPLE_COOKIE" },
}

[[link_previews.sites]]
host = "news.example.org"
headers = {
    Authorization = { env = "PREVIEW_NEWS_AUTHORIZATION" },
}
```

Referenced variables must exist. `Cookie` and `Authorization` cannot be literal TOML
strings; use environment references for other sensitive headers too. Use dedicated
read-only site credentials because these are server-wide fetch settings, not per-user
sessions. There is no cookie jar or `Set-Cookie` persistence. Redirects and thumbnail
requests select only their destination host's settings; credentials never follow another
host implicitly. Host/connection/framing headers and `Accept-Encoding` cannot be
overridden. HTTPS, TLS validation, DNS/IP restrictions, address pinning, deadlines and
response limits remain enforced.

Built-in website profiles and special handlers remain in Rust. TOML headers override
individual headers on the exact host, preserving other built-in headers and handlers.
An empty or absent sites list keeps all built-in profiles; it does not disable them.
TOML cannot select a handler or enable inherited subdomain matching.

## Port overrides and LAN HTTPS

All frontend modes bind to `127.0.0.1` by default and are accessible only from this machine; pass `--host 0.0.0.0` to allow LAN access, or add `PWA_HOST=0.0.0.0` to the ignored worktree file `runspace/.env`. The command-line `--host` takes precedence over this saved setting.

`dev`, `pwa`, and `pwa --online` accept `--port 14443` or `--port=14443` to override the frontend port for that invocation. This does not change backend ports or rewrite saved assignments. A missing worktree env file is still created with automatically allocated defaults. Occupied ports and overrides matching backend/shared-service ports are rejected.

Additional Angular serve options are forwarded:

```bash
node runspace/dev.mjs dev --port 14443 --host 0.0.0.0 --ssl \
  --ssl-cert /path/to/dev.pem --ssl-key /path/to/dev-key.pem
```

To enable HTTPS, local mode requires `--ssl`; online mode enables HTTPS by default. In `pwa/`, the equivalent frontend-only command is `npm run dev -- --port 14443 --host 0.0.0.0 --ssl --ssl-cert /path/to/dev.pem --ssl-key /path/to/dev-key.pem`. The certificate must cover the accessed hostname/IP and be trusted by the device.

`dev --port …` also updates the backend's localhost CORS origins for that run. Frontend-only commands cannot update an already-running backend. The launcher selects the proxy target: neither the shell's `API_PROXY_TARGET` nor `--proxy-config` can override it.

In local mode, the launcher sets `S3_UPLOAD_PROXY_PATH=/_storage` and derives a relative `S3_BASE_URL` from the storage endpoint path and bucket. Browsers upload and read media through the frontend's `/_storage/…` proxy, using the current page's scheme, host and port. Switching between LAN and VPN addresses does not require changing storage settings. RustFS stays bound to loopback; no separate storage port, certificate or Nginx is needed. Keep `S3_ENDPOINT_URL` pointed at the internal RustFS endpoint. The launcher supplies these browser URL settings at runtime without rewriting the shared env file. Restart both the backend and frontend after updating the launcher/proxy configuration; refresh existing pages to obtain fresh media URLs.

The storage proxy removes `/_storage`, preserves the encoded object path and signed query, and restores the internal endpoint's Host (including port) for S3 signature validation. Browser cookies and Authorization headers are not forwarded to storage. Backend S3 operations still use the internal endpoint directly. Online frontend mode does not enable this proxy.

HTTP supports image uploads when the page itself uses HTTP. To test recording and Service Worker features from a LAN/VPN IP, use trusted HTTPS. A single certificate can cover both IP addresses; each testing device must trust its issuer. Keep certificates/private keys outside the repository. Private settings in `runspace/.env` are ignored by Git; generic launcher/proxy code is tracked.

## Test data and development tools

`init`/`seed` create 100 users (UIDs 1–100), four groups, three DMs, messages, threads, reactions, and mixed read states. UID 1 is the development administrator. Search for `seed-search-lantern` to exercise search. Fixture progress is shared and tied to the PostgreSQL cluster; removing the state file can duplicate seeded content. Do not run seeding just to configure a new worktree.

Local frontend development obtains a session for UID 1 when no existing token or development preset takes precedence. To switch a tab's development identity:

```javascript
sessionStorage.setItem('uid', '7');
location.reload();
```

In `pwa/`:

- `npm run api:generate` reads the current worktree's `API_PORT` and requires that backend to be running. `OPENAPI_URL` overrides it with a schema URL or local file and does not require runspace configuration.
- `npm run preview:startup-failures` builds and previews simulated startup failures without a real backend. See [startup failure verification](../pwa/docs/startup-verification.md).
- Build and test commands are documented in the [PWA README](../pwa/README.md).

## Troubleshooting and launcher checks

- **Missing shared configuration:** run `init` for fixtures or `up` without fixtures. A missing worktree port file is created automatically.
- **Busy port:** stop the conflicting process, use `--port` for a temporary frontend port, or change the saved assignment.
- **Missing bacon / Docker permission denied:** check the prerequisites and executable PATH; use a session with Docker access.
- **Interrupted initialization:** fix the cause and rerun `init`; backend output is in `runspace/backend-init.log`. Remove a reported stale lock directory only after confirming its owning command is no longer running.
- **Frontend dependency errors:** run `(cd pwa && npm ci)`.
- **Development login returns 404:** use local mode and check `ENABLE_DEBUG_AUTH=true` in shared configuration, then restart the backend.

Launcher regression checks use temporary Git worktrees and local test servers, without writes to the application's database or S3:

```bash
node --test runspace/dev.test.mjs
# Exercise the actual frontend proxy with a local SigV4-verifying mock storage server:
node --test pwa/scripts/storage-proxy.test.mjs
# Also exercise real bacon with a temporary Rust server:
RUNSPACE_TEST_BACON="$(command -v bacon)" node --test runspace/dev.test.mjs
```
