# Frontend

Package `clippity-frontend` ([`app/frontend`](../../app/frontend)): React 19
+ TypeScript + Vite 8 + Tailwind CSS v4, with Zustand for state and Motion for
animation.

## Layout

```text
app/frontend/src/
├── main.tsx            # single entry; app/windowRoutes.ts picks the per-window shell
├── *-smoke.tsx         # dev-only design-review harnesses (not bundled)
├── windows/            # one shell per Tauri window (Capture, Main, Overlay, Toast, Tray,
│                       #   Countdown, RecorderFrame)
├── app/                # app shell, providers
├── features/           # feature modules: capture, overlay, editor, studio, library,
│                       #   home, dashboard, settings, developer, presets, onboarding,
│                       #   toast, tray, countdown
├── services/tauri/     # IPC clients (one per backend domain) + the invoke/on plumbing
├── state/              # Zustand stores
├── shared/             # cross-feature hooks / lib / ui
├── assets/ styles/ config/ test/
```

The `*-smoke.tsx` entries (with matching `*-smoke.html` pages beside
`index.html`) are described in
[getting-started/development.md](../getting-started/development.md#design-review-harnesses).

## Feature modules

Each folder under `features/` owns its components, hooks, and local state for
one product area. Cross-feature needs go through `services/tauri` (for backend
calls) or `shared/` (for UI + hooks): features do not import from each other's
internals.

## IPC clients

`services/tauri/clients/<domain>.ts` wraps each backend command in a typed
function and re-exports that domain's wire types from
[`@clippity/shared`](../../app/shared). The `invoke`/`on` plumbing lives in
`services/tauri/{client,events}.ts`. See [ipc.md](ipc.md).

## Build config

- [`vite.config.ts`](../../app/frontend/vite.config.ts): React + Tailwind
  plugins, path aliases (`@`, `@features`, `@services`, …), fixed dev port
  1421, and separate `motion` / `react` chunks via Rolldown code-splitting
  groups.
- [`tsconfig.app.json`](../../app/frontend/tsconfig.app.json): strict TS with
  the same path aliases.
- Tests: Vitest + Testing Library (`vitest.config.ts`, jsdom).

Shared dev tooling (TypeScript, ESLint, Prettier) is hoisted to the workspace
root; only framework-specific deps stay in the frontend package.
