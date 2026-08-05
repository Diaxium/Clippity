import { useEffect } from "react";

import { useStudioStore } from "../state/studioStore";
import { nextPlayheadWithinRange } from "../lib/trim";

/**
 * Read the element's position into the store, correcting it back into
 * the trimmed range if it has escaped.
 *
 * The one place playback position is interpreted, shared by both clocks
 * below so they cannot enforce different ranges.
 */
function syncFromElement(element: HTMLVideoElement): void {
  const store = useStudioStore.getState();
  // The user is dragging the playhead: the store leads and the element
  // follows, so anything the element has to say about its position is
  // already out of date. `syncPosition` refuses it too — this returns
  // early so the range correction below cannot seek out from under the
  // drag either.
  if (store.scrubbing) return;

  const ms = element.currentTime * 1000;

  // Keep *playback* inside the trim. Previewing a cut has to show the
  // cut — running past the out-point plays footage the export will not
  // contain, which makes the handles feel decorative.
  //
  // Two cases are deliberately exempt, and both are about not fighting
  // the user for the playhead:
  //
  // `playing` — a **paused** playhead goes wherever it is put. Someone
  // reviewing what a trim discards has to be able to scrub into the
  // discarded part; snapping them back into the range would make the
  // excluded footage unreachable the moment the handles moved.
  //
  // `dragging` — pulling the out-point back past the playhead should
  // scrub to it, not yank playback to the start mid-gesture.
  const correction =
    store.playing && !store.dragging
      ? nextPlayheadWithinRange(ms, store.range)
      : null;
  if (correction !== null) {
    store.seek(correction);
  } else {
    store.syncPosition(ms);
  }
}

/**
 * Bind a `<video>` element to the store: mirror its position out, apply
 * requested seeks in, and hold playback inside the trimmed range.
 *
 * **Two clocks drive this, and neither is redundant.**
 *
 * `requestAnimationFrame` reads `currentTime` at the display's rate,
 * which is what a playhead needs to track smoothly against a timeline
 * the user is about to cut on — `timeupdate`'s four events per second
 * is fine for a progress bar and visibly stuttery for this.
 *
 * But rAF does not run at all when the page is hidden, and a WebView2
 * window that is occluded (or on another virtual desktop) *is* hidden.
 * With the range enforced only there, minimising Studio mid-playback
 * would let the clip run past its out-point and keep going to the end
 * of the file — a real escape, not a cosmetic one, since the user comes
 * back to a playhead outside the range they set.
 *
 * So `timeupdate` carries the correctness guarantee, because it fires
 * regardless of visibility, and rAF carries the smoothness. Bounded
 * overshoot when nobody is watching; frame-accurate looping when they
 * are. Both call {@link syncFromElement}, so there is one definition of
 * where the playhead is allowed to be.
 *
 * **Takes the element, not a ref to it.** A `RefObject` is stable across
 * renders, so an effect that depends on one runs exactly once — and if
 * `.current` happened to be null on that single pass, the listeners
 * below are never attached and nothing ever re-attaches them. The
 * failure is silent and looks intermittent, because a later remount can
 * make it work. Depending on the element itself means every effect here
 * re-runs the moment a `<video>` appears, is replaced, or goes away.
 */
export function useStudioPlayer(element: HTMLVideoElement | null): void {
  const playing = useStudioStore((s) => s.playing);
  const seekMs = useStudioStore((s) => s.seekMs);
  const seekNonce = useStudioStore((s) => s.seekNonce);
  const volume = useStudioStore((s) => s.volume);
  const muted = useStudioStore((s) => s.muted);

  // ---- store → element: play / pause ----
  useEffect(() => {
    if (!element) return;
    if (playing) {
      // A rejected play() is normal (an interrupted load, an autoplay
      // policy), and must put the store back rather than leaving the
      // transport showing a pause button over a stopped video.
      void element
        .play()
        .catch(() => useStudioStore.getState().setPlaying(false));
    } else {
      element.pause();
    }
  }, [playing, element]);

  // ---- store → element: seeks ----
  // Keyed on the nonce, not the position, so seeking to where the
  // playhead already is still moves the element.
  useEffect(() => {
    if (!element) return;
    element.currentTime = seekMs / 1000;
    // The dependency on seekMs is deliberate but the nonce is what makes
    // this fire; see the store's note.
  }, [seekNonce, seekMs, element]);

  // ---- store → element: audio ----
  useEffect(() => {
    if (!element) return;
    element.volume = volume;
    element.muted = muted;
  }, [volume, muted, element]);

  // ---- element → store: smooth position, while visible ----
  useEffect(() => {
    if (!playing || !element) return;
    let frame = 0;

    const tick = () => {
      syncFromElement(element);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, element]);

  // ---- element → store: everything a rAF loop can't see ----
  useEffect(() => {
    if (!element) return;

    const store = () => useStudioStore.getState();
    // The element pauses on its own at the end of the file, and can be
    // paused by the OS media keys. Without these the transport's button
    // would disagree with what is on screen.
    const onPlay = () => store().setPlaying(true);
    const onPause = () => store().setPlaying(false);
    // A seek performed while paused still has to move the readout — the
    // rAF loop isn't running to notice it.
    const onSeeked = () => {
      if (!store().playing) store().syncPosition(element.currentTime * 1000);
    };
    const onEnded = () => store().setPlaying(false);
    // The clock that survives an occluded window — see the hook's note.
    const onTimeUpdate = () => syncFromElement(element);
    /**
     * The element's own idea of how long the clip is.
     *
     * Listened to on both events on purpose. `loadedmetadata` is when a
     * plain file's duration first exists; `durationchange` is when a
     * *fragmented* one's is revised, which it is — a fragmented MP4 can
     * report `Infinity`, then a first estimate, then the truth as more
     * of the container is read. Taking only the first answer leaves the
     * timeline describing a clip that isn't there.
     */
    const onDuration = () => store().reconcileDuration(element.duration * 1000);

    element.addEventListener("play", onPlay);
    element.addEventListener("pause", onPause);
    element.addEventListener("seeked", onSeeked);
    element.addEventListener("ended", onEnded);
    element.addEventListener("timeupdate", onTimeUpdate);
    element.addEventListener("loadedmetadata", onDuration);
    element.addEventListener("durationchange", onDuration);
    // The element may already have metadata by the time this runs — a
    // cached clip, or a re-render after load — in which case neither
    // event fires again and the correction would never happen.
    onDuration();
    return () => {
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("seeked", onSeeked);
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("timeupdate", onTimeUpdate);
      element.removeEventListener("loadedmetadata", onDuration);
      element.removeEventListener("durationchange", onDuration);
    };
  }, [element]);
}
