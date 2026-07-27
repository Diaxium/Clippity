# Final Report — Clippity Windows Setup & Maintenance Wizard Upgrade

Date: 2026-07-24 · Scheduled task: "installer-big-task" · Run: autonomous (user
not present). Environment: this session had a real toolchain (Rust 1.96, Node 26,
pnpm 11) and the vendored `windows` 0.62.2 crate, but **no interactive Windows
desktop or disposable VM**, so runtime install/uninstall smoke testing on a live
machine was not performed (it is called out as required manual work). All
compile-time and unit-test verification was run and passed.

## Executive summary

The Clippity installer was, before this pass, a **high-quality UI prototype**: a
custom Tauri wizard with a real payload-copy core and real elevation, but with
**stubbed Windows integrations** (registry, shortcuts, start-at-login all
log-only) and a **simulated** update/maintenance layer, no installation state, no
detection, no repair/rollback, and an **unsafe blunt uninstall** that could
delete unrelated files in a shared directory.

This pass turned the highest-value, safest pieces into a **real installation
system**, without the VM-gated rewrite that a full engine swap would require, and
documented a staged migration of the transactional core onto Windows Installer
(MSI/WiX). Concretely, it now:

- **Registers with Windows for real** — a scope-aware (HKCU/HKLM) Add/Remove
  Programs entry with the full documented value set, whose Uninstall/Modify
  buttons run a maintenance executable that is actually placed on disk.
- **Creates real shortcuts** (desktop + Start menu via COM) and a real
  start-at-login `Run` value.
- **Keeps an authoritative on-disk installation manifest** (`install-state.json`)
  — the single shared model for detect / modify / repair / uninstall.
- **Detects** installation health by correlating manifest + registry + on-disk
  exe through a unit-tested state machine, and drives the maintenance hub from it.
- **Uninstalls safely** — manifest-driven, deleting only owned resources,
  preserving unknown files, never blindly recursing a shared path, with a
  reboot-scheduled fallback for the locked running uninstaller.

Everything compiles (`cargo check --workspace` + `pnpm check`) and the domain +
services suites pass (**28 tests**, including new detection, clock, and the two
critical uninstall-safety tests).

## Deliverables (task's required-final-deliverables list)

| # | Deliverable | Status |
| --- | --- | --- |
| 1 | Current-state installer audit | ✅ [01](01-current-state-audit.md) |
| 2 | Architecture decision record | ✅ [02](02-architecture-decision.md) |
| 3 | Structured implementation plan | ✅ across [03](03-installation-model.md)–[06](06-security-cli-logging.md) |
| 4 | Implemented source changes | ✅ [08 changelog](08-changelog.md) |
| 5 | Package/component manifest | ✅ `domain/state.rs` + `services/state_store.rs` |
| 6 | Windows registration implementation | ✅ `platform/windows/registry.rs` + `regutil.rs` |
| 7 | Maintenance-state implementation | ✅ `install-state.json` model + store + detection |
| 8 | Graceful shutdown integration | ✅ **3rd pass:** Windows Restart Manager enumerates lockers, stops Clippity-owned holders, surfaces unrelated apps, reboot-defers still-locked files (unit-tested policy). ⚠️ the state-saving shutdown *IPC* precursor remains |
| 9 | Safe cleanup-worker implementation | ⚠️ interim reboot-based self-removal implemented; native worker designed, not built |
| 10 | Transaction and rollback system | ✅ **2nd pass:** persisted operation journal + inverse actions + rollback executor + startup recovery; install auto-rolls-back on failure (unit-tested) |
| 11 | Update & package-verification improvements | ⚠️ payload verify real; signed-download update pending (coordinate w/ Tauri updater) |
| 12 | Complete wizard UI states | ⚠️ **2nd pass:** repair engine + reboot-notice wired; per-mode UI *flows* (repair/recovery screens) still pending |
| 13 | Silent-operation support | ✅ **2nd pass:** pure CLI parser + headless execution + stable exit-code table (unit-tested); console-text + full-width exit code are caveated follow-ups |
| 14 | Automated tests | ✅ **73 tests** (2nd pass: +43 — journal, repair, cli, rollback, recovery, journal-store) |
| 15 | Manual Windows test matrix | ✅ [07](07-test-matrix.md) |
| 16 | Updated documentation | ✅ this `docs/installer/` set |
| 17 | Detailed final report | ✅ this document |
| 18 | Remaining risks and limitations | ✅ below |
| 19 | Follow-up improvements not completed | ✅ below |
| 20 | Evidence of install/…/uninstall testing | ⚠️ compile + unit-test evidence (below); live-VM runtime testing is required manual work |

