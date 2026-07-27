import { FileText } from "lucide-react";

/**
 * Clipboard-mode toast body. The Clipboard custom mode ingests whatever
 * the system clipboard holds, so this renders two shapes from one wire
 * variant (the `clipboard` payload carries an optional `text`):
 *
 * - **image** (`text` absent) — a thumbnail of the saved capture plus
 *   its dimensions. The PNG is already on disk + in the library, and the
 *   editor opens on its own when "Preview in Editor" was on.
 * - **text** (`text` present) — a snippet of the captured text (already
 *   on the clipboard), persisted as a library entry.
 *
 * Informational + sticky (the `clipboard` duration is 0): dismiss via the
 * chrome ×. No action buttons — editor-open rides the preview toggle, the
 * modern single decision point.
 */
export function ClipboardToastBody({
  preview,
  width,
  height,
  text,
}: {
  preview: string;
  width: number;
  height: number;
  text?: string;
}) {
  const isText = typeof text === "string";
  return (
    <div className="flex items-center gap-3.5 pr-14">
      {isText ? (
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-[10px] border border-[color:var(--hairline)] bg-[color:var(--color-overlay-2)] text-[var(--color-hint)]">
          <FileText size={22} strokeWidth={1.85} />
        </span>
      ) : (
        <img
          src={preview}
          alt="Clipboard capture"
          className="h-14 w-14 shrink-0 rounded-[10px] border border-[color:var(--hairline)] object-cover"
          draggable={false}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-hint)]">
          {isText ? "Text captured" : "Clipboard captured"}
        </span>
        {isText ? (
          <p className="line-clamp-2 whitespace-pre-wrap break-words text-[12.5px] leading-snug text-[var(--color-ink)]">
            {text}
          </p>
        ) : (
          <span className="text-[12.5px] leading-snug text-[var(--color-slate)]">
            {width} × {height} · saved to your library
          </span>
        )}
      </div>
    </div>
  );
}
