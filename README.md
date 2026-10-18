# wetty-chat

chahua is a chat application targeting ~20k users / ~2k messages per day.

## Project layout

- `backend/`: Rust, Axum, Diesel, PostgreSQL — see [backend/README.md](backend/README.md) and [backend/AGENTS.md](backend/AGENTS.md)
- `pwa/`: Angular + Ionic PWA client — see [pwa/README.md](pwa/README.md) and [pwa/AGENTS.md](pwa/AGENTS.md)
- `wetty-chat-flutter/`: Flutter client — see [wetty-chat-flutter/README.md](wetty-chat-flutter/README.md) and [wetty-chat-flutter/AGENTS.md](wetty-chat-flutter/AGENTS.md)

## Local development

New to the project? Follow the step-by-step beginner guide: [docs/local-setup.md](docs/local-setup.md)

## Formatting and hooks

This repo includes a shared Git pre-commit hook at `.githooks/pre-commit` that checks the formatting of staged files only. Enable it in a clone:

```bash
git config core.hooksPath .githooks
```

Formatting commands for each subproject are described in its README.
