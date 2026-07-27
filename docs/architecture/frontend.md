# Frontend

Package `clippity-frontend` ([`app/frontend`](../../app/frontend)) — React 19
+ TypeScript + Vite 7 + Tailwind CSS v4, with Zustand for state and Motion for
animation.

## Layout

```text
app/frontend/src/
├── main.tsx            # single entry; hash-routes to the per-window shell
├── windows/            # one shell per Tauri window (Capture, Overlay, Toast, Tray, Countdown, Main)
├── app/                # app shell, providers
├── features/           # feature modules — capture, overlay, editor, library,
│                       #   collections, settings, presets, onboarding, toast, tray, countdown, dashboard
├── services/tauri/     # IPC clients (one per backend domain) + the invoke/on plumbing
├── state/              # Zustand stores
├── shared/             # cross-feature hooks / lib / ui
├── assets/ styles/ config/ test/
```

## Feature modules

Each folder under `features/` owns its components, hooks, and local state for
one product area. Cross-feature needs go through `services/tauri` (for backend
calls) or `shared/` (for UI + hooks) — features do not import from each other's
internals.

## IPC clients

`services/tauri/clients/<domain>.ts` wraps each backend command in a typed
function and re-exports that domain's wire types from
[`@clippity/shared`](../../app/shared). The `invoke`/`on` plumbing lives in
`services/tauri/{client,events}.ts`. See [ipc.md](ipc.md).

## Build config

- [`vite.config.ts`](../../app/frontend/vite.config.ts) — React + Tailwind
  plugins, path aliases (`@`, `@features`, `@services`, …), fixed dev port
  1420, and `motion`/`react` manual chunks.
- [`tsconfig.app.json`](../../app/frontend/tsconfig.app.json) — strict TS with
  the same path aliases.
- Tests: Vitest + Testing Library (`vitest.config.ts`, jsdom).

Shared dev tooling (TypeScript, ESLint, Prettier) is hoisted to the workspace
root; only framework-specific deps stay in the frontend package.
