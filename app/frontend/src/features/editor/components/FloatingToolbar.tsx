import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";

import {
  ArrowUpToLine,
  ArrowDownToLine,
  Copy,
  CopyPlus,
  Download,
  Droplet,
  MoreHorizontal,
  PenLine,
  Replace,
  Trash2,
} from "lucide-react";

import { cn } from "@shared/lib/cn";

import { rotatedAABB } from "../geometry";
import { useEditorExport } from "../hooks/useEditorExport";
import {
  chromeSide,
  chromeVerticalPos,
  CHROME_MARGIN,
} from "../lib/selectionChrome";
import { useEditorStore } from "../state/editorStore";
import type { Viewport } from "../state/editorStore";
import type { SceneNode } from "../types";

interface FloatingToolbarProps {
  /** The single selected node, or null when 0 / many are selected. */
  node: SceneNode | null;
  viewport: Viewport;
  /** Hidden during a gesture (chrome would only get in the way). */
  hidden: boolean;
}

/**
 * Contextual action bar that floats above the selected object: Annotate, Blur,
 * Copy, Export, and an overflow menu (duplicate / replace image / z-order /
 * delete). Every action maps to a real store/export capability — no stubs. The
 * bar flips below the object when there's no room above and clamps into the
 * canvas, so it never escapes the viewport. Floating-surface tokens only.
 *
 * Each action is an icon **over its word**, not an icon with a hover tooltip.
 * This bar appears under the cursor on every selection, so its actions are read
 * far more often than any of them is clicked — a tooltip made the common case
 * (deciding whether this bar has what you want) cost a hover per button.
 */
export function FloatingToolbar({
  node,
  viewport,
  hidden,
}: FloatingToolbarProps) {
  const canvasSize = useEditorStore((s) => s.canvasSize);
  const { exportImage, busy } = useEditorExport();

  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      setBox({ w: r.width, h: r.height });
    }
  }, [node?.id, hidden, menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  useEffect(() => {
    if (hidden || !node) setMenu(false);
  }, [hidden, node]);

  if (!node || hidden) return null;

  const id = node.id;
  const store = useEditorStore.getState;
  const { zoom, panX, panY } = viewport;
  const b = rotatedAABB(node);
  const cx = (b.x + b.width / 2) * zoom + panX;
  const topY = b.y * zoom + panY;
  const bottomY = (b.y + b.height) * zoom + panY;

  // Clamp horizontally into the canvas; the vertical side (above / below /
  // pinned-above-rail) is resolved by the shared chrome helper so the size
  // label can take the opposite side and the two never stack.
  const half = box.w / 2;
  const maxLeft = Math.max(
    half + CHROME_MARGIN,
    canvasSize.width - half - CHROME_MARGIN
  );
  const left = Math.min(Math.max(cx, half + CHROME_MARGIN), maxLeft);
  const side = chromeSide(topY, bottomY, canvasSize.height, box.h);
  const { top, translateY } = chromeVerticalPos(
    side,
    topY,
    bottomY,
    canvasSize.height,
    box.h
  );

  const onReplaceFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === "string" ? reader.result : "";
      if (!src) return;
      // The image lives as an image fill now; replace that fill's source.
      const fresh = store().nodes[id];
      const imgFill = fresh?.fills.find((f) => f.type === "image");
      if (imgFill) store().updateFill(id, imgFill.id, { src });
    };
    reader.readAsDataURL(file);
  };

  const runMenu = (fn: () => void) => () => {
    fn();
    setMenu(false);
  };

  return (
    <>
      <div
        ref={ref}
        className="absolute z-30 flex items-stretch gap-0.5 rounded-[var(--radius-md)] border border-[color:var(--ed-hairline-strong)] p-1"
        style={{
          left,
          top,
          transform: `translate(-50%, ${translateY})`,
          background: "var(--float-bg)",
          boxShadow: "var(--shadow-medium)",
        }}
        role="toolbar"
        aria-label="Object actions"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <ToolButton label="Annotate" onClick={() => store().setTool("arrow")}>
          <PenLine size={15} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton
          label="Blur"
          onClick={() => store().addEffect(id, "layer-blur")}
        >
          <Droplet size={15} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label="Copy" onClick={() => store().copyNodes([id])}>
          <Copy size={15} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton
          label="Export"
          disabled={busy}
          onClick={() => void exportImage({ nodeId: id })}
        >
          <Download size={15} strokeWidth={1.75} />
        </ToolButton>

        <div className="mx-0.5 my-1.5 w-px bg-[var(--ed-hairline)]" />

        <ToolButton
          label="More"
          expanded={menu}
          onClick={() => setMenu((v) => !v)}
        >
          <MoreHorizontal size={15} strokeWidth={1.75} />
        </ToolButton>

        {menu && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-1 min-w-[176px] rounded-[8px] border border-[color:var(--ed-hairline-strong)] p-1"
            style={{
              background: "var(--float-bg)",
              boxShadow: "var(--shadow-elevated)",
            }}
          >
            <MenuItem
              icon={<CopyPlus size={14} />}
              label="Duplicate"
              shortcut="Ctrl D"
              onClick={runMenu(() => store().duplicateNodes([id]))}
            />
            {node.type === "image" && (
              <MenuItem
                icon={<Replace size={14} />}
                label="Replace image"
                onClick={runMenu(() => fileRef.current?.click())}
              />
            )}
            <div className="my-1 h-px bg-[var(--ed-hairline)]" />
            <MenuItem
              icon={<ArrowUpToLine size={14} />}
              label="Bring to front"
              shortcut="Ctrl ⇧ ]"
              onClick={runMenu(() => store().bringToFront([id]))}
            />
            <MenuItem
              icon={<ArrowDownToLine size={14} />}
              label="Send to back"
              shortcut="Ctrl ⇧ ["
              onClick={runMenu(() => store().sendToBack([id]))}
            />
            <div className="my-1 h-px bg-[var(--ed-hairline)]" />
            <MenuItem
              icon={<Trash2 size={14} />}
              label="Delete"
              shortcut="Del"
              danger
              onClick={runMenu(() => store().removeNodes([id]))}
            />
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onReplaceFile}
      />
    </>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
  expanded,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup={expanded !== undefined ? "menu" : undefined}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      className="flex min-w-[56px] flex-col items-center justify-center gap-1 rounded-[6px] px-2 py-1.5 text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
      <span className="whitespace-nowrap text-[10px] font-medium leading-none">
        {label}
      </span>
    </button>
  );
}

function MenuItem({
  icon,
  label,
  shortcut,
  danger,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-[5px] px-2 text-[12px]",
        danger
          ? "text-[var(--ed-danger)] hover:bg-[var(--ed-danger)] hover:text-[var(--ed-on-accent)]"
          : "text-[var(--ed-text)] hover:bg-[var(--ed-elev-hover)]"
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
      {shortcut && (
        <span className="text-[11px] text-[var(--ed-text-faint)]">
          {shortcut}
        </span>
      )}
    </button>
  );
}
