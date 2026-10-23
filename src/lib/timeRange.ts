import { useCallback, useEffect, useRef, useState } from "react";
import { api, type R } from "./api";
import { formatShortDate } from "./format";
import { TIME_PRESET_LABELS } from "./labels";
import type { TimePreset, TimeRange } from "../types";

/*
 * Top-bar time range store (§13.0). The server computes the instants (GET /api/teacher/time-range); the client keeps
 * the choice in the URL (`?range=since_last_class` or `?range=custom&from=&to=`) and in sessionStorage. Frozen.
 */

export const TIME_PRESETS: readonly TimePreset[] = ["this_class", "since_last_class", "this_week", "last_7_days", "whole_term", "custom"];
export const DEFAULT_TIME_PRESET: TimePreset = "since_last_class";
const STORAGE_KEY = "kiwi-time-range";

export interface TimeSelection { preset: TimePreset; from?: string; to?: string }

export function isTimePreset(value: unknown): value is TimePreset {
  return typeof value === "string" && (TIME_PRESETS as readonly string[]).includes(value);
}

/** Reads `?range=` (and `from`/`to` for custom). Returns null when absent or invalid. */
export function parseTimeSelection(search: string): TimeSelection | null {
  const params = new URLSearchParams(search);
  const preset = params.get("range");
  if (!isTimePreset(preset)) return null;
  if (preset !== "custom") return { preset };
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  return from && to ? { preset, from, to } : null;
}

/** Writes the selection into a query string, keeping every other parameter. */
export function applyTimeSelection(search: string, selection: TimeSelection): string {
  const params = new URLSearchParams(search);
  params.set("range", selection.preset);
  if (selection.preset === "custom" && selection.from && selection.to) {
    params.set("from", selection.from);
    params.set("to", selection.to);
  } else {
    params.delete("from");
    params.delete("to");
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function readStoredSelection(): TimeSelection | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<TimeSelection>;
    if (!isTimePreset(value.preset)) return null;
    if (value.preset === "custom") return value.from && value.to ? { preset: "custom", from: value.from, to: value.to } : null;
    return { preset: value.preset };
  } catch {
    return null; // storage unavailable or corrupt: fall back to the default preset
  }
}

export function storeSelection(selection: TimeSelection): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // WHY: the URL still carries the choice; storage only restores it on pages without ?range.
  }
}

export function initialTimeSelection(search: string): TimeSelection {
  return parseTimeSelection(search) ?? readStoredSelection() ?? { preset: DEFAULT_TIME_PRESET };
}

const sameSelection = (a: TimeSelection, b: TimeSelection) => a.preset === b.preset && a.from === b.from && a.to === b.to;

function inclusiveEnd(to: string | undefined): string | undefined {
  const ms = to ? Date.parse(to) : NaN;
  return Number.isFinite(ms) ? new Date(ms - 1).toISOString() : to;
}

/** Client-side stand-in used until the server answers (or when it cannot): no instants, preset label only. */
export function fallbackTimeRange(selection: TimeSelection, note?: string): TimeRange {
  const custom = selection.preset === "custom" && selection.from && selection.to;
  return {
    preset: selection.preset,
    effectivePreset: selection.preset,
    from: custom ? selection.from ?? null : null,
    to: custom ? selection.to ?? null : null,
    compareFrom: null,
    compareTo: null,
    // S-m03: `to` is end-exclusive (the next midnight), so the label names the day before it
    label: custom ? `${formatShortDate(selection.from)} – ${formatShortDate(inclusiveEnd(selection.to))}` : TIME_PRESET_LABELS[selection.preset],
    compareLabel: null,
    ...(note ? { note } : {}),
  };
}

/** Query parameters for Insights/Home endpoints (`from`, `to`, `compareFrom`, `compareTo`). */
export function rangeQuery(range: TimeRange): R {
  const out: R = {};
  if (range.from) out.from = range.from;
  if (range.to) out.to = range.to;
  if (range.compareFrom) out.compareFrom = range.compareFrom;
  if (range.compareTo) out.compareTo = range.compareTo;
  return out;
}

export interface TimeRangeStore {
  timeRange: TimeRange;
  selection: TimeSelection;
  setTimePreset: (preset: TimePreset, custom?: { from: string; to: string }) => void;
  loading: boolean;
  error: string;
}

/** Shared by Home and every Insights page through TeacherContext. `enabled=false` skips the request (signed out). */
export function useTimeRange(classId: string, enabled = true): TimeRangeStore {
  const [selection, setSelection] = useState<TimeSelection>(() => initialTimeSelection(location.search));
  const [timeRange, setTimeRange] = useState<TimeRange>(() => fallbackTimeRange(selection));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(selection);
  current.current = selection;

  useEffect(() => {
    const sync = () => {
      const fromUrl = parseTimeSelection(location.search);
      if (fromUrl && !sameSelection(fromUrl, current.current)) setSelection(fromUrl);
    };
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    if (!enabled || !classId) return;
    let active = true;
    setLoading(true);
    setTimeRange(fallbackTimeRange(selection));
    const custom = selection.preset === "custom" ? { from: selection.from, to: selection.to } : undefined;
    api
      .timeRange(classId, selection.preset, custom)
      .then((range) => {
        if (!active) return;
        setTimeRange(range);
        setError("");
      })
      .catch((e: unknown) => {
        if (!active) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(`Time range unavailable: ${message}`);
        setTimeRange(fallbackTimeRange(selection, "Showing all activity because the time range could not be computed."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [classId, enabled, selection]);

  const setTimePreset = useCallback((preset: TimePreset, custom?: { from: string; to: string }) => {
    const next: TimeSelection = preset === "custom" && custom ? { preset, from: custom.from, to: custom.to } : { preset: preset === "custom" ? DEFAULT_TIME_PRESET : preset };
    storeSelection(next);
    setSelection(next);
    const search = applyTimeSelection(location.search, next);
    history.replaceState(history.state, "", `${location.pathname}${search}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  return { timeRange, selection, setTimePreset, loading, error };
}
