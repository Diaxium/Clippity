# Debugging

## Frontend

- Open WebView2 devtools from the running app (right-click → Inspect, or the
  devtools shortcut) for the console, network, and element inspector.
- `pnpm dev` runs the UI in a plain browser at `http://localhost:1420` — handy
  for pure-UI work. IPC calls no-op there (`isTauriContext()` is false).
- IPC failures are logged centrally by `services/tauri/client.ts` (every
  command funnels through `invoke`), so a failed command shows up once with its
  `code` and `message` rather than at each call site.

## Backend

- Logging uses `tracing` + `tracing-subscriber` with an env filter
  (`clippity-infra::logging`). Set `RUST_LOG` to raise verbosity, e.g.
  `RUST_LOG=clippity_services=debug pnpm tauri:dev`.
- Startup writes a diagnostics banner (version, OS, resolved app directories, a
  settings summary) via `clippity-infra::diagnostics::log_startup`.
- App data lives under `%APPDATA%\Clippity` and `%LOCALAPPDATA%\Clippity`
  (the product name, not the bundle identifier — see
  `clippity-infra::paths`).

## Performance profiling

Earlier profiling passes are archived in this folder:

- [performance-audit-log.md](performance-audit-log.md)
- [devtools-performance-debug-report.md](devtools-performance-debug-report.md)

See [performance.md](performance.md) for build-time characteristics and
the [performance roadmap](../roadmaps/performance.md) for runtime work.
