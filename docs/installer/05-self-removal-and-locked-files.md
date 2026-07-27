# Self-Removal, Locked Files & Reboot Handling

Status: Interim implementation + full design. Covers task Phases 8, 9, 10.

> **Update (2026-07-24, third pass):** Windows **Restart Manager** is now
> implemented (Phase 8/10). The engine enumerates exactly which processes hold
> a target file, stops the **Clippity-owned** ones as a controlled fallback,
> and surfaces any unrelated application it will not close. A file still locked
> after that is scheduled for reboot deletion (not left behind), and the
> uninstall reports the reboot honestly. See
> [Graceful shutdown](#graceful-shutdown-phase-8--restart-manager-implemented)
> below. Still pending: the authenticated shutdown *IPC* to the running app
> (state-saving precursor) and the native cleanup worker (Phase 9).

## The problem

A running executable cannot reliably delete itself and its own directory. The
uninstaller (`clippity-maintenance.exe`) runs from the maintenance directory,
which uninstall must remove. Two things are needed: a way to release the app's
own file locks (graceful shutdown), and a way to remove the still-running
uninstaller.

## Graceful shutdown (Phase 8) — Restart Manager implemented

Intended sequence before any file operation that touches app files:

```
Maintenance engine
  → request maintenance shutdown over authenticated local IPC
  → Clippity stops captures/recordings, saves state
  → tray, overlay, workers, sidecars, child processes exit
  → maintenance operation proceeds
```

Processes to account for (from the app's architecture): main app, system-tray
process, capture overlay, recording process, background workers, updater, model
(ONNX) processes, sidecars. Forceful termination is a **controlled fallback for
Clippity-owned processes only** — never unrelated user apps, never Explorer
unless unavoidable.

**Realised today:** the install/update path already tolerates a running app by
renaming its locked `Clippity.exe` to `.old` before writing the new one (Windows
allows renaming an open file). This is why reinstall-over-running works without a
shutdown handshake.

**Restart Manager (implemented, third pass).** Before uninstall deletes the app,
the engine now asks Windows Restart Manager exactly which processes hold the
manifest's owned files open, and stops the Clippity-owned ones so removal
succeeds instead of deferring to reboot.

- `installer_platform::windows::restart_manager` wraps the documented flow
  `RmStartSession → RmRegisterResources → RmGetList → RmEndSession` (the session
  is closed by an RAII guard even on an early return). For each reported process
  it resolves the image path with `QueryFullProcessImageNameW` so classification
  can use the real path, not a friendly window title.
- `installer_domain::shutdown` is the **pure, unit-tested policy**:
  `ShutdownPlan::from_locks` classifies each holder as `ClippityOwned`,
  `SystemCritical` (Explorer / `RmCritical` — *never* auto-closed), or
  `Unrelated` (a user app — surfaced, never killed). Path ownership is by
  directory containment, not string prefix, so `…\Clippity Backup` is never
  mistaken for a child of `…\Clippity`.
- `installer_services::shutdown::clear_locks` executes the plan: it terminates
  only the owned, non-self holders (`TerminateProcess`, the controlled
  fallback), waits briefly for handles to release, and reports any unrelated
  blocker. The running maintenance exe classifies as "self" and is left to the
  reboot-scheduled self-removal path — it never tries to kill itself.

**Still not wired:** an authenticated local IPC to the running app requesting a
clean maintenance shutdown *before* termination, so the app can stop captures
and save state first. Force-termination during a user-initiated uninstall is the
correct bounded fallback until that handshake exists; it is the documented
Phase 8 precursor and the next follow-up.

## Locked-file fallback (Phase 10) — implemented

When a Clippity-owned file cannot be removed because it is still in use, the
engine schedules it for deletion at the next reboot via
[`MoveFileExW(MOVEFILE_DELAY_UNTIL_REBOOT)`](../../installer/app/backend/crates/platform/src/windows/reboot.rs).
The documented API is used deliberately rather than editing
`PendingFileRenameOperations` by hand. Because directories scheduled this way are
removed only when empty, the uninstaller schedules the exe first, then the
directory. The uninstall service returns a `reboot_required` flag and logs it;
it never claims full success while files remain.

Intended ordering (mostly realised):

1. Request graceful app shutdown over IPC *(Phase 8 — still pending; the
   state-saving precursor)*.
2. Stop Clippity-owned services/workers *(pending — no service ships yet)*.
3. **Restart Manager to identify remaining locks** *(implemented — third pass)*.
4. Ask the user to close unrelated blocking apps *(reported + logged; a
   dedicated UI prompt is still a follow-up)*.
5. Retry the file operation.
6. **Force-close only Clippity-owned processes when justified** *(implemented —
   the plan terminates owned, non-self holders and nothing else)*.
7. **Schedule unresolved files for reboot deletion** *(implemented — a still-
   locked owned file, and then its now-empty directory, are scheduled)*.
8. **Record pending work + report the reboot requirement** *(implemented — the
   uninstall threads `reboot_required` from a deferred file through the progress
   event to the Complete screen)*.

## Native cleanup worker (Phase 9) — design + interim path

**Interim (implemented):** after removing everything else, the uninstaller
deletes the manifest, tries to delete `clippity-maintenance.exe`, and on failure
(it is the running process) schedules the exe and its directory for reboot
deletion. This leaves the machine correct after one reboot with no orphaned ARP
entry (that is removed synchronously).

**Full design (recommended):** a minimal, separately-built cleanup worker so the
directory is gone immediately rather than at reboot:

```
%TEMP%\Clippity-Uninstall-{GUID}\
    ClippityCleanup.exe        # tiny native worker, no payload
    uninstall-plan.json        # integrity-protected plan
    uninstall.log
```

1. The uninstaller copies `ClippityCleanup.exe` + a scoped `uninstall-plan.json`
   to a unique temp dir.
2. It launches the worker detached and exits.
3. The worker waits for the maintenance process to exit, then deletes the
   maintenance exe and its (now-unlocked) directory.
4. The worker removes itself via a safe follow-up (e.g. schedule its own temp
   dir for reboot deletion, or a self-delete-on-close handle).

**The cleanup worker must never accept an arbitrary deletion path.** It validates
the plan against: `productId`, `installationId`, `schemaVersion`, expected
install root, expected maintenance root, allowed deletion roots, scope, request
integrity, and the calling/elevated context — and refuses anything outside the
recorded Clippity roots. A native worker is preferred over a batch/PowerShell
script to avoid execution-policy, quoting, reliability, and AV problems.

This worker is not built in this pass (it is a new signed binary); the interim
reboot-based path is safe and correct in the meantime.
