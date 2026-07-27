# Lifecycle Modes, Detection, Transactions & Recovery

Status: Detection, safe uninstall, **real repair**, a **transaction journal
with a rollback executor**, and **startup recovery** implemented; component-
level modify and real update still partial / documented. Covers task Phases 6,
7, 13, 14.

> **Second pass (2026-07-24).** The journal, the rollback executor, the real
> repair flow, startup recovery, and honest reboot reporting described below
> were added after the first pass. See
> [08-changelog.md](08-changelog.md#second-pass--2026-07-24) for the file-level
> list.

## Detection (Phase 6) — implemented

[`installer_services::detect::detect`](../../installer/app/backend/crates/services/src/detect.rs)
gathers three independent signals and reconciles them with the pure
[`assess`](../../installer/app/backend/crates/domain/src/state.rs) rule (which is
unit-tested):

| Signal | Source |
| --- | --- |
| Manifest present + version + exe path | `install-state.json` in either maintenance dir |
| Registry present + is-ours | `Uninstall\Clippity` in HKLM then HKCU + ownership marker |
| Exe present | the manifest's recorded primary exe exists on disk |

Resolved `InstallState`s and their routing:

| State | Meaning | Wizard offers |
| --- | --- | --- |
| `not-installed` | no trace | Fresh install |
| `healthy` / `same-version` | manifest+registry+exe agree at this version | Modify / Repair / Uninstall |
| `older-version` | installed older than the wizard carries | Update / Reinstall |
| `newer-version` | installed newer than the wizard | Refuse silent downgrade |
| `damaged` | recorded but exe/registration missing/corrupt | Repair |
| `partial` | manifest XOR registry present (interrupted op), or schema too new | Recovery |
| `legacy-unmanaged` | foreign `Uninstall\Clippity` with no manifest (MSI/NSIS legacy) | Migration |

**The rule prefers recovery when sources disagree** — a manifest whose schema is
too new, or a manifest-without-registry, becomes `partial`, never `healthy`.
Exposed to the UI via the `detect_installation` command; the maintenance hub
renders the state badge, version, and install location from it.

## Fresh install (Phase 7) — implemented (core)

The install service walks the domain checklist performing real work at each step:
verify payload (size + SHA-256) → write `Clippity.exe` (renaming a locked
existing one to `.old`) → apply integrations (maintenance-exe copy, shortcuts,
start-at-login, ARP entry) → write the manifest. Elevation is requested only when
the destination or scope needs it, via the existing handoff-file relaunch so the
user sees one wizard and at most one UAC prompt.

The install now runs **as a real transaction** (see "Transactions & rollback"
below): each mutating step records its inverse in an operation journal, and a
failure at any step rolls the applied actions back so a failed install leaves
the machine as it found it rather than a half-written directory + dangling ARP
entry.

**Implemented:** existing-install awareness (detection), disk sizing estimate,
scope selection, elevation-on-demand, payload verify, staged-then-registered
ordering, manifest commit, **journalled actions + automatic rollback on
failure**, **`.old` backup cleaned after a committed install**.
**Not yet:** OS/arch precondition checks, free-disk check against the estimate,
post-write integrity re-verify + launch-test before declaring success.

## Modify / Repair / Update / Reinstall (Phase 7)

| Mode | Today | Gap |
| --- | --- | --- |
| **Modify** | Runs the full-payload install path with modify labels; manifest records selected components; journalled + rollback-protected | True per-component add/remove needs a decomposed payload or MSI features |
| **Repair** | **Implemented.** Real integrity scan (existence + SHA-256 vs manifest) → restore the core exe from the embedded payload, re-create missing shortcuts at their recorded paths, rewrite the ARP entry if gone — preserving the *installed* version and all user data. Journalled for crash-detection. | Non-core components share the monolithic payload, so a broken non-core file is restored with core rather than independently (reported in the log) |
| **Update** | Version compare is real; check surfaces availability | Download/verify/apply/rollback is still simulated — see below and the ADR |
| **Reinstall** | Reinstall-over works (exe rename-away + re-register), journalled | Preserve/reset/clean variants + user-data backup/restore not yet split out |

**Repair details:** the pure classification is
[`installer_domain::repair::assess_file`](../../installer/app/backend/crates/domain/src/repair.rs)
(unit-tested: missing-immutable → `Missing`, hash-mismatch → `Corrupt`, a
**mutable** file is never repaired so repair never fights the app over its own
data). The service
([`repair_service`](../../installer/app/backend/crates/services/src/repair_service.rs))
performs the I/O and is reachable three ways: the `run_repair` / `assess_repair`
Tauri commands, and the `--repair` CLI mode.

**Update coordination (ADR decision):** the app already ships a Tauri updater
with a real minisign pubkey. The wizard must not run a second divergent auto-
update channel. Until an update server + signed metadata exist, the wizard's
update path is labelled unavailable rather than faked. The `check` currently
compares the installed manifest version against the wizard's carried version
(now consistent at `0.1.0`), so it honestly reports "up to date".

## Uninstall (Phase 7) — implemented (safe)

Manifest-driven and conservative (see
[03-installation-model.md](03-installation-model.md) for the safety rules):
remove owned files → remove recorded shortcuts → remove ARP entry + start-at-
login value from the recorded hive → remove manifest → self-remove the
maintenance dir (reboot fallback for the locked running exe). Unknown files are
preserved. Graceful process shutdown (Phase 8) and the full native cleanup
worker (Phase 9) are documented follow-ups in
[05-self-removal-and-locked-files.md](05-self-removal-and-locked-files.md).

## Transactions & rollback (Phase 13) — implemented

Every mutating operation now runs through a persisted **operation journal**
([`installer_domain::journal`](../../installer/app/backend/crates/domain/src/journal.rs),
persisted by
[`journal_store`](../../installer/app/backend/crates/services/src/journal_store.rs)
as `operation.json` next to the manifest). The lifecycle is:

```
Detect → Validate → Plan → Stage → Apply → Verify → Commit → Cleanup
```

Each mutating step records an `Action` carrying the **inverse that undoes it**
(`CreateFile → delete`, `ReplaceFile → restore backup`, `WriteRegistryKey →
delete key`, `CreateShortcut → delete`, `PlaceMaintenanceExe → schedule-delete
on reboot`, `WriteManifest → remove`, `CreateDirectory → remove-if-empty`). The
journal is flushed after every phase change and recorded action, so a crash
leaves a truthful record.

Realised:

- **Stage-before-commit** for the payload (verify before any disk write; rename
  the old exe aside as a restorable `ReplaceFile` backup rather than overwrite in
  place).
- **The manifest write is the commit boundary** — recorded, and reversed on
  rollback like any other action.
- **Automatic rollback on failure.** `install_service::run` wraps its mutating
  steps; any error triggers
  [`rollback::roll_back`](../../installer/app/backend/crates/services/src/rollback.rs),
  which walks the journal's applied actions **newest-first** and reverses each by
  its kind, then marks the journal `RolledBack`. Reversal is conservative — a
  replace/delete with no surviving backup is logged and skipped, never
  fabricated, so rollback can't destroy data it can't put back. (Unit-tested with
  real temp-fs: create-file reversal deletes, replace-file reversal restores the
  backup, a backup-less replace leaves the current file untouched, a directory is
  removed only when empty.)
- **`.old` cleanup** after a committed install.

The pure recovery decision —
[`installer_domain::journal::recover`](../../installer/app/backend/crates/domain/src/journal.rs)
— encodes the safety boundary and is fully unit-tested:

| Journal state | Decision | Why |
| --- | --- | --- |
| interrupted before `Apply` | `Resume` | no live mutation happened |
| interrupted during `Stage`/`Apply`/`Verify` | `RollBack` | partial, uncommitted mutations exist |
| interrupted at `Commit` | `Resume` (roll *forward*) | reversing a half-authoritative op is riskier than finishing it; commit steps are idempotent |
| `Committed` but not cleaned | `Cleanup` | only leftovers remain |
| `Failed` | `RollBack` | reverse what was applied |
| unreadable schema | `ManualRecovery` | never auto-act on a shape we don't understand |

## Recovery (Phase 13/14) — implemented

On launch,
[`detect::scan_pending_operation`](../../installer/app/backend/crates/services/src/detect.rs)
scans the maintenance directories for a leftover `operation.json` (its mere
presence means an operation didn't finish), and
[`recovery::resolve_pending`](../../installer/app/backend/crates/services/src/recovery.rs)
acts on the pure decision:

- `RollBack` → run the rollback executor, then drop the journal.
- `Cleanup` → clear the finished operation's leftovers.
- `Resume` / `ManualRecovery` → **surfaced, never auto-acted** (the operation's
  plan is not persisted, so re-driving it needs the user's intent).

Exposed to the frontend via the `check_recovery` command (called by the hub on
mount). Verified end-to-end by a temp-fs test: a journal that died mid-`Apply`
having created one file is rolled back (the file is deleted) and the journal is
cleared.

## User-data protection (Phase 14) — implemented at the policy layer

The uninstall data model already separates non-destructive machinery (removed by
default) from destructive user content (captures, projects, credentials — kept
unless explicitly opted in, and gated behind the Review step's acknowledgement).
The file-removal steps never touch `%APPDATA%`/`%LOCALAPPDATA%` user content or
any user-chosen capture folder — those are governed solely by the data-category
selection. Recursive deletion of a user content root is impossible by
construction (no code path passes such a path to `remove_dir_all`).
