import { useCaptureStore } from "../state/captureStore";
import { RECORD_FORMATS, RECORD_TARGETS } from "../recordModes";
import { ModeTile } from "./ModeTile";

/**
 * The recording-target tiles — the Record screen's counterpart to
 * `CaptureTypeGrid`. Reads + writes `recordTarget` directly from the
 * feature store.
 */
export function RecordTypeGrid() {
  const target = useCaptureStore((s) => s.recordTarget);
  const setTarget = useCaptureStore((s) => s.setRecordTarget);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {RECORD_TARGETS.map((def) => (
        <ModeTile
          key={def.id}
          def={def}
          active={def.id === target}
          onSelect={setTarget}
        />
      ))}
    </div>
  );
}

/**
 * The output-format tiles.
 *
 * Its own section rather than a row in the options panel because the
 * choice changes what the rest of the screen means: GIF has no audio
 * track and a much lower frame-rate ceiling, so the options below
 * reshape when it is picked.
 */
export function RecordFormatGrid() {
  const format = useCaptureStore((s) => s.recordFormat);
  const setFormat = useCaptureStore((s) => s.setRecordFormat);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {RECORD_FORMATS.map((def) => (
        <ModeTile
          key={def.id}
          def={def}
          active={def.id === format}
          onSelect={setFormat}
        />
      ))}
    </div>
  );
}
