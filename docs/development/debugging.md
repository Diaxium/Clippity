# Debugging

## Frontend

- Open WebView2 devtools from the running app (right-click → Inspect, or the
  devtools shortcut) for the console, network, and element inspector.
- `pnpm dev` runs the UI in a plain browser at `http://localhost:1421` — handy
  for pure-UI work. There is no Tauri bridge there, so IPC calls reject
  (`isTauriContext()` is false). The
  [design-review harnesses](../getting-started/development.md#design-review-harnesses)
  seed the editor, overlay, library, settings, and Studio with data instead.
- **Settings → Advanced** holds the diagnostics surface: a log viewer, system
  information, and a redacted support-bundle export for everyone; developer
  mode additionally arms the WebView inspector, IPC command timing (recorded by
  `invoke` in `services/tauri/client.ts`), feature flags, and safe mode. See
  [ADR 0033](../decisions/0033-diagnostics-are-a-shipped-surface-developer-mode-is-a-gate.md).
- IPC failures are logged centrally by `services/tauri/client.ts` (every
  command funnels through `invoke`), so a failed command shows up once with its
  `code` and `message` rather than at each call site.

## Backend

- Logging uses `tracing` + `tracing-subscriber` with an env filter
  (`clippity-infra::logging`). Set `RUST_LOG` to raise verbosity, e.g.
  `RUST_LOG=clippity_services=debug pnpm tauri:dev`.
- Logs are written to size-capped rotating files under `<data>/logs` by
  default (`developer.logToDisk`); the frontend logger forwards into the same
  files, so both halves of a bug share one timeline.
- Startup writes a diagnostics banner (version, OS, resolved app directories, a
  settings summary) via `clippity-infra::diagnostics::log_startup`.
- App data lives under `%LOCALAPPDATA%\Clippity` (the product name, not the
  bundle identifier), or in a `Data` folder beside the executable for a
  portable build. Older builds that split data across `%APPDATA%\Clippity`
  are migrated on startup. See `clippity-infra::paths`.

## Performance profiling

Earlier profiling passes are archived in this folder:

- [performance-audit-log.md](performance-audit-log.md)
- [devtools-performance-debug-report.md](devtools-performance-debug-report.md)

See [performance.md](performance.md) for build-time characteristics and
the [performance roadmap](../roadmaps/performance.md) for runtime work.
