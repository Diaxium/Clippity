import { useEffect, useState } from "react";

import {
  modelsCheckUpdates,
  modelsList,
  onModelsChanged,
  onModelsProgress,
  type ModelInfo,
  type ReleaseCheck,
} from "@services/tauri/clients/models";
import { createLogger } from "@shared/lib/logger";

const log = createLogger("settings");

/**
 * Live model-manager state for the Models settings page.
 *
 * Hydrates from `models_list` on mount, then converges via two event
 * streams: `models/changed` replaces the whole list on any status
 * transition (download start / done / error / cancel / removal), and
 * `models/progress` patches byte counts into the affected row between
 * transitions. A progress tick can race ahead of its `changed` event
 * (the emit order isn't guaranteed across threads), so the patch also
 * flips the row's phase to `downloading`.
 *
 * `null` until the first fetch resolves — the panel renders a skeleton.
 */
export function useModels(): ModelInfo[] | null {
  const [models, setModels] = useState<ModelInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    modelsList()
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch((err) => {
        log.warn("failed to load models", err);
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => onModelsChanged(setModels), []);

  useEffect(
    () =>
      onModelsProgress((p) => {
        setModels((prev) =>
          prev
            ? prev.map((m) =>
                m.id === p.id
                  ? {
                      ...m,
                      phase: "downloading",
                      downloaded: p.downloaded,
                      total: p.total,
                    }
                  : m
              )
            : prev
        );
      }),
    []
  );

  return models;
}

/**
 * Live "is my model the latest published release" check for the Models
 * page, keyed by model id.
 *
 * Fires the best-effort network check ({@link modelsCheckUpdates}) once on
 * mount — the user asked for this to run automatically when the page opens.
 * A failed or offline check resolves to an empty map, so the page silently
 * falls back to its offline registry status; reachable GitHub-hosted models
 * get a verdict. Re-checks whenever a `models/changed` transition lands
 * (e.g. right after a self-update completes) so the "newer release" badge
 * clears without a manual refresh.
 *
 * `null` until the first check settles — lets the panel distinguish
 * "checking…" from "checked, nothing to report".
 */
export function useReleaseChecks(): Record<string, ReleaseCheck> | null {
  const [checks, setChecks] = useState<Record<string, ReleaseCheck> | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      modelsCheckUpdates()
        .then((list) => {
          if (cancelled) return;
          setChecks(Object.fromEntries(list.map((c) => [c.id, c])));
        })
        .catch((err) => {
          log.warn("release check failed", err);
          if (!cancelled) setChecks({});
        });
    };
    refresh();
    // A completed download/update flips disk state; re-check so the badge
    // reflects the new reality.
    const off = onModelsChanged(refresh);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return checks;
}
