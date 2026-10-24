# chahua

chahua is a chat application targeting ~20k users / ~2k messages per day.

## Project layout

- `backend/`: Rust, Axum, Diesel, PostgreSQL — see [backend/README.md](backend/README.md) and [backend/AGENTS.md](backend/AGENTS.md)
- `pwa/`: Angular + Ionic PWA client — see [pwa/README.md](pwa/README.md) and [pwa/AGENTS.md](pwa/AGENTS.md)

## Local development

Initialize a checkout-local database, search, object storage, and fake chat data, then run the backend and PWA on the host:

```bash
node runspace/dev.mjs init
node runspace/dev.mjs backend  # One terminal
node runspace/dev.mjs pwa      # Another terminal; http://localhost:14300
```

Prerequisites, isolated ports, seed identities, and container management: [docs/local-setup.md](docs/local-setup.md).

## Formatting and hooks

This repo includes a shared Git pre-commit hook at `.githooks/pre-commit` that checks the formatting of staged files only. Enable it in a clone:

```bash
git config core.hooksPath .githooks
```

Formatting commands for each subproject are described in its README.
