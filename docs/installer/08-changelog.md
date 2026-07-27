# Installer Change Log — Maintenance Engine Upgrade (2026-07-24)

Every installer-related file changed in this pass, and why. Scheduled task:
"Convert the Clippity Installer into a Complete Windows Setup and Maintenance
Wizard." All changes verified with `cargo check --workspace`, `pnpm check`, and
the domain + services test suites (28 tests, all passing).

## New files

| File | Why |
| --- | --- |
| `crates/domain/src/state.rs` | The authoritative installation model (`InstallationManifest`, `InstalledFile`, `RegistryRecord`, `ShortcutRecord`, `RegistryHive`) + the pure detection state machine (`InstallState`, `DetectionInputs`, `assess`, `Detection`). Unit-tested. |
| `crates/platform/src/windows/regutil.rs` | Audited, safe wrappers over the Win32 registry calls (create/open/set-sz/set-dword/delete-value/delete-tree/exists), centralising UTF-16 + `HKEY` lifetime + error mapping. |
| `crates/platform/src/windows/reboot.rs` | `MoveFileExW(MOVEFILE_DELAY_UNTIL_REBOOT)` — the locked-file fallback. |
| `crates/services/src/state_store.rs` | Persist/read `install-state.json`; installation-id derivation; schema peek. |
| `crates/services/src/detect.rs` | Correlate manifest + registry + exe into a `Detection`. |
| `crates/services/src/clock.rs` | Dependency-free UTC clock for `InstallDate` (`YYYYMMDD`) + ISO-8601. Unit-tested. |
| `app/shared/src/contracts/state.ts` | TS mirror of `Detection` / `InstallState` for the frontend. |
| `docs/installer/*` | Audit, ADR, installation model, lifecycle/recovery, self-removal/locked-files, security/CLI/logging, test matrix, this changelog, references, final report. |

## Changed files — backend

| File | Change |
| --- | --- |
| `crates/platform/src/windows/registry.rs` | **Was a log-only stub.** Now writes the full Add/Remove Programs value set to HKCU/HKLM by scope, the start-at-login `Run` value, and reads back presence + ownership marker. Real `RegCreateKeyEx`/`RegSetValueEx`/`RegDeleteTree` via `regutil`. |
| `crates/platform/src/windows/shortcuts.rs` | **Was a log-only stub.** Now creates/removes desktop + Start-menu `.lnk`s via `IShellLinkW`+`IPersistFile` COM, resolving folders with `SHGetKnownFolderPath`; returns the created path for the manifest. Start-at-login moved to `registry.rs`. |
| `crates/platform/src/entry.rs` | `UninstallEntry` enriched: scope/hive, `DisplayIcon`, `InstallDate`, `Quiet`/`Modify` strings pointing at the maintenance exe, `URLInfoAbout`, `HelpLink`. Added `RUN_VALUE`. |
| `crates/platform/src/windows_ops.rs` | Facade updated for the new/changed ops (shortcut paths, scope-aware ARP removal, detection reads, reboot scheduling); non-Windows no-ops kept so the workspace builds anywhere. |
| `crates/platform/src/windows/mod.rs` | Register `regutil`, `reboot`. |
| `crates/platform/Cargo.toml` (workspace) | Added `Win32_Storage_FileSystem` windows feature for `MoveFileExW`. |
| `crates/infra/src/paths.rs` | Added `program_data` + `maintenance_dir(all_users)` (ProgramData/LocalAppData maintenance root). |
| `crates/services/src/install_service.rs` | Rewrote integration step: copy self as `clippity-maintenance.exe`, real shortcuts (recorded), start-at-login, richer ARP entry, and **commit the installation manifest**. |
| `crates/services/src/uninstall_service.rs` | **Manifest-driven, safe uninstall:** delete only owned files, remove dirs only when empty (preserve unknown files), remove recorded shortcuts + scope-correct registry, self-remove maintenance dir with reboot fallback. Added safety unit tests. |
| `crates/services/src/manifest.rs` | Fixed product version drift (`1.5.0` → `0.1.0` to match the embedded payload) with a doc note. |
| `crates/services/src/payload.rs` | Added `sha256()` / `bytes()` accessors for the manifest. |
| `crates/services/src/lib.rs` | Register `clock`, `detect`, `state_store`. |
| `crates/domain/src/lib.rs` | Register `state`. |
| `src-tauri/src/app/commands.rs` | `get_install_status` now reads the real manifest; new `detect_installation` command. |
| `src-tauri/src/lib.rs` | Register `detect_installation`. |

