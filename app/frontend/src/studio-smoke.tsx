/**
 * Studio annotation design-review harness (dev only).
 *
 * The real Studio (`StudioLayout`) needs a Tauri-backed recording: it
 * probes for a `MediaInfo` and streams the clip over the
 * `clippity-media` scheme, neither of which exists in a plain browser.
 * This entry stands a full annotation surface up without either, so the
 * timeline lane, the selection chrome, the inspector and — most usefully
 * — the live blur and pixelate preview can be reviewed and design
 * changes verified via the dev server.
 *
 * The clip is generated here: a canvas animation captured with
 * `MediaRecorder` into a blob URL. A real moving picture matters for
 * this harness in a way a still would not, because the redaction preview
 * samples the decoding element every frame and a static poster would
 * hide a whole class of lag.
 *
 * **The stage is substituted, the rest is real.** `VideoStage` builds
 * its `src` from a media token, so this supplies its own `<video>` and
 * mounts the genuine `AnnotationLayer` over it. Everything below the
 * picture — `Timeline`, `AnnotationTrack`, `AnnotationInspector` — is
 * the shipping component reading the shipping store.
 *
 * Referenced by `studio-smoke.html`. Not part of the production bundle.
 *
 * `window.__studio` is exposed so a reviewer can drive states from the
 * console, e.g.:
 *   __studio.getState().addAnnotation('blur')
 *   __studio.getState().seek(2000)
 */

import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { AnnotationInspector } from "@features/studio/components/AnnotationInspector";
import { AnnotationLayer } from "@features/studio/components/AnnotationLayer";
import { Timeline } from "@features/studio/components/Timeline";
import { TransportBar } from "@features/studio/components/TransportBar";
import { useStudioPlayer } from "@features/studio/hooks/useStudioPlayer";
import { createAnnotation } from "@features/studio/lib/annotations";
import { useStudioStore } from "@features/studio/state/studioStore";
import type { MediaInfo } from "@services/tauri/clients/media";

import "@styles/theme.css";
import "@styles/globals.css";

const WIDTH = 960;
const HEIGHT = 540;
const SECONDS = 6;

const INFO: MediaInfo = {
  id: "C:/captures/Smoke.mp4",
  token: 1,
  width: WIDTH,
  height: HEIGHT,
  durationMs: SECONDS * 1_000,
  fps: 30,
  hasAudio: false,
};

/**
 * Render a clip that looks like a screen recording: something moving,
 * and some text worth redacting.
 */
function paintFrame(ctx: CanvasRenderingContext2D, t: number): void {
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, "#1b2a4a");
  gradient.addColorStop(1, "#3a2b52");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "20px system-ui, sans-serif";
  for (let row = 0; row < 8; row += 1) {
    ctx.fillText(
      `api_key: sk-live-9f2b${row}  •  billing@example.com`,
      40,
      70 + row * 54
    );
  }
  // Something in motion, so a lagging preview is visible as lag.
  ctx.fillStyle = "#ffcc00";
  ctx.beginPath();
  ctx.arc(120 + ((t * 220) % (WIDTH - 240)), HEIGHT - 60, 16, 0, Math.PI * 2);
  ctx.fill();
}

/** Capture the animation to a blob URL the `<video>` can play. */
async function recordClip(): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d")!;
  const stream = canvas.captureStream(30);
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
  recorder.ondataavailable = (event) => chunks.push(event.data);

  const finished = new Promise<string>((resolve) => {
    recorder.onstop = () =>
      resolve(URL.createObjectURL(new Blob(chunks, { type: "video/webm" })));
  });

  recorder.start();
  const started = performance.now();
  // A timer rather than `requestAnimationFrame`: rAF does not fire while
  // the page is not compositing — a hidden tab, or a preview pane that
  // is not on screen — and the harness would sit on "Recording…"
  // forever with nothing to say about why. Timers still run there, just
  // throttled, so the clip comes out choppy instead of never.
  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsed = (performance.now() - started) / 1_000;
      paintFrame(ctx, elapsed);
      if (elapsed >= SECONDS) {
        recorder.stop();
        resolve();
        return;
      }
      window.setTimeout(tick, 1_000 / 30);
    };
    tick();
  });
  return finished;
}

function StudioSmoke() {
  const [src, setSrc] = useState<string | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const seeded = useRef(false);

  useEffect(() => {
    void recordClip().then(setSrc);
  }, []);

  // Seed once the store is ready to describe a clip, with one of every
  // kind already placed — the point of the harness is to see them.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const store = useStudioStore.getState();
    store.open(INFO.id);
    store.loaded(INFO);
    store.setAnnotations([
      {
        ...createAnnotation("box", 0, 6_000),
        rect: { x: 0.03, y: 0.08, w: 0.45, h: 0.16 },
      },
      {
        ...createAnnotation("text", 0, 6_000),
        rect: { x: 0.55, y: 0.06, w: 0.4, h: 0.2 },
        text: "Studio annotation harness",
      },
      {
        ...createAnnotation("arrow", 0, 6_000),
        rect: { x: 0.6, y: 0.3, w: 0.3, h: 0.3 },
      },
      {
        ...createAnnotation("blur", 0, 3_000),
        rect: { x: 0.03, y: 0.3, w: 0.45, h: 0.14 },
      },
      {
        ...createAnnotation("pixelate", 3_000, 3_000),
        rect: { x: 0.03, y: 0.5, w: 0.45, h: 0.14 },
      },
    ]);
  }, []);

  // The real hook, driving the real element. It owns position mirroring,
  // seeks, range looping and the duration correction — hand-rolling any
  // of that here would make the harness agree with itself rather than
  // with the app, and a seek applied by the timeline would be clobbered
  // by a competing clock.
  useStudioPlayer(video);

  return (
    <div className="clippity-editor flex h-screen w-screen flex-col overflow-hidden">
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        style={{ background: "#0b0e14" }}
      >
        {src ? (
          <>
            <video
              ref={setVideo}
              src={src}
              // No `autoPlay`/`loop`: the store drives playback through
              // `useStudioPlayer`, and range looping is its job.
              muted
              playsInline
              className="max-h-full max-w-full object-contain"
              style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
            />
            <AnnotationLayer video={video} />
          </>
        ) : (
          <p className="text-[13px]" style={{ color: "var(--ed-text-faint)" }}>
            Recording a sample clip…
          </p>
        )}
      </div>
      <Timeline />
      <TransportBar />
      <AnnotationInspector />
    </div>
  );
}

(window as unknown as { __studio: typeof useStudioStore }).__studio =
  useStudioStore;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StudioSmoke />
  </StrictMode>
);
