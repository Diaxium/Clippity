import { Check, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import type { ProgressTask, TaskState } from "@clippity/installer-shared";
import { cn } from "@shared/lib/cn";

interface ProgressChecklistProps {
  tasks: ProgressTask[];
}

const STATUS_LABEL: Record<TaskState, string> = {
  pending: "Pending",
  "in-progress": "In progress",
  completed: "Completed",
  failed: "Failed",
};

/**
 * The task checklist beneath the progress bar. Each row shows an icon
 * that reflects its state (spinner while active, check when done) plus a
 * right-aligned status word, matching the design boards.
 */
export function ProgressChecklist({ tasks }: ProgressChecklistProps) {
  return (
    <ul className="flex flex-col gap-1">
      {tasks.map((task) => {
        const active = task.state === "in-progress";
        const done = task.state === "completed";
        return (
          <li
            key={task.id}
            className="flex items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5"
          >
            <span
              className={cn(
                "grid h-5 w-5 shrink-0 place-items-center rounded-full",
                done && "bg-[var(--color-accent)] text-[var(--color-accent-ink)]",
                active && "text-[var(--color-accent)]",
                !done && !active && "text-[var(--color-hint)]"
              )}
            >
              <AnimatePresence mode="wait" initial={false}>
                {done ? (
                  <motion.span
                    key="done"
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                  >
                    <Check size={12} strokeWidth={3} />
                  </motion.span>
                ) : active ? (
                  <motion.span key="active">
                    <Loader2 size={15} strokeWidth={2.2} className="animate-spin" />
                  </motion.span>
                ) : (
                  <motion.span
                    key="pending"
                    className="h-1.5 w-1.5 rounded-full bg-current"
                  />
                )}
              </AnimatePresence>
            </span>
            <span
              className={cn(
                "text-[13px]",
                done || active
                  ? "text-[var(--color-ink)]"
                  : "text-[var(--color-hint)]"
              )}
            >
              {task.label}
            </span>
            <span
              className={cn(
                "ml-auto text-[11.5px] font-medium",
                done
                  ? "text-[var(--color-accent)]"
                  : active
                    ? "text-[var(--color-ink)]"
                    : "text-[var(--color-hint)]"
              )}
            >
              {STATUS_LABEL[task.state]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
