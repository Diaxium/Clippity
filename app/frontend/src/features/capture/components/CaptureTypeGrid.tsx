import { useCaptureStore } from "../state/captureStore";
import { CAPTURE_TYPES } from "../modes";
import { ModeTile } from "./ModeTile";

interface CaptureTypeGridProps {
  /** Compact = single icon row, no description text. */
  compact?: boolean;
}

/**
 * The four top-level capture-type tiles. Reads + writes
 * `captureType` directly from the feature store.
 */
export function CaptureTypeGrid({ compact = false }: CaptureTypeGridProps) {
  const captureType = useCaptureStore((s) => s.captureType);
  const setCaptureType = useCaptureStore((s) => s.setCaptureType);

  return (
    <div
      className={
        compact
          ? "flex items-center gap-1.5"
          : "grid grid-cols-2 gap-3 sm:grid-cols-4"
      }
    >
      {CAPTURE_TYPES.map((def) => (
        <ModeTile
          key={def.id}
          def={def}
          active={def.id === captureType}
          showDetails={!compact}
          onSelect={setCaptureType}
        />
      ))}
    </div>
  );
}
