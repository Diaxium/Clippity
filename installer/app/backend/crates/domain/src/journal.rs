//! The operation journal — the transaction record every mutating
//! maintenance operation writes as it runs.
//!
//! An install / modify / repair / update / reinstall / uninstall is a
//! transaction: it moves through a fixed lifecycle
//! (`Detect → Validate → Plan → Stage → Apply → Verify → Commit →
//! Cleanup`), and each mutating step records an [`Action`] together with
//! the inverse that undoes it. If the process dies partway — power loss, a
//! crash, the user killing it — the next launch reads the journal and the
//! pure [`recover`] rule decides whether to resume forward, roll the
//! applied actions back, just finish cleanup, or stop for manual recovery.
//!
//! Everything here is pure data + pure rules, exactly like
//! [`crate::state`]: the services layer performs the I/O that applies an
//! action and, on rollback, walks [`OperationJournal::pending_reversals`]
//! to reverse them. Keeping the decision here makes the "what do we do
//! with a half-finished operation" question unit-testable without a
//! filesystem.
//!
//! The shape is deliberately MSI-adjacent — an action with a recorded
//! inverse is the same idea as a Windows Installer custom action paired
//! with its rollback action inside a rollback boundary — so the Option-C
//! target (a WiX-authored MSI driven by this wizard) inherits the concept
//! rather than replacing it. See `docs/installer/04-lifecycle-and-recovery.md`.

use serde::{Deserialize, Serialize};

/// Bump when the on-disk journal shape changes incompatibly. A reader that
/// finds a higher version refuses to act on it and routes to manual
/// recovery rather than guessing at a shape it does not understand.
pub const JOURNAL_SCHEMA_VERSION: u32 = 1;

/// Which maintenance operation a journal records. Broader than
/// [`crate::progress::ProgressKind`] because repair and reinstall are real
/// lifecycle modes even though several share install machinery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationType {
    Install,
    Modify,
    Repair,
    Update,
    Reinstall,
    Uninstall,
}

/// The transaction lifecycle phase an operation has reached. Ordered: a
/// later phase implies every earlier one completed. The ordinal is what
/// [`recover`] reasons over, so the ordering is the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// Gathering installed-state signals. No mutations.
    Detect,
    /// Checking preconditions (disk, OS, scope, downgrade). No mutations.
    Validate,
    /// Building the action list. No mutations.
    Plan,
    /// Writing to a staging area, never the live install. Reversible by
    /// discarding staging.
    Stage,
    /// Mutating the live install (files, registry, shortcuts). Reversible
    /// via recorded inverses.
    Apply,
    /// Post-apply integrity / launch verification, before anything is made
    /// authoritative.
    Verify,
    /// Making the new state authoritative (manifest write, staged→live
    /// swap). Commit steps must be idempotent so an interrupted commit can
    /// be rolled *forward*.
    Commit,
    /// Removing staging, backups, and — for uninstall — the operation's own
    /// footprint. Nothing here changes the committed outcome.
    Cleanup,
}

/// How an in-flight operation ultimately resolved. `Pending` is the value a
/// live journal carries until a terminal outcome is written; finding it on
/// the *next* launch means the process died mid-operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    /// Still in flight (or the process died before writing a terminal
    /// outcome).
    Pending,
    /// Verified and made authoritative.
    Committed,
    /// Reversed back to the pre-operation state.
    RolledBack,
    /// Aborted with an error; applied actions still need reversing.
    Failed,
}

/// What kind of mutation an [`Action`] performed, which determines how it
/// is reversed. The inverse is intrinsic to the kind (plus the recorded
/// `backup` / `previous_value`), so a rollback executor needs no other
/// context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActionKind {
    /// Wrote a new file at `target`. Inverse: delete `target`.
    CreateFile,
    /// Overwrote an existing file at `target`, moving the original to
    /// `backup`. Inverse: restore `backup` → `target`.
    ReplaceFile,
    /// Deleted a file that was at `target`, moving it to `backup` first.
    /// Inverse: restore `backup` → `target`.
    DeleteFile,
    /// Created directory `target`. Inverse: remove `target` if empty.
    CreateDirectory,
    /// Wrote a registry value (`target` = "hive\\subkey\\value"),
    /// optionally recording `previous_value`. Inverse: restore the previous
    /// value, or delete the value if there was none.
    WriteRegistryValue,
    /// Created a whole registry subkey (`target` = "hive\\subkey").
    /// Inverse: delete the subkey.
    WriteRegistryKey,
    /// Created a shortcut `.lnk` at `target`. Inverse: delete it.
    CreateShortcut,
    /// Placed the maintenance/uninstaller copy at `target`. Inverse:
    /// schedule-delete on reboot (it may be the running exe).
    PlaceMaintenanceExe,
    /// Wrote the installation manifest at `target`. Inverse: remove it.
    WriteManifest,
}

