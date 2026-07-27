import { FolderOpen, ImageOff } from "lucide-react";

interface EditorEmptyProps {
  /** Navigates to the Library view. Provided by the dashboard shell;
   *  the hint stays text-only when absent (e.g. in isolation tests). */
  onOpenLibrary?: () => void;
}

/** Shown when the editor view is active but no capture is loaded. */
export function EditorEmpty({ onOpenLibrary }: EditorEmptyProps) {
  return (
    <div
      className="clippity-editor flex h-full w-full flex-col items-center justify-center gap-3"
      style={{ background: "var(--ed-canvas)" }}
    >
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full"
        style={{ background: "var(--ed-panel)", color: "var(--ed-text-dim)" }}
      >
        <ImageOff size={24} strokeWidth={1.5} />
      </div>
      <p className="text-[13px]" style={{ color: "var(--ed-text-dim)" }}>
        Open a capture from the Library to start editing.
      </p>
      {onOpenLibrary && (
        <button
          type="button"
          onClick={onOpenLibrary}
          className="focus-ring mt-1 inline-flex items-center gap-2 rounded-[10px] border px-3.5 py-2 text-[13px] font-medium transition-colors"
          style={{
            background: "var(--ed-elev)",
            borderColor: "var(--ed-hairline-strong)",
            color: "var(--ed-text)",
          }}
        >
          <FolderOpen size={15} strokeWidth={1.85} />
          Open Library
        </button>
      )}
    </div>
  );
}
