import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Camera, ImageIcon, Plus, Trash2 } from "lucide-react";

import { listWebcams } from "@services/tauri/clients/recorder";
import type {
  Source,
  WebcamDeviceInfo,
} from "@services/tauri/clients/recorder";
import { Select, TickedSlider, ToggleSwitch } from "@shared/ui";

import { CORNER_PRESETS, MAX_SOURCES } from "../constants";
import { SectionCard } from "./SectionCard";

/** Sentinel for "whichever camera is first". Mirrors how the audio
 *  device pickers spell "system default". */
const FIRST_CAMERA = "";

interface SourcesCardProps {
  value: Source[];
  onChange(next: Source[]): void;
}

/**
 * Settings → Recording → Sources (ADR 0033) — the things composited over
 * a recording.
 *
 * **Position is a corner preset, not a drag surface.** Free positioning
 * wants a live preview of the frame to drag on, and a recording's frame
 * is whatever the user is about to point at — which does not exist yet
 * when this panel is open. Corners cover what people actually do with a
 * webcam, and because the rect is normalized the same choice lands
 * correctly on any region or monitor.
 *
 * Empty by default. A camera that only turns on when the user says so is
 * the same privacy rule the microphone follows.
 */
export function SourcesCard({ value, onChange }: SourcesCardProps) {
  const cameras = useWebcams();

  const update = (index: number, patch: Partial<Source>) =>
    onChange(
      value.map((s, i) => (i === index ? ({ ...s, ...patch } as Source) : s))
    );

  const remove = (index: number) =>
    onChange(value.filter((_, i) => i !== index));

  const addWebcam = () =>
    onChange([
      ...value,
      {
        kind: "webcam",
        deviceId: null,
        rect: CORNER_PRESETS[3]!.rect,
        opacityPct: 100,
        enabled: true,
      },
    ]);

  const addImage = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [
          { name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] },
        ],
      });
      if (typeof picked !== "string") return;
      onChange([
        ...value,
        {
          kind: "image",
          path: picked,
          rect: CORNER_PRESETS[1]!.rect,
          opacityPct: 100,
          enabled: true,
        },
      ]);
    } catch {
      /* not in a Tauri context / dialog dismissed */
    }
  };

  const full = value.length >= MAX_SOURCES;

  return (
    <SectionCard title="Sources">
      {value.length === 0 && (
        <p className="px-5 py-4 text-[12.5px] text-[var(--color-hint)]">
          Nothing is drawn over your recordings. Add a camera or an image to put
          it in a corner of every session.
        </p>
      )}

      {value.map((source, index) => (
        <div
          key={index}
          className="flex flex-col gap-2 border-t border-[color:var(--hairline)] px-5 py-3 first:border-t-0"
        >
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--color-tile-cool)] text-[var(--color-tile-cool-ink)]">
              {source.kind === "webcam" ? (
                <Camera size={14} strokeWidth={1.9} />
              ) : (
                <ImageIcon size={14} strokeWidth={1.9} />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-ink)]">
              {source.kind === "webcam"
                ? nameOf(cameras, source.deviceId)
                : baseName(source.path)}
            </span>
            <ToggleSwitch
              checked={source.enabled ?? true}
              onChange={(enabled) => update(index, { enabled })}
              label={`Enable source ${index + 1}`}
            />
            <button
              type="button"
              aria-label={`Remove source ${index + 1}`}
              onClick={() => remove(index)}
              className="focus-ring grid h-7 w-7 place-items-center rounded-lg text-[var(--color-hint)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
            >
              <Trash2 size={13} strokeWidth={2} />
            </button>
          </div>

          {source.kind === "webcam" && (
            <label className="flex items-center gap-2 text-[12px] text-[var(--color-hint)]">
              <span className="w-16 shrink-0">Camera</span>
              <Select
                value={source.deviceId ?? FIRST_CAMERA}
                options={cameras}
                ariaLabel={`Camera for source ${index + 1}`}
                onChange={(id) =>
                  update(index, {
                    deviceId: id === FIRST_CAMERA ? null : id,
                  } as Partial<Source>)
                }
              />
            </label>
          )}

          <label className="flex items-center gap-2 text-[12px] text-[var(--color-hint)]">
            <span className="w-16 shrink-0">Position</span>
            <Select
              value={cornerKeyOf(source)}
              options={CORNER_PRESETS.map((c) => ({
                value: c.key,
                label: c.label,
              }))}
              ariaLabel={`Position for source ${index + 1}`}
              onChange={(key) => {
                const preset = CORNER_PRESETS.find((c) => c.key === key);
                if (preset) update(index, { rect: preset.rect });
              }}
            />
          </label>

          <label className="flex items-center gap-2 text-[12px] text-[var(--color-hint)]">
            <span className="w-16 shrink-0">Opacity</span>
            <TickedSlider
              value={source.opacityPct ?? 100}
              min={0}
              max={100}
              step={5}
              tickStep={25}
              onChange={(opacityPct) => update(index, { opacityPct })}
              ariaLabel={`Opacity for source ${index + 1}`}
              formatValue={(v) => `${v}%`}
            />
          </label>
        </div>
      ))}

      <div className="flex items-center gap-2 border-t border-[color:var(--hairline)] px-5 py-3">
        <button
          type="button"
          disabled={full}
          onClick={addWebcam}
          className="focus-ring inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-overlay-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[color:var(--color-overlay-3)] disabled:opacity-50"
        >
          <Plus size={13} strokeWidth={2} />
          Camera
        </button>
        <button
          type="button"
          disabled={full}
          onClick={() => void addImage()}
          className="focus-ring inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-overlay-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[color:var(--color-overlay-3)] disabled:opacity-50"
        >
          <Plus size={13} strokeWidth={2} />
          Image
        </button>
        <span className="ml-auto text-[11.5px] text-[var(--color-hint)]">
          {full
            ? `${MAX_SOURCES} is the maximum`
            : "Later sources draw over earlier ones"}
        </span>
      </div>
    </SectionCard>
  );
}

/** Which corner preset a source's rect matches, or the first as a
 *  fallback for a rect a preset didn't produce (a preset saved by a
 *  future build, a hand-edited settings file). */
function cornerKeyOf(source: Source): string {
  const match = CORNER_PRESETS.find(
    (c) =>
      Math.abs(c.rect.x - source.rect.x) < 0.001 &&
      Math.abs(c.rect.y - source.rect.y) < 0.001 &&
      Math.abs(c.rect.w - source.rect.w) < 0.001
  );
  return (match ?? CORNER_PRESETS[0]!).key;
}

function nameOf(
  cameras: readonly { value: string; label: string }[],
  deviceId: string | null | undefined
): string {
  if (!deviceId) return cameras[0]?.label ?? "Camera";
  return cameras.find((c) => c.value === deviceId)?.label ?? "Camera";
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Attached cameras, led by a "first available" entry.
 *
 * Enumeration failing is not worth surfacing, for the same reason the
 * audio device lists don't: the fallback is exactly what an unpinned
 * source already means.
 */
function useWebcams() {
  const [options, setOptions] = useState([
    { value: FIRST_CAMERA, label: "First available" },
  ]);

  useEffect(() => {
    let live = true;
    void listWebcams()
      .then((devices: WebcamDeviceInfo[]) => {
        if (!live) return;
        setOptions([
          { value: FIRST_CAMERA, label: "First available" },
          ...devices.map((d) => ({ value: d.id, label: d.name })),
        ]);
      })
      .catch(() => {
        /* Keep the fallback-only list. */
      });
    return () => {
      live = false;
    };
  }, []);

  return options;
}