## Changed files — frontend

| File | Change |
| --- | --- |
| `app/shared/src/contracts/index.ts` | Export the new `state` contract. |
| `app/frontend/src/services/installer.ts` | Added `detectInstallation()` wrapper. |
| `app/frontend/src/features/wizard/maintenance/MaintenanceHub.tsx` | Fetches real detection on mount; renders the state badge, version, and install location from it (falls back to the static catalog in browser preview). |

## Not changed (deliberately)

- The app's own Tauri MSI/NSIS bundle config (`app/.../tauri.conf.json`) — the
  ADR keeps it and coordinates rather than competing.
- The payload-embed pipeline (`stage-installer-payload.mjs`, `build.rs`) — works.
- The wizard's window/chrome, design system, and three-flow structure — reused.

---

# Second pass — 2026-07-24

The same scheduled task, continued: added the **transaction journal + rollback
executor + startup recovery** (Phase 13/14), a **real repair flow** (Phase 7),
the **command-line / silent-operation interface with stable exit codes**
(Phase 16), and **honest reboot reporting** through the progress event to the
Complete screen (follow-up). Verified with `cargo check --workspace`,
`pnpm check`, `cargo clippy`, and the domain + services suites — **73 tests
passing** (was 30; +43), 0 failures. No new clippy warnings introduced (two
pre-existing warnings remain in `registry.rs`/`uninstall_service.rs`, untouched).

## New files — backend

| File | Why |
| --- | --- |
| `crates/domain/src/journal.rs` | The operation journal: `OperationJournal`, `Action`/`ActionKind` (with intrinsic inverses), `Phase`, `Outcome`, and the pure `recover` recovery-decision rule. 12 unit tests. |
| `crates/domain/src/repair.rs` | Pure repair assessment: `FileHealth`, `assess_file` (missing/corrupt/mutable rules), `RepairAssessment`. 6 unit tests. |
| `crates/domain/src/cli.rs` | Pure command-line parser (`CliMode`, `Verbosity`, `CliCommand`, `parse`) + the stable `ExitCode` table + `help_text`. 14 unit tests. |
| `crates/services/src/journal_store.rs` | Persist/read/remove `operation.json` next to the manifest. 3 unit tests. |
| `crates/services/src/rollback.rs` | The rollback executor — reverse each recorded `Action` by its kind (delete created files, restore backups, remove keys/shortcuts, schedule-delete the maintenance exe). 5 temp-fs unit tests. |
| `crates/services/src/recovery.rs` | Startup recovery: `resolve_pending` auto-runs rollback/cleanup and surfaces resume/manual. 3 unit tests. |
| `crates/services/src/repair_service.rs` | Real repair: integrity scan (existence + SHA-256) → restore core exe from payload, re-create missing shortcuts, rewrite ARP entry; journalled; preserves user data + installed version. |
| `src-tauri/src/app/cli.rs` | Headless execution of silent commands → stable `ExitCode` (install/reinstall/modify/repair/update/uninstall), with elevation and already-installed/downgrade guards. |

## Changed files — backend

| File | Change |
| --- | --- |
| `crates/domain/src/lib.rs` | Register `cli`, `journal`, `repair`. |
| `crates/domain/src/progress.rs` | Added `ProgressKind::Repair` + repair checklist; added `reboot_required` to `ProgressEvent` (+ `with_reboot_required`). |
| `crates/domain/src/state.rs` | Added `InstallationManifest::install_date_yyyymmdd()` so repair rewrites the ARP entry with the *original* install date. |
| `crates/services/src/lib.rs` | Register `journal_store`, `recovery`, `repair_service`, `rollback`. |
| `crates/services/src/clock.rs` | Added a `compact` (`YYYYMMDDHHMMSS`) stamp for operation ids. |
| `crates/services/src/detect.rs` | Added `scan_pending_operation` + `PendingOperation` (find a leftover journal and its recovery decision). |
| `crates/services/src/install_service.rs` | **Rewrote as a real transaction:** open a journal, record every mutating action with its inverse, advance phases, and **roll back automatically on any failure**; clean the `.old` backup after commit. |
| `crates/services/src/uninstall_service.rs` | Terminal progress event now carries `reboot_required` so the Complete screen reports it honestly. |
| `crates/platform/src/windows/shortcuts.rs` + `windows_ops.rs` | Added `create_shortcut_at(path, target)` — the precise repair primitive to restore a `.lnk` at its exact recorded path. |
| `src-tauri/src/lib.rs` | `run()` now parses the CLI and dispatches (help/version/silent-headless/GUI), returns a process exit code; registers `assess_repair`, `run_repair`, `check_recovery`. |
| `src-tauri/src/main.rs` | Propagate the process exit code. |
| `src-tauri/src/app/mod.rs` + `commands.rs` | Register `cli`; add `assess_repair`, `run_repair`, `check_recovery` commands. |