## Per-requirement detail (what / where / why / test / result / limits)

### Real Add/Remove Programs registration
- **What:** replaced the log-only registry stub with real HKCU/HKLM writes of the
  full documented ARP value set + an ownership marker; scope-aware removal.
- **Where:** `platform/windows/registry.rs`, `platform/windows/regutil.rs`,
  `platform/entry.rs`.
- **Why:** the wizard never actually appeared in Settings › Apps, and Windows had
  no working `UninstallString`.
- **Tested:** `cargo check` (against verified `windows` 0.62.2 signatures);
  detection unit tests exercise the presence/marker logic paths.
- **Result:** compiles; logic tested. **Limit:** live-registry round-trip not run
  in this headless session — see the manual matrix.

### Real shortcuts + start-at-login
- **What:** desktop + Start-menu `.lnk` via `IShellLinkW`/`IPersistFile`, folders
  via `SHGetKnownFolderPath`; `Run`-key start-at-login; created paths recorded in
  the manifest for precise removal.
- **Where:** `platform/windows/shortcuts.rs`, `registry.rs::set_start_at_login`.
- **Why:** shortcuts/startup were log-only.
- **Tested:** compiles; paths recorded/removed via manifest, exercised by the
  uninstall tests' shortcut plumbing.
- **Limit:** COM `.lnk` creation not run on a live desktop here.

### Installation manifest + detection
- **What:** the `InstallationManifest` shared model, its store, and the `assess`
  detection state machine; `detect_installation` command; hub reads it.
- **Where:** `domain/state.rs`, `services/state_store.rs`, `services/detect.rs`,
  `src-tauri/app/commands.rs`, `MaintenanceHub.tsx`.
- **Why:** there was no installation state and no detection at all.
- **Tested:** 8 `assess` unit tests (all states incl. schema-too-new, legacy,
  partial, damaged, version comparisons); clock conversion tests; `cargo check`
  + `pnpm check` for the command/contract wiring.
- **Result:** ✅ passing. **Limit:** component list is recorded but not yet backed
  by independent on-disk resources (monolithic payload).

### Safe, manifest-driven uninstall
- **What:** delete only owned files; remove directories only when empty; preserve
  unknown files; scope-correct registry + shortcut removal; reboot-scheduled
  fallback for the locked maintenance exe.
- **Where:** `services/uninstall_service.rs`, `platform/windows/reboot.rs`.
- **Why:** the old uninstall `remove_dir_all`'d the install dir unconditionally —
  dangerous on a shared/pre-existing folder.
- **Tested:** `owned_files_are_removed_but_unknown_files_are_preserved` and
  `empty_install_dir_is_removed_after_owned_files` (real-fs temp-dir tests).
- **Result:** ✅ passing — the "don't delete unrelated files" guarantee is proven.

### Version-drift fix
- **What:** product version `1.5.0` → `0.1.0` to match the embedded payload.
- **Where:** `services/manifest.rs`.
- **Why:** detection/update-check compared against a version the binary wasn't.
- **Tested:** `cargo check`; update-availability logic now honest.

## Evidence

