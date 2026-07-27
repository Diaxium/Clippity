//! Progress checklists for the long-running install / update / uninstall
//! operations, plus the event snapshot streamed to the frontend.

use serde::{Deserialize, Serialize};

/// Lifecycle state of a single progress task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskState {
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// One row in the progress checklist.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressTask {
    pub id: String,
    pub label: String,
    pub state: TaskState,
}

impl ProgressTask {
    fn pending(id: &str, label: &str) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            state: TaskState::Pending,
        }
    }
}

/// Which long-running operation a progress stream describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProgressKind {
    Install,
    Modify,
    Repair,
    Update,
    Uninstall,
}

/// A snapshot emitted as the operation advances.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub kind: ProgressKind,
    pub percent: u8,
    pub tasks: Vec<ProgressTask>,
    pub done: bool,
    /// True on the terminal event when the operation completed but left work
    /// (a locked file) for the next reboot. The Complete screen surfaces
    /// this rather than claiming an unqualified success. Default `false`.
    #[serde(default)]
    pub reboot_required: bool,
}

impl ProgressEvent {
    /// Mark this (terminal) event as needing a reboot to finish. Chained
    /// onto the final [`snapshot`] by a service that deferred locked-file
    /// work.
    pub fn with_reboot_required(mut self, reboot_required: bool) -> Self {
        self.reboot_required = reboot_required;
        self
    }
}

/// The ordered checklist for a given operation. The service walks this
/// list, flipping each task to `InProgress` then `Completed` and
/// emitting a [`ProgressEvent`] after every transition.
pub fn checklist_for(kind: ProgressKind) -> Vec<ProgressTask> {
    match kind {
        ProgressKind::Install => vec![
            ProgressTask::pending("download", "Downloading"),
            ProgressTask::pending("verify", "Verifying"),
            ProgressTask::pending("files", "Installing files"),
            ProgressTask::pending("integrations", "Registering integrations"),
            ProgressTask::pending("finalize", "Finalizing installation"),
        ],
        ProgressKind::Modify | ProgressKind::Update => vec![
            ProgressTask::pending("download", "Downloading update"),
            ProgressTask::pending("verify", "Verifying package"),
            ProgressTask::pending("files", "Updating files"),
            ProgressTask::pending("integrations", "Registering integrations"),
            ProgressTask::pending("backup", "Backing up previous version"),
            ProgressTask::pending("finalize", "Finalizing"),
        ],
        ProgressKind::Repair => vec![
            ProgressTask::pending("scan", "Checking installation"),
            ProgressTask::pending("verify", "Verifying files"),
            ProgressTask::pending("restore", "Restoring files"),
            ProgressTask::pending("integrations", "Re-registering integrations"),
            ProgressTask::pending("finalize", "Finalizing repair"),
        ],
        ProgressKind::Uninstall => vec![
            ProgressTask::pending("processes", "Closing running processes"),
            ProgressTask::pending("appfiles", "Removing application files"),
            ProgressTask::pending("shortcuts", "Removing shortcuts"),
            ProgressTask::pending("cache", "Cleaning cache"),
            ProgressTask::pending("registry", "Updating system registrations"),
            ProgressTask::pending("finalize", "Finalizing uninstall"),
        ],
    }
}

/// Build a snapshot where the first `completed` tasks are done, the next
/// one is in progress, and the rest are pending. `percent` is derived
/// from the completed fraction. A convenience for services that advance
/// one task at a time.
pub fn snapshot(kind: ProgressKind, mut tasks: Vec<ProgressTask>, completed: usize) -> ProgressEvent {
    let total = tasks.len();
    for (i, t) in tasks.iter_mut().enumerate() {
        t.state = if i < completed {
            TaskState::Completed
        } else if i == completed {
            TaskState::InProgress
        } else {
            TaskState::Pending
        };
    }
    let done = completed >= total;
    let percent = if total == 0 {
        100
    } else {
        ((completed.min(total) as f64 / total as f64) * 100.0).round() as u8
    };
    ProgressEvent {
        kind,
        percent,
        tasks,
        done,
        reboot_required: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_marks_states_in_order() {
        let tasks = checklist_for(ProgressKind::Install);
        let ev = snapshot(ProgressKind::Install, tasks, 2);
        assert_eq!(ev.tasks[0].state, TaskState::Completed);
        assert_eq!(ev.tasks[1].state, TaskState::Completed);
        assert_eq!(ev.tasks[2].state, TaskState::InProgress);
        assert_eq!(ev.tasks[3].state, TaskState::Pending);
        assert!(!ev.done);
    }

    #[test]
    fn full_completion_is_done_at_100() {
        let tasks = checklist_for(ProgressKind::Uninstall);
        let n = tasks.len();
        let ev = snapshot(ProgressKind::Uninstall, tasks, n);
        assert!(ev.done);
        assert_eq!(ev.percent, 100);
    }
}
