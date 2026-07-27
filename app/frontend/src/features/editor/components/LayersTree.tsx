import { useEffect, useState } from "react";
import type { DragEvent, ReactElement } from "react";

import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
  Frame,
  Image,
  Lock,
  LockOpen,
  Slash,
  Spline,
  Square,
  Star,
  Triangle,
  Type,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@shared/lib/cn";

import { editorSelectors, useEditorStore } from "../state/editorStore";
import type { NodeType, SceneNode } from "../types";

export const TYPE_ICON: Record<NodeType, LucideIcon> = {
  frame: Frame,
  rectangle: Square,
  ellipse: Circle,
  image: Image,
  text: Type,
  line: Slash,
  arrow: ArrowUpRight,
  polygon: Triangle,
  star: Star,
  path: Spline,
};

type DropEdge = "before" | "after";

interface DropTarget {
  id: string;
  edge: DropEdge;
}

/** Id of the row currently being dragged. Module-level because the native DnD
 *  `dataTransfer` payload is unreadable during `dragover`, where we still need
 *  to know the source to skip self-targeting. */
let draggedId: string | null = null;

/**
 * Layer tree for the scene. Renders the scene graph top-to-bottom (the scene's
 * `rootIds` in array order, index 0 at the top), recursing into frames. Rows
 * support selection, rename, lock/visibility toggles, collapse, and native
 * drag-to-reorder via `reorderNode`.
 */
export function LayersTree() {
  const rootIds = useEditorStore((s) => editorSelectors.childIds(s, null));
  const nodes = useEditorStore((s) => s.nodes);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const select = useEditorStore((s) => s.select);
  const toggleSelection = useEditorStore((s) => s.toggleSelection);
  const reorderNode = useEditorStore((s) => s.reorderNode);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelect = (id: string, additive: boolean) => {
    if (additive) toggleSelection(id);
    else select([id]);
  };

  const handleDragStart = (id: string) => {
    draggedId = id;
  };

  const handleDragEnd = () => {
    draggedId = null;
    setDropTarget(null);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (!draggedId) return;
    e.preventDefault();
    if (id === draggedId) {
      setDropTarget(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const edge: DropEdge =
      e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDropTarget((prev) =>
      prev && prev.id === id && prev.edge === edge ? prev : { id, edge }
    );
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, id: string) => {
    e.preventDefault();
    const dragged = draggedId;
    draggedId = null;
    setDropTarget(null);
    if (!dragged || dragged === id) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const edge: DropEdge =
      e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    // The list shows front-to-back (topmost layer first), the reverse of the
    // paint array, so a visual "before"/"after" maps to the opposite array edge.
    reorderNode(dragged, id, edge === "before" ? "after" : "before");
  };

  const rows: ReactElement[] = [];
  const walk = (ids: readonly string[], depth: number) => {
    // Render front-to-back: the last-painted (frontmost) child sits at the top.
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]!;
      const node = nodes[id];
      if (!node) continue;
      const children = node.type === "frame" ? node.children : [];
      const hasChildren = children.length > 0;
      const isCollapsed = collapsed.has(id);
      rows.push(
        <LayerRow
          key={id}
          node={node}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={isCollapsed}
          selected={selectedIds.includes(id)}
          dropEdge={dropTarget && dropTarget.id === id ? dropTarget.edge : null}
          onToggleCollapse={toggleCollapse}
          onSelect={handleSelect}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOverRow={handleDragOver}
          onDropRow={handleDrop}
        />
      );
      if (hasChildren && !isCollapsed) walk(children, depth + 1);
    }
  };
  walk(rootIds, 0);

  return <div className="py-1">{rows}</div>;
}

interface LayerRowProps {
  node: SceneNode;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  selected: boolean;
  dropEdge: DropEdge | null;
  onToggleCollapse: (id: string) => void;
  onSelect: (id: string, additive: boolean) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOverRow: (e: DragEvent<HTMLDivElement>, id: string) => void;
  onDropRow: (e: DragEvent<HTMLDivElement>, id: string) => void;
}

function LayerRow({
  node,
  depth,
  hasChildren,
  collapsed,
  selected,
  dropEdge,
  onToggleCollapse,
  onSelect,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDropRow,
}: LayerRowProps) {
  const setVisible = useEditorStore((s) => s.setVisible);
  const setLocked = useEditorStore((s) => s.setLocked);
  const renameNode = useEditorStore((s) => s.renameNode);
  const renameRequested = useEditorStore((s) => s.renamingId === node.id);
  const clearRename = useEditorStore((s) => s.clearRename);

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(node.name);

  // The context menu's "Rename" flips this node's id into the store; consume it
  // by entering inline edit, then clear the request.
  useEffect(() => {
    if (renameRequested) {
      setValue(node.name);
      setEditing(true);
      clearRename();
    }
  }, [renameRequested, node.name, clearRename]);

  const Icon = TYPE_ICON[node.type];
  const dimmed = !node.visible;

  const commit = () => {
    renameNode(node.id, value.trim() || node.name);
    setEditing(false);
  };
  const cancel = () => {
    setValue(node.name);
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "group relative flex h-7 select-none items-center gap-1.5 pr-2 text-[12px]",
        selected
          ? "bg-[var(--ed-accent-soft)]"
          : "hover:bg-[var(--ed-elev-hover)]"
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", node.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(node.id);
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => onDragOverRow(e, node.id)}
      onDrop={(e) => onDropRow(e, node.id)}
      onClick={(e) => {
        if (editing) return;
        onSelect(node.id, e.shiftKey || e.metaKey || e.ctrlKey);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        // Claims the click so the window-level fallback stays out of it —
        // see the note on `EditorCanvas`'s handler.
        e.stopPropagation();
        if (!selected) onSelect(node.id, false);
        useEditorStore.getState().openContextMenu({
          x: e.clientX,
          y: e.clientY,
          sceneX: 0,
          sceneY: 0,
          kind: "node",
        });
      }}
    >
      {selected && (
        <span className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-[var(--ed-accent)]" />
      )}
      {dropEdge === "before" && (
        <span className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-[var(--ed-accent)]" />
      )}
      {dropEdge === "after" && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-[var(--ed-accent)]" />
      )}

      {hasChildren ? (
        <button
          type="button"
          className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--ed-text-dim)]"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse(node.id);
          }}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0" />
      )}

      <Icon
        size={13}
        className={cn(
          "shrink-0",
          dimmed ? "text-[var(--ed-text-faint)]" : "text-[var(--ed-text-dim)]"
        )}
      />

      {editing ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={commit}
          className="min-w-0 flex-1 rounded-[3px] bg-[var(--ed-input-bg)] px-1 text-[12px] text-[var(--ed-text)] outline-none"
        />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            dimmed
              ? "text-[var(--ed-text-faint)]"
              : selected
                ? "text-[var(--ed-text)]"
                : "text-[var(--ed-text-dim)]"
          )}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setValue(node.name);
            setEditing(true);
          }}
        >
          {node.name}
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-[3px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev-hover)] hover:text-[var(--ed-text)]",
            node.locked ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          )}
          onClick={(e) => {
            e.stopPropagation();
            setLocked(node.id, !node.locked);
          }}
        >
          {node.locked ? <Lock size={13} /> : <LockOpen size={13} />}
        </button>
        <button
          type="button"
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-[3px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev-hover)] hover:text-[var(--ed-text)]",
            node.visible ? "opacity-0 group-hover:opacity-100" : "opacity-100"
          )}
          onClick={(e) => {
            e.stopPropagation();
            setVisible(node.id, !node.visible);
          }}
        >
          {node.visible ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      </div>
    </div>
  );
}
