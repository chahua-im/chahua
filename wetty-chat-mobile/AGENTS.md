# Wetty Chat Mobile (Frontend)

This is a Progressive Web Application (PWA) that supports desktop, mobile platforms
It uses Ionic Framework v8 and React with Redux as store management and axios as API client

## UI Design

This application should have more or less a native iOS application feel.
For forms / list / input design try to follow iOS native settings app.
Use Ionic Components when applicable, only when native ionic component can't fit our need then design custom styling

## Style Customization

- Use a scss module when possible
- Avoid using inline styles unless it needs to be computed on the fly

## Localization

- This project uses `lingui` for localization (i18n) support.
- When writing UI code that include user visible text, we should use `t` or `Trans` when ever applicable.

## Structuring

- Use clean structure, create a component to abstract reusable / complex component
- Do not create huge monolitic page components that becomes a maintance nightmare
- Use Ionic component when it fits, avoid reinventing the wheel and keep style consistent

## Architecture Notes

- Routing uses `react-router` / `react-router-dom` **v5** (via Ionic's `IonReactRouter`). Do not use v6+ APIs (`useNavigate`, `Routes`, etc.); use v5 idioms (`useHistory`, `Route` with `component`/`render`).
- Real-time updates come through a singleton WebSocket in `src/api/ws.ts` (ticket auth, reconnect, app-lifecycle handling), wired into Redux via `connectionSlice` and message event listeners.
- Layout branches on `useIsDesktop` between `MobileLayout` and `DesktopSplitLayout` in `src/App.tsx` — desktop renders many flows as modals over a split view, so new pages usually need both branches handled.

## Feature Gating

- New user-visible features should have an explicit flag in `src/features.ts`.
- Gate every frontend entry point for the feature, including buttons, menu items, message actions, routes, and desktop modal branches.
- Prefer default-enabled gates for completed features and default-disabled gates for staged rollout or internal-only features.
- The `__FEATURE_GATES_ENABLED__` build-time flag (set per Vite config: `vite.config.{dev,staging,prod}.ts`) can force all gates on; `src/features.ts` consumes it.

## Lint & Tests

After making changes, run `npm run verify` and ensure it passes.
`npm run verify` runs `npm run lint`, `npm run typecheck`, and the full Vitest suite (`npm run test:run`) — test failures block verify.
The test setup uses Vitest with two projects: `unit` (node) and `dom` (happy-dom, `*.dom.test.tsx`). Use `npm run test:unit` / `npm run test:dom` for a faster targeted run.
