# Development

All commands run from the repository root. Full list:
[development/commands.md](../development/commands.md).

## Run the desktop app

```bash
pnpm tauri:dev
```

This starts the Vite dev server on `http://localhost:1421` and launches the
native Tauri shell against it, rebuilding Rust on change. The port is fixed
(Tauri's `devUrl`, with HMR on the port after it); it is set in both
[`app/frontend/vite.config.ts`](../../app/frontend/vite.config.ts) and
[`app/backend/src-tauri/tauri.conf.json`](../../app/backend/src-tauri/tauri.conf.json)
— keep them in sync if you change it.

## Frontend only (in a browser)

```bash
pnpm dev
```

Opens the frontend at `http://localhost:1421` without the native shell. There
is no Tauri bridge in a plain browser, so IPC calls reject; code that must run
either way gates on
[`isTauriContext`](../../app/frontend/src/services/tauri/client.ts). The app is
multi-window and hash-routed — `#/main` (dashboard), `#/overlay`, `#/toast`,
`#/tray`, `#/countdown`, `#/recorder-frame`.

### Design-review harnesses

Most screens render only an empty state without backend data, so the frontend
ships dev-only entry pages that seed real components with representative data.
They are served by `pnpm dev` and are not part of the production bundle.

| Page | Mounts | Console handle |
| --- | --- | --- |
| `/editor-smoke.html` | `EditorLayout` with a seeded, annotated scene | `window.__ed` |
| `/overlay-smoke.html` | `OverlayLayout` over a synthetic desktop snapshot | `window.__ov` |
| `/library-smoke.html` | `LibraryLayout` behind a stubbed `__TAURI_INTERNALS__` | `window.__lib` |
| `/settings-smoke.html` | `SettingsLayout` with a seeded settings snapshot | — |
| `/studio-smoke.html`   | The Studio timeline, inspector, and annotation layer over a generated clip | `window.__studio` |

Each harness lives in `app/frontend/src/<name>-smoke.tsx`; its header comment
lists what it seeds and the console commands it supports.

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
