# Frontend Testing Strategy

The React PWA needs layered coverage. Most regressions should be caught by fast deterministic tests, with browser tests reserved for behavior that depends on real routing, Ionic components, viewport behavior, service workers, or platform APIs.

## Current Baseline

- `npm run verify` runs lint, typecheck, and `vitest run`.
- Existing Vitest coverage is mostly pure Node tests around the canonical message timeline, message search helpers, and message API query helpers.
- The test suite now has two Vitest projects:
  - `unit`: Node environment for pure functions, reducers, selectors, API helpers, and store projections.
  - `dom`: happy-dom environment for browser-facing React/PWA behavior.
- There is not yet a Playwright suite.

## Layers

### Unit Tests

Use Node-based Vitest tests for logic that does not need a DOM:

- timeline algorithms
- Redux reducers, selectors, and listener projections
- route target builders
- API parameter construction
- auth/header selection helpers
- notification preview formatting
- feature-gate and permission decisions

These tests should stay small, deterministic, and cheap enough to run on every `npm run verify`.

### DOM Integration Tests

Use the happy-dom Vitest project for behavior that needs browser globals but does not need a full browser:

- landing auth and invite handoff
- cookie, localStorage, and sessionStorage interactions
- OOBE and route-gate decisions that can be tested without Ionic internals
- modal host mounting decisions
- small React component flows with mocked API boundaries

DOM tests should verify our behavior around Ionic components rather than Ionic's internal implementation.

### Mocked API And Realtime Harness

As coverage expands, add shared helpers for:

- mocked axios responses
- WebSocket event injection
- store creation with test fixtures
- storage adapters
- notification and service-worker shims

The key goal is to test app-level state transitions without requiring the Rust backend or a live websocket server.

### Browser Smoke Tests

Add Playwright after the DOM harness proves useful. Keep the first browser suite small:

- landing token handoff
- mobile chat route smoke path
- desktop split-layout route smoke path
- message jump via `#msg=...`
- virtual-scroll preservation for one representative history path

Browser tests should prove that the wiring works. Core correctness should remain in unit and DOM tests.

## Priority Matrix

| Surface                    | Primary Layer      | Notes                                                                                   |
| -------------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| Landing auth handoff       | DOM                | `?token=...` must record the JWT with or without `&invite=...`.                         |
| Message timeline           | Unit               | Keep the reducer and selector matrix broad.                                             |
| WebSocket event projection | Unit / integration | Inject events and assert store state, including duplicate API/websocket delivery.       |
| API auth headers           | Unit               | Cover JWT vs client ID and production `401` behavior.                                   |
| Desktop/mobile routing     | DOM / browser      | DOM for route decisions, browser for Ionic/back-stack behavior.                         |
| Localization               | Script / unit      | `lingui:compile --strict` should become part of CI once catalog churn is under control. |
| Virtual scroll             | Browser            | Unit-test helpers where possible, but verify one real viewport path.                    |

## Test Naming

- Use `*.test.ts` or `*.test.tsx` for Node unit tests.
- Use `*.dom.test.ts` or `*.dom.test.tsx` for happy-dom tests.
- Keep test fixtures close to the layer they support until there is real duplication.

## First Regression Contract

The landing auth contract is intentionally independent from invite handling:

- `/landing?token=blah` records `blah` as the JWT.
- `/landing?token=blah&invite=xxx` still records `blah` as the JWT.
- Invite persistence or modal behavior must not gate JWT recording.
