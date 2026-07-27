# Development

All commands run from the repository root. Full list:
[development/commands.md](../development/commands.md).

## Run the desktop app

```bash
pnpm tauri:dev
```

This starts the Vite dev server on `http://localhost:1420` and launches the
native Tauri shell against it, rebuilding Rust on change. The port is fixed
(Tauri's `devUrl`); it is set in both
[`app/frontend/vite.config.ts`](../../app/frontend/vite.config.ts) and
[`app/backend/src-tauri/tauri.conf.json`](../../app/backend/src-tauri/tauri.conf.json)
— keep them in sync if you change it.

## Frontend only (in a browser)

```bash
pnpm dev
```

Opens the frontend at `http://localhost:1420` without the native shell.
IPC calls no-op outside a Tauri window (see
[`isTauriContext`](../../app/frontend/src/services/tauri/client.ts)), so this
is useful for pure-UI work. The app is multi-window and hash-routed —
`#/main` (dashboard), `#/overlay`, `#/toast`, `#/tray`, `#/countdown`.

## Working across the JS ↔ Rust boundary

IPC wire types live once, in [`@clippity/shared`](../../app/shared), and are
mirrored by the Rust `domain::*` structs. When you change a command's
payload, update the Rust `domain` type **and** the matching contract in
`app/shared/src/contracts/`. See [architecture/ipc.md](../architecture/ipc.md).

## Before you push

```bash
pnpm check   # type-check (JS) + cargo check (Rust)
pnpm test    # Vitest + cargo test
pnpm lint    # ESLint + clippy
```