impl ActionKind {
    /// Whether reversing this action needs the recorded `backup` path to be
    /// present. A [`ReplaceFile`](ActionKind::ReplaceFile) /
    /// [`DeleteFile`](ActionKind::DeleteFile) with no backup cannot be
    /// reversed and must surface rather than silently no-op.
    pub fn needs_backup(self) -> bool {
        matches!(self, ActionKind::ReplaceFile | ActionKind::DeleteFile)
    }
}

/// The status of a single recorded action within the transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActionStatus {
    /// Recorded in the plan, not yet performed. Nothing to reverse.
    Planned,
    /// Performed against the live system. Reversible.
    Applied,
    /// Reversed by a rollback.
    Reversed,
    /// The apply itself failed; may or may not need reversing (the executor
    /// decides based on the kind).
    Failed,
}

/// One recorded mutation plus everything a rollback needs to undo it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    /// Monotonic id within this operation, assigned in apply order — the
    /// order rollback reverses.
    pub id: u32,
    pub kind: ActionKind,
    /// The primary path or "hive\\subkey\\value" the action touched.
    pub target: String,
    /// Where the displaced original lives, for replace/delete inverses.
    pub backup: Option<String>,
    /// The registry value that was there before, for a precise restore.
    pub previous_value: Option<String>,
    pub status: ActionStatus,
}

impl Action {
    /// A newly planned action (not yet applied).
    pub fn planned(id: u32, kind: ActionKind, target: impl Into<String>) -> Self {
        Self {
            id,
            kind,
            target: target.into(),
            backup: None,
            previous_value: None,
            status: ActionStatus::Planned,
        }
    }

    /// Attach the displaced-original backup path (replace/delete).
    pub fn with_backup(mut self, backup: impl Into<String>) -> Self {
        self.backup = Some(backup.into());
        self
    }

    /// Attach the prior registry value, for a precise restore on rollback.
    pub fn with_previous_value(mut self, value: impl Into<String>) -> Self {
        self.previous_value = Some(value.into());
        self
    }
}

/// The transaction record, serialized to `operation.json` in the
/// maintenance directory while an operation is in flight and removed once
/// it commits and cleans up.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationJournal {
    pub schema_version: u32,
    /// Stable id for this operation instance (for logs and resume).
    pub operation_id: String,
    pub operation: OperationType,
    pub product_id: String,
    /// The installation this operates on, if one exists yet.
    pub installation_id: Option<String>,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub phase: Phase,
    pub outcome: Outcome,
    /// ISO-8601 UTC start / last-update timestamps.
    pub started: String,
    pub updated: String,
    /// Applied actions in apply order; rollback walks them in reverse.
    pub actions: Vec<Action>,
    /// Set when a step had to defer work (a locked file) to the next reboot.
    pub reboot_required: bool,
    /// The failure message, when `outcome` is `Failed`.
    pub error: Option<String>,
}

impl OperationJournal {
    /// Open a fresh journal in the `Detect` phase with no actions yet.
    pub fn begin(
        operation_id: impl Into<String>,
        operation: OperationType,
        product_id: impl Into<String>,
        started: impl Into<String>,
    ) -> Self {
        let started = started.into();
        Self {
            schema_version: JOURNAL_SCHEMA_VERSION,
            operation_id: operation_id.into(),
            operation,
            product_id: product_id.into(),
            installation_id: None,
            from_version: None,
            to_version: None,
            phase: Phase::Detect,
            outcome: Outcome::Pending,
            updated: started.clone(),
            started,
            actions: Vec::new(),
            reboot_required: false,
            error: None,
        }
    }

    /// Advance to `phase` and stamp the update time. Phases only move
    /// forward; a request to an earlier phase is ignored so a late log line
    /// cannot rewind the record.
    pub fn advance(&mut self, phase: Phase, now: impl Into<String>) {
        if phase >= self.phase {
            self.phase = phase;
        }
        self.updated = now.into();
    }

