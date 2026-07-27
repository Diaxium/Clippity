# Clippity Installer / Maintenance Engine — Documentation

The Clippity Setup wizard's design, audit, and lifecycle documentation. Produced
by the 2026-07-24 "Windows Setup & Maintenance Wizard" upgrade.

User-facing name: **Clippity Wizard**. Underlying system: the **Clippity
Maintenance Engine** (the layered Rust crates under `installer/app/backend`).

## Read in order

1. [00 — Final report](00-final-report.md) — what was done, per-requirement
   status, risks, and follow-ups. **Start here.**
2. [01 — Current-state audit](01-current-state-audit.md) — the "before" picture.
3. [02 — Architecture decision](02-architecture-decision.md) — options A/B/C,
   the hybrid decision, and the MSI/WiX migration path.
4. [03 — Installation model & ownership](03-installation-model.md) — the manifest,
   directory & registry ownership, conditional integrations.
5. [04 — Lifecycle & recovery](04-lifecycle-and-recovery.md) — detection, modes,
   transactions, user-data protection.
6. [05 — Self-removal & locked files](05-self-removal-and-locked-files.md) —
   graceful shutdown, cleanup worker, reboot handling.
7. [06 — Security, CLI & logging](06-security-cli-logging.md) — elevation,
   signing, silent operation, exit codes, diagnostics.
8. [07 — Test matrix](07-test-matrix.md) — automated tests + the manual Windows
   matrix.
9. [08 — Change log](08-changelog.md) — every file changed and why.
10. [09 — References](09-references.md) — authoritative doc + tool versions.
11. [10 — Installer → application handoff](10-app-provisioning-handoff.md) —
    how the wizard's choices reach the running app (`install-config.json`),
    which are capabilities vs. seeded settings, and why an absent document
    means "everything on".

## One-paragraph summary

The wizard was a polished UI prototype with a real payload-copy core and real
elevation, but stubbed Windows integrations and a simulated maintenance layer.
The first pass made the highest-value, safest pieces **real** — Add/Remove
Programs registration, shortcuts, start-at-login, an on-disk installation
manifest, detection, and a manifest-driven uninstall that preserves unknown
files. The **second pass (2026-07-24)** added a **persisted transaction journal
with a rollback executor** (a failed install now reverses itself) and **startup
recovery**, a **real repair flow** (SHA-256 integrity scan → targeted restore),
a **command-line / silent-operation interface with stable exit codes**, and
**honest reboot reporting**. The **third pass (2026-07-24)** added **Windows
Restart Manager** locked-file handling (Phase 8/10): the engine enumerates
exactly which processes hold a file it must change, stops the Clippity-owned
ones, never touches unrelated or Explorer/critical processes, and reboot-defers
anything still locked. Together that is **87 passing unit tests**. The staged
migration of the transactional core onto a WiX-authored MSI (driven by this
wizard as a bootstrapper) remains the documented long-term target. See the
[final report](00-final-report.md).