## Changed files — frontend

| File | Change |
| --- | --- |
| `app/shared/src/contracts/progress.ts` | Added `repair` to `ProgressKind`; added optional `rebootRequired` to `ProgressEvent`. |
| `app/frontend/src/state/wizardStore.ts` | Added the `repair` checklist + `rebootRequired` on `ProgressState`. |
| `app/frontend/src/features/wizard/components/ProgressStep.tsx` | Added the `repair` progress copy. |
| `app/frontend/src/features/wizard/components/CompleteStep.tsx` | Show a "restart required to finish" notice when `progress.rebootRequired`. |

# Third pass — 2026-07-24 (Restart Manager / graceful lock-clearing, Phase 8/10)

Turned the largest remaining ⚠️ deliverable (#8, graceful shutdown / locked-file
handling) into a real, tested implementation. Verified with
`cargo check --workspace` (0 errors) and the domain + services suites — now
**87 tests** (domain 67, services 20), all passing; no new clippy warnings.

## New files — backend

| File | Why |
| --- | --- |
| `crates/domain/src/shutdown.rs` | **Pure, unit-tested policy** for locked-file handling: `LockingProcess`, `RmAppKind`, `ProcessOwnership`, `classify`, `ShutdownPlan::from_locks`, `path_is_within`. Decides which holders are Clippity-owned (may stop), system/Explorer (never), or unrelated (surface). 12 tests. |
| `crates/platform/src/windows/restart_manager.rs` | Real Windows **Restart Manager** wrapper: `enumerate_lockers` (`RmStartSession`/`RmRegisterResources`/`RmGetList`/`RmEndSession` with an RAII session guard + `QueryFullProcessImageNameW` path resolution) and `terminate` (`TerminateProcess`, the controlled fallback). Signatures read from the vendored `windows` 0.62.2 source. |
| `crates/services/src/shutdown.rs` | `clear_locks` glue: enumerate → build the domain plan → terminate owned non-self holders → report unrelated blockers. 2 cross-platform tests. |

## Changed files — backend

| File | Change |
| --- | --- |
| `crates/domain/src/lib.rs` | Register `shutdown`. |
| `crates/platform/src/windows/mod.rs` | Register `restart_manager`. |
| `crates/platform/src/windows_ops.rs` | Facade: `enumerate_lockers` + `terminate_process` (empty/no-op off-Windows). |
| `crates/services/src/lib.rs` | Register `shutdown`. |
| `crates/services/src/uninstall_service.rs` | `processes` step now clears app locks via Restart Manager (stops the running Clippity); `remove_owned_files` schedules a still-locked file — then its now-empty directory — for reboot deletion and returns whether a reboot was deferred, threaded into `reboot_required`. |
| `Cargo.toml` (workspace) | Added the `Win32_System_RestartManager` windows feature. |

## Still not done (see final report)

- Real update download/apply (coordinate with the Tauri updater — ADR).
- Component-level modify/repair (monolithic payload).
- Graceful-shutdown **IPC** (the state-saving precursor to termination) and the
  native cleanup worker. *(Restart Manager enumeration + owned-process
  termination + reboot deferral are now done — third pass.)*
- Narrow elevated worker; Authenticode signing; the asInvoker manifest fix.
- Full frontend repair/recovery *flows*, and a "close these apps" prompt driven
  by the new `blocking_apps` report (backend + commands + CLI are done; the
  maintenance-hub screens that drive them are a follow-up).