    /// Record an action as `Applied`, assigning it the next id, and return
    /// that id. The caller performs the side effect first, then records —
    /// so a crash between the two loses at most a not-yet-recorded action,
    /// never claims one that did not happen.
    pub fn record_applied(&mut self, mut action: Action, now: impl Into<String>) -> u32 {
        let id = self.actions.len() as u32;
        action.id = id;
        action.status = ActionStatus::Applied;
        self.actions.push(action);
        self.updated = now.into();
        id
    }

    /// The applied actions still needing reversal, newest-first — the order
    /// a rollback must undo them (a file replaced last is restored first).
    pub fn pending_reversals(&self) -> Vec<&Action> {
        self.actions
            .iter()
            .rev()
            .filter(|a| a.status == ActionStatus::Applied)
            .collect()
    }

    /// Mark an action reversed (called by the rollback executor per action).
    pub fn mark_reversed(&mut self, id: u32, now: impl Into<String>) {
        if let Some(a) = self.actions.iter_mut().find(|a| a.id == id) {
            a.status = ActionStatus::Reversed;
        }
        self.updated = now.into();
    }

    /// Write a terminal outcome and stamp the time.
    pub fn finish(&mut self, outcome: Outcome, now: impl Into<String>) {
        self.outcome = outcome;
        self.updated = now.into();
    }

    /// Record that the operation deferred work to the next reboot.
    pub fn set_reboot_required(&mut self, now: impl Into<String>) {
        self.reboot_required = true;
        self.updated = now.into();
    }

    /// Record a failure message (and mark the outcome `Failed`).
    pub fn fail(&mut self, message: impl Into<String>, now: impl Into<String>) {
        self.error = Some(message.into());
        self.finish(Outcome::Failed, now);
    }

    /// Whether the recorded schema is one this build understands.
    pub fn schema_supported(&self) -> bool {
        self.schema_version <= JOURNAL_SCHEMA_VERSION
    }
}

/// What the next launch should do about a journal it found — the pure
/// recovery decision, testable without touching disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Recovery {
    /// Nothing to do — the operation committed and cleaned up.
    None,
    /// Re-run the operation from the start; no live mutations had happened
    /// yet, so a clean restart is safe.
    Resume,
    /// Reverse the applied actions back to the pre-operation state.
    RollBack,
    /// The operation succeeded; only staging/backups remain to remove.
    Cleanup,
    /// The state is ambiguous and cannot be resolved automatically; show
    /// the user a recovery path rather than risk making it worse.
    ManualRecovery,
}

