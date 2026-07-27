# Authoritative References

Documentation and tool versions used for the architecture decisions and
implementation (recorded per the task's requirement). Consulted 2026-07-24.

## Tool / crate versions (from this repo)

- Tauri **v2** (app + wizard), bundle targets `all` (WiX MSI + NSIS) for the app.
- `windows` crate **0.62.2** (Win32 registry, COM shortcuts, elevation,
  MoveFileEx). Exact signatures were read from the vendored crate source rather
  than assumed.
- Rust **1.96**, `sha2` 0.10, `serde`/`serde_json` 1, `thiserror` 1, `tracing`.
- Node **26**, pnpm **11**, React 19 + Vite + Tailwind 4.

## Microsoft Learn

- Uninstall Registry Key properties (Add/Remove Programs values):
  `DisplayName`, `DisplayVersion`, `Publisher`, `DisplayIcon`,
  `InstallLocation`, `InstallDate`, `EstimatedSize`, `UninstallString`,
  `QuietUninstallString`, `ModifyPath`, `NoModify`, `NoRepair`, `URLInfoAbout`,
  `HelpLink`, `WindowsInstaller`, `SystemComponent`.
- Restart Manager for Win32 (`RmStartSession`, `RmRegisterResources`,
  `RmGetList`) — for identifying processes holding files in use.
- `MoveFileExW` + `MOVEFILE_DELAY_UNTIL_REBOOT` — delete-on-reboot; directories
  removed only when empty.
- Code-signing options for Windows developers; SignTool (sign, verify,
  timestamp); Windows Installer error/return codes (1602, 1223, 1638, 1639,
  3010).
- Registry `Run`/`RunOnce` keys; App Paths; file-association / default-app
  guidance; Service Control Manager; Task Scheduler; Shell Link (`IShellLinkW`,
  `IPersistFile`); `SHGetKnownFolderPath` / KNOWNFOLDERID; reparse-point /
  privileged-file-operation security guidance.

## Tauri v2

- Windows Installer (MSI via WiX, NSIS setup exe) bundle documentation.
- Updater plugin (minisign signing, update manifest) — the app already uses this.
- Code-signing, bundle configuration reference, NSIS/WiX configuration, sidecar
  & resource bundling.

## WiX v4/v5 (for the documented Option-C target)

- Bundle (**Burn**) documentation: bootstrapper application controlling detect →
  plan → apply → repair → modify → uninstall; package caching; rollback
  boundaries; per-user vs per-machine package behavior; upgrade relationships.

> Note: this environment could not fetch live web pages during the run, so the
> references above are named by their canonical Microsoft Learn / Tauri / WiX doc
> titles for the implementer to open directly. All Win32 API signatures used in
> the code were verified against the vendored `windows` 0.62.2 crate source, not
> from memory.
