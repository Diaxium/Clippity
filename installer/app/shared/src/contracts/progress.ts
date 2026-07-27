/**
 * Progress contracts — mirror Rust `installer_domain::progress`.
 *
 * The Installing / Applying-changes / Uninstalling steps all render the
 * same shape: a percentage bar plus an ordered checklist of tasks that
 * transition pending → in-progress → completed. The backend drives these
 * by emitting `ProgressEvent`s over a Tauri channel.
 */

/** Lifecycle state of a single progress task. */
export type TaskState = "pending" | "in-progress" | "completed" | "failed";

/** One row in the progress checklist. */
export interface ProgressTask {
  id: string;
  label: string;
  state: TaskState;
}

/** Which long-running operation a progress stream describes. */
export type ProgressKind =
  | "install"
  | "modify"
  | "repair"
  | "update"
  | "uninstall";

/**
 * A snapshot emitted as the operation advances. `percent` is 0..100;
 * `tasks` is the full checklist (not a delta) so a late-subscribing
 * window always renders a consistent state.
 */
export interface ProgressEvent {
  kind: ProgressKind;
  percent: number;
  tasks: ProgressTask[];
  /** True on the terminal event, after which the Complete step shows. */
  done: boolean;
  /**
   * True on the terminal event when the operation completed but left a
   * locked file for the next reboot. The Complete step surfaces this
   * instead of an unqualified success. Optional; absent means `false`.
   */
  rebootRequired?: boolean;
}