/// Decide what to do with a journal discovered at launch.
///
/// The rule encodes the transaction's safety boundary: nothing is
/// authoritative until [`Phase::Commit`], so an interruption *before*
/// commit rolls back (or, if nothing was applied, simply restarts), while
/// an interruption *at or after* commit rolls forward — reversing a nearly
/// complete, half-authoritative operation is riskier than finishing it,
/// and every commit/cleanup step is defined idempotent for exactly this
/// reason.
pub fn recover(journal: &OperationJournal) -> Recovery {
    // A shape we cannot trust is never auto-resolved.
    if !journal.schema_supported() {
        return Recovery::ManualRecovery;
    }

    match journal.outcome {
        // Reached a clean end; only leftover cleanup could remain.
        Outcome::Committed => {
            if journal.phase < Phase::Cleanup {
                Recovery::Cleanup
            } else {
                Recovery::None
            }
        }
        // Already rolled back: just drop the journal (a Cleanup no-op).
        Outcome::RolledBack => Recovery::Cleanup,
        // Errored mid-flight and recorded it: reverse what was applied.
        Outcome::Failed => Recovery::RollBack,
        // Died before writing any terminal outcome — classify by how far it
        // had got.
        Outcome::Pending => match journal.phase {
            // Pre-mutation phases: nothing live changed, safe to restart.
            Phase::Detect | Phase::Validate | Phase::Plan => Recovery::Resume,
            // Staging / applying / verifying: partial, uncommitted mutations
            // exist — reverse them.
            Phase::Stage | Phase::Apply | Phase::Verify => Recovery::RollBack,
            // Crossed the commit boundary: roll forward to finish.
            Phase::Commit => Recovery::Resume,
            // Only cleanup was left.
            Phase::Cleanup => Recovery::Cleanup,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal() -> OperationJournal {
        OperationJournal::begin("op-1", OperationType::Install, "com.clippity.app", "T0")
    }

    #[test]
    fn phases_are_ordered_for_recovery_reasoning() {
        assert!(Phase::Detect < Phase::Apply);
        assert!(Phase::Apply < Phase::Commit);
        assert!(Phase::Commit < Phase::Cleanup);
    }

    #[test]
    fn advance_never_rewinds() {
        let mut j = journal();
        j.advance(Phase::Commit, "T1");
        j.advance(Phase::Apply, "T2"); // a stale, out-of-order update
        assert_eq!(j.phase, Phase::Commit);
        assert_eq!(j.updated, "T2");
    }

    #[test]
    fn recorded_actions_get_sequential_ids_and_applied_status() {
        let mut j = journal();
        let a = j.record_applied(Action::planned(0, ActionKind::CreateFile, "a.exe"), "T1");
        let b = j.record_applied(Action::planned(0, ActionKind::CreateShortcut, "a.lnk"), "T2");
        assert_eq!((a, b), (0, 1));
        assert!(j.actions.iter().all(|x| x.status == ActionStatus::Applied));
    }

    #[test]
    fn reversals_are_newest_first_and_skip_reversed() {
        let mut j = journal();
        j.record_applied(Action::planned(0, ActionKind::CreateFile, "first"), "T1");
        j.record_applied(Action::planned(0, ActionKind::CreateFile, "second"), "T2");
        j.record_applied(Action::planned(0, ActionKind::CreateFile, "third"), "T3");
        j.mark_reversed(1, "T4"); // reverse the middle one out of band

        let order: Vec<&str> = j.pending_reversals().iter().map(|a| a.target.as_str()).collect();
        assert_eq!(order, vec!["third", "first"]); // newest-first, middle skipped
    }

    #[test]
    fn interrupted_before_apply_resumes() {
        let mut j = journal();
        j.advance(Phase::Plan, "T1");
        assert_eq!(recover(&j), Recovery::Resume);
    }

    #[test]
    fn interrupted_during_apply_rolls_back() {
        let mut j = journal();
        j.advance(Phase::Apply, "T1");
        j.record_applied(Action::planned(0, ActionKind::CreateFile, "a.exe"), "T1");
        assert_eq!(recover(&j), Recovery::RollBack);
    }

    #[test]
    fn interrupted_at_commit_rolls_forward() {
        let mut j = journal();
        j.advance(Phase::Commit, "T1");
        assert_eq!(recover(&j), Recovery::Resume);
    }

    #[test]
    fn committed_but_not_cleaned_asks_for_cleanup() {
        let mut j = journal();
        j.advance(Phase::Commit, "T1");
        j.finish(Outcome::Committed, "T2");
        assert_eq!(recover(&j), Recovery::Cleanup);

        j.advance(Phase::Cleanup, "T3");
        assert_eq!(recover(&j), Recovery::None);
    }

    #[test]
    fn explicit_failure_rolls_back() {
        let mut j = journal();
        j.advance(Phase::Apply, "T1");
        j.fail("disk full", "T2");
        assert_eq!(j.outcome, Outcome::Failed);
        assert_eq!(recover(&j), Recovery::RollBack);
    }

    #[test]
    fn unreadable_schema_forces_manual_recovery() {
        let mut j = journal();
        j.schema_version = JOURNAL_SCHEMA_VERSION + 1;
        assert_eq!(recover(&j), Recovery::ManualRecovery);
    }

    #[test]
    fn replace_and_delete_inverses_need_a_backup() {
        assert!(ActionKind::ReplaceFile.needs_backup());
        assert!(ActionKind::DeleteFile.needs_backup());
        assert!(!ActionKind::CreateFile.needs_backup());
        assert!(!ActionKind::WriteRegistryValue.needs_backup());
    }

    #[test]
    fn journal_round_trips_through_json() {
        let mut j = journal();
        j.installation_id = Some("inst-1".into());
        j.to_version = Some("0.2.0".into());
        j.advance(Phase::Apply, "T1");
        j.record_applied(
            Action::planned(0, ActionKind::ReplaceFile, "Clippity.exe").with_backup("Clippity.exe.old"),
            "T1",
        );
        let raw = serde_json::to_string(&j).unwrap();
        let back: OperationJournal = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.phase, Phase::Apply);
        assert_eq!(back.actions.len(), 1);
        assert_eq!(back.actions[0].backup.as_deref(), Some("Clippity.exe.old"));
        // camelCase on the wire, matching the rest of the contracts.
        assert!(raw.contains("\"schemaVersion\""));
        assert!(raw.contains("\"rebootRequired\""));
    }
}