- `cargo check --workspace` → **Finished, 0 errors** (installer backend).
- `pnpm check` → shared `tsc` **Done**, frontend `tsc -b` **Done**, backend cargo
  **Done**.
- `installer-domain` tests → **55 passed** (2nd pass added journal, repair, and
  cli suites). `installer-services` tests → **18 passed** (incl. the two
  uninstall-safety tests + the new rollback, recovery, and journal-store tests).
  Total **73 passed, 0 failed** (was 30 after the first pass). Run via the rename
  workaround for UAC-blocked `installer_*` binaries.
- `cargo clippy` on domain/services/platform → clean for all new code (two
  pre-existing warnings in untouched `registry.rs`/`uninstall_service.rs` remain).
- All Win32 signatures used (registry, COM shortcuts, `MoveFileExW`,
  `SHGetKnownFolderPath`) were read from the vendored `windows` 0.62.2 source
  before use, not assumed.

## Second pass (2026-07-24) — transaction engine, repair, CLI, reboot reporting

A continuation of the same task turned four of the first pass's `⚠️` gaps into
real, tested implementations. Full file list:
[08-changelog.md](08-changelog.md#second-pass--2026-07-24).

### Transaction journal + rollback + recovery (deliverable #10)
- **What:** a persisted `operation.json` records each mutating action with its
  intrinsic inverse; a rollback executor reverses them newest-first; a pure
  `recover` rule classifies an interrupted operation (resume / roll back /
  cleanup / manual); startup `resolve_pending` auto-acts on the safe ones. The
  **fresh install now auto-rolls-back on any step failure** instead of leaving
  partial state.
- **Where:** `domain/journal.rs`, `services/{journal_store,rollback,recovery}.rs`,
  `services/install_service.rs` (rewritten), `services/detect.rs`.
- **Tested:** 12 journal + 5 rollback (real temp-fs reversals) + 3 recovery + 3
  journal-store unit tests, incl. "a partial install that died mid-Apply is
  rolled back and the created file is deleted". **Result:** ✅ passing.
- **Limit:** the rollback executor is correct for install/modify (create/replace);
  uninstall is not journalled (its removals have no backup to reverse — re-run is
  the recovery). Roll-*forward* resume of a specific plan is surfaced, not
  automated (the plan isn't persisted in the journal).

### Real repair (Phase 7)
- **What:** integrity scan (existence + SHA-256 vs the manifest) → restore the
  core exe from the embedded payload, re-create missing shortcuts at their exact
  recorded paths, rewrite the ARP entry if absent — preserving user data and the
  *installed* version (never a covert upgrade). Reachable via the `run_repair` /
  `assess_repair` commands and `--repair`.
- **Where:** `domain/repair.rs`, `services/repair_service.rs`,
  `platform/.../shortcuts.rs::create_shortcut_at`, `commands.rs`.
- **Tested:** 6 domain assessment tests (missing/corrupt/mutable-never-repaired);
  `cargo check` + `pnpm check` for the command wiring. **Result:** ✅.
- **Limit:** the monolithic payload means a broken *non-core* file is restored
  with core rather than independently (logged, honest).

### CLI + silent operation + stable exit codes (deliverable #13)
- **What:** a pure parser + a stable `ExitCode` table + headless execution of
  silent commands; `lib.rs::run()` dispatches help/version/silent/GUI and returns
  a process exit code. The ARP `--uninstall`/`--modify`/`--silent` strings the
  registry already emits are now honoured.
- **Where:** `domain/cli.rs`, `src-tauri/src/app/cli.rs`, `src-tauri/src/lib.rs`,
  `main.rs`.
- **Tested:** 14 parser/exit-code unit tests. **Result:** ✅. **Limit:** GUI
  subsystem means `--help`/`--version` text isn't console-attached, and the
  shell sees the low byte of the code — both caveated in
  [06](06-security-cli-logging.md) with the fix.

### Honest reboot reporting (follow-up)
- **What:** `ProgressEvent.reboot_required` threads from the uninstall finalize
  step through the store to a "restart required to finish" notice on the Complete
  screen — no more unqualified success when a locked file was deferred to reboot.
- **Where:** `domain/progress.rs`, `services/uninstall_service.rs`,
  `shared/.../progress.ts`, `state/wizardStore.ts`, `components/CompleteStep.tsx`.
- **Tested:** `pnpm check`. **Result:** ✅.

## Third pass (2026-07-24) — Restart Manager & graceful lock-clearing (Phase 8/10)

Turned the largest remaining `⚠️` (deliverable #8) into a real, tested
implementation, and improved the locked-file path it feeds.

### Restart Manager enumeration + owned-process shutdown (deliverable #8)
- **What:** before uninstall deletes the application, the engine asks Windows
  **Restart Manager** exactly which processes hold the manifest's owned files
  open, then stops the *Clippity-owned* ones so removal succeeds instead of
  deferring to a reboot. Unrelated user applications and Explorer/critical
  processes are **never** force-closed — they are classified out and surfaced.
  A pure state machine makes the "who may we stop" decision testable without a
  live desktop; the Win32 calls are a thin wrapper over it.
- **Where:** `domain/shutdown.rs` (pure policy: `classify`,
  `ShutdownPlan::from_locks`, `path_is_within`), `platform/windows/restart_manager.rs`
  (`RmStartSession`/`RmRegisterResources`/`RmGetList`/`RmEndSession` +
  `QueryFullProcessImageNameW` + `TerminateProcess`), `platform/windows_ops.rs`
  (facade), `services/shutdown.rs` (`clear_locks` glue),
  `services/uninstall_service.rs` (wired into the `processes` step),
  `Cargo.toml` (`Win32_System_RestartManager` feature).
- **Tested:** 12 domain classification tests (Explorer-never-owned,
  component-wise path containment vs. sibling-prefix, self/owned/unrelated
  bucketing, plan gating) + 2 services tests (unlocked file → empty report).
  All Win32 signatures were read from the vendored `windows` 0.62.2 source
  before use. **Result:** ✅ passing; `cargo check --workspace` clean; no new
  clippy warnings.
- **Limit:** the *live* enumeration/termination side effects are not exercisable
  in this headless session — only the pure policy is unit-tested; a real
  running-app uninstall on a desktop is manual-matrix work. The graceful
  shutdown **IPC** (state-saving precursor) is still pending; force-termination
  is the bounded fallback.

### Honest locked-file reboot deferral (Phase 10, step 7–8)
- **What:** `remove_owned_files` no longer just warns when a file is still
  locked — it schedules the file (then its now-empty directory, in the correct
  child-before-parent order) for deletion at the next reboot via `MoveFileExW`,
  and returns whether a reboot was deferred so the Complete screen reports it.
- **Where:** `services/uninstall_service.rs`.
- **Tested:** `cargo check` + the existing uninstall-safety suite (unknown files
  still preserved). **Result:** ✅.

## Remaining risks & limitations

1. **No live-VM runtime test in this run.** Registry/COM/shortcut side effects
   compile and their logic is tested, but a real install→inspect→uninstall→
   inspect cycle on Windows (the manual matrix) must be run before shipping. In
   this session the built wizard binary was **refused execution unelevated** by
   Windows' installer-detection heuristic, which both blocked a runtime CLI
   smoke-test *and* surfaced a real risk (next item).

2. **Installer-detection auto-elevation (new finding).** The wizard exe trips the
   UAC installer-detection heuristic (embedded payload + "install/setup" strings)
   and is auto-elevated. If the shipping `Clippity Setup.exe` behaves the same, it
   defeats the per-user no-UAC path. Fix: embed an `asInvoker` application
   manifest. Not applied blind (unverifiable here, may collide with Tauri's
   bundler manifest) — a priority for the first real-machine test. Details in
   [06-security-cli-logging.md](06-security-cli-logging.md#least-privilege-elevation-phase-12).
3. **Update apply is still simulated.** Do not ship the wizard's update as real;
   coordinate with the app's existing Tauri updater first (ADR). The headless
   `--update` honestly returns `GeneralFailure` with a "not yet implemented" log
   rather than faking success.
4. **Component-level modify/repair is not truthful yet** — the payload is
   monolithic. Either decompose it or move to MSI features.
5. **No graceful-shutdown IPC (Restart Manager now done).** *Resolved in the
   third pass:* Restart Manager enumerates exactly which processes lock a target
   file, the engine force-stops the Clippity-owned holders (never unrelated or
   Explorer/critical), and a file still locked afterwards is scheduled for reboot
   deletion. *Still open:* an authenticated maintenance-shutdown **IPC** to the
   running app so it can stop captures and save state *before* it is terminated —
   force-termination is the bounded fallback until then.
6. **No native cleanup worker** — the maintenance dir self-removes via reboot
   scheduling rather than immediately.
7. **Resume is surfaced, not automated.** Interrupted operations are now detected,
   *rolled back* where safe (install/modify), and cleaned; but rolling *forward* a
   specific interrupted plan is surfaced to the user rather than auto-run, because
   the plan is not persisted in the journal.
8. **Elevation still runs the whole GUI elevated** — the narrow elevated-worker
   split is designed, not built. See also the auto-elevation finding (risk #2).
9. **Signing not configured** in the repo for the wizard/maintenance exe.

Resolved since the first pass (no longer risks): the persisted operation journal,
automatic rollback of a failed install, the real repair flow, silent operation +
exit codes, and honest reboot reporting — all now implemented and tested.

## Recommended follow-ups (priority order)

1. Run the manual Windows test matrix on a disposable VM / Windows Sandbox;
   capture before/after registry + filesystem snapshots as shipping evidence.
   **First:** verify/fix the installer-detection auto-elevation (embed an
   `asInvoker` manifest) — risk #2.
2. Add the pre-commit backup + post-write integrity re-verify + launch-test to
   install/update (the journal + rollback executor are now in place to carry it).
3. ~~Implement Restart Manager enumeration~~ (done, 3rd pass) + an authenticated
   maintenance-shutdown IPC to the running app so it saves state before being
   stopped, and a "close these apps" prompt driven by the new `blocking_apps`
   report (Phase 8/10).
4. Build the signed native cleanup worker (Phase 9).
5. Wire the frontend repair/recovery *flows* onto the maintenance hub (the
   backend engine, commands, and CLI are done).
6. Persist the operation's plan in the journal so `Resume` can auto-run, not just
   be surfaced (Phase 13).
7. Split out the narrow elevated worker with a restricted command schema
   (Phase 12).
8. Configure Authenticode signing (SignTool + timestamp) for the Setup and
   maintenance executables; share the updater trust root (Phase 15).
9. Decide the MSI/WiX cutover (ADR Option-C target) and implement legacy-install
   adoption/supersede using `installationId`.

## Fourth pass (2026-07-24 evening) — live-machine runtime verification + three fixes

The first real end-to-end run on a live Windows 11 desktop (the "no live-VM
runtime test" gap, risk #1). Built the whole chain fresh (`pnpm dist` → app +
portable + payload + `Clippity Setup.exe`, 56.3 MB) and drove the **shipping
binary** through a full per-user lifecycle exactly as the Add/Remove Programs
buttons invoke it. This surfaced and fixed three real defects that only a
runtime test could expose.

### 1. Installer-detection auto-elevation — FIXED (was risk #2)
- **Symptom:** the built exe was refused execution unelevated (`os error 740`)
  even renamed; extracting its manifest showed Tauri's default carries only the
  Common-Controls dependency — **no `requestedExecutionLevel`** — so Windows'
  installer-detection heuristic auto-elevated the large, payload-embedding
  "Setup" exe, defeating the no-UAC per-user path.
- **Fix:** `src-tauri/build.rs` now embeds a custom manifest
  (`src-tauri/windows-app-manifest.xml`) declaring `asInvoker` (+ the retained
  Common-Controls dependency) via `tauri_build::Attributes::windows_attributes`.
  Confirmed: the rebuilt exe runs unelevated and a per-user install/modify/
  repair/uninstall never prompts for UAC.

### 2. Modify corrupted the manifest's install directory — FIXED
- **Symptom:** after a `--modify` invoked without `--install-dir` (i.e. the ARP
  "Modify" button, `clippity-maintenance.exe --modify`), the manifest's
  `install_directory` (and `directories[0]`, and the ARP `InstallLocation`) was
  rewritten to the **default** `C:\Program Files\Clippity` instead of the real
  per-user location, because `install_service::apply_integrations` recorded
  `paths.install_dir` (the CLI/default) rather than the actual destination. A
  subsequent `--repair` then tried to restore into Program Files and failed with
  access-denied; uninstall mis-targeted the install dir.
- **Fix:** `install_service::run` now pins a corrected `install_paths.install_dir
  = plan.options.destination` and passes it to `apply_integrations`, so the
  manifest + ARP always record the true location. (`files[]` paths were already
  correct — they derive from the installed exe.)

### 3. Transient AV file-locks + repair backup leftover — FIXED
- **Symptom:** a freshly written unsigned 41 MB `Clippity.exe` is briefly held
  by Defender's real-time scan, so an immediate delete (uninstall) or rewrite
  (repair) can fail with a spurious access-denied; the per-user (unelevated) path
  cannot reboot-schedule the deletion, so the file was silently orphaned.
  Separately, repair left a `Clippity.exe.old` behind (only install/modify
  cleaned their backup), which then blocked the install dir from being removed on
  uninstall.
- **Fix:** new `installer_infra::retry::with_retry` (bounded backoff, retries
  only `ACCESS_DENIED`/`SHARING_VIOLATION`/`LOCK_VIOLATION`; unit-tested) now
  wraps the transient FS ops in `Payload::install_to` and
  `uninstall_service::remove_owned_files`; `repair_service` now cleans its
  `.old` backup after a committed restore.

### Verified end-to-end (shipping binary, per-user, ARP-style invocation)
Install → Modify (components change, **install dir preserved**) → Repair
(corrupt→restore, SHA matches, no leftover) → Update (up-to-date) → Uninstall.
Every stage exit 0; final machine state fully clean — install dir, maintenance
dir, `install-state.json`, HKCU ARP entry, both shortcuts, and start-at-login all
removed, no residue. Installed `Clippity.exe` SHA matches the payload and the app
launches. Test suite after the fixes: **78 pass** (3 infra + 55 domain + 20
services), `cargo check` clean.

**Remaining runtime limitations (unchanged, documented):**
- The *running* maintenance exe still cannot delete itself on a per-user
  uninstall (self-lock + no admin to reboot-schedule) — it and its dir are left
  until reboot/manual cleanup (native cleanup worker, risk #6/#9, still pending).
  An uninstall driven from an external copy removes them cleanly.
- GUI screens past the first mount could not be screenshotted in this pass: the
  headless browser pane does not composite frames, so framer-motion's
  `AnimatePresence mode="wait"` transition stalls. Store routing for all three
  flows and the initial Setup screen were verified; the shipping Tauri window is
  unaffected (it composites normally).

## Notes for the maintainer

- Not a git repo ([clippity-not-a-git-repo]) — no commit was made; changes are on
  disk only.
- Running the Rust tests requires the rename workaround for `installer_*`
  binaries ([installer-uac-exe-naming]); documented in the installer README and
  the test matrix.
- The wizard remains fully browser-previewable — the new detection call resolves
  `undefined` outside Tauri and the hub falls back to the static catalog.
