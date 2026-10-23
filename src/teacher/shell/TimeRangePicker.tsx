import { useEffect, useState, type JSX } from "react";
import { displayTimeZone, fromDateTimeLocal, toDateTimeLocal } from "../../lib/format";
import { LABELS, TIME_PRESET_LABELS } from "../../lib/labels";
import { TIME_PRESETS } from "../../lib/timeRange";
import { teacherPaths } from "../../lib/routes";
import { navigate } from "../../lib/navigation";
import { useTeacher } from "./TeacherContext";
import type { TimePreset, TimeRange } from "../../types";

/*
 * Top-bar `Time: Since last class ▾` (§3.1, §13.0) — owned by INSIGHTS. One picker drives Home and every Insights page.
 * When a class-based preset falls back (no class meetings), the selected option keeps its own name and says what is
 * shown instead, and the note is visible next to the picker (not only in a tooltip).
 */

/**
 * Converts YYYY-MM-DD to an ISO instant at midnight in the course time zone (S-m03: not the browser's zone);
 * `endOfDay` returns the next midnight (ranges are end-exclusive, so the To date is included).
 */
export function dateInputToIso(value: string, endOfDay = false, timeZone: string | undefined = displayTimeZone()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const given = new Date(Date.UTC(y, m - 1, d));
  if (given.getUTCFullYear() !== y || given.getUTCMonth() !== m - 1 || given.getUTCDate() !== d) return null;
  const day = new Date(Date.UTC(y, m - 1, d + (endOfDay ? 1 : 0)));
  return fromDateTimeLocal(`${day.toISOString().slice(0, 10)}T00:00`, timeZone);
}

/** S-m03: the From/To date inputs of an applied custom range (To is inclusive: the day before the exclusive end). */
export function isoToDateInputs(from: string | null, to: string | null, timeZone: string | undefined = displayTimeZone()): { from: string; to: string } {
  const start = from ? toDateTimeLocal(from, timeZone).slice(0, 10) : "";
  const last = to && Number.isFinite(Date.parse(to)) ? toDateTimeLocal(new Date(Date.parse(to) - 1).toISOString(), timeZone).slice(0, 10) : "";
  return { from: start, to: last };
}

/** True when the server answered with a different effective preset (e.g. Since last class → Last 7 days). */
export function isFallback(range: TimeRange): boolean {
  return range.effectivePreset !== range.preset;
}

/**
 * Option text: the selected preset shows the server label ("Since last class (Tue 10/20)"); a fallback keeps the preset
 * name ("Since last class · showing last 7 days") so no two options read the same.
 */
export function presetOptionLabel(preset: TimePreset, range: TimeRange): string {
  if (preset === "custom" || preset !== range.preset) return TIME_PRESET_LABELS[preset];
  if (isFallback(range)) return `${TIME_PRESET_LABELS[preset]} (${TIME_PRESET_LABELS[range.effectivePreset].toLowerCase()})`;
  return range.label || TIME_PRESET_LABELS[preset];
}

/** Full fallback note (server text), shown as the note's tooltip; null when the preset applied as chosen. */
export function fallbackNote(range: TimeRange): string | null {
  if (!isFallback(range)) return null;
  return range.note || `Showing ${TIME_PRESET_LABELS[range.effectivePreset].toLowerCase()}`;
}

/** Short visible text next to the picker (the top bar is narrow): "No class meetings set". */
export function fallbackShort(range: TimeRange): string | null {
  if (!isFallback(range)) return null;
  return range.preset === "this_class" || range.preset === "since_last_class" ? "No class meetings set" : fallbackNote(range);
}

export function TimeRangePickerView({
  range,
  custom,
  onPreset,
  onCustom,
  canSetSchedule,
  from,
  to,
  onFrom,
  onTo,
  onApply,
  error,
}: {
  range: TimeRange;
  custom: boolean;
  onPreset: (preset: TimePreset) => void;
  onCustom: () => void;
  canSetSchedule: boolean;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  onApply: () => void;
  error: string;
}): JSX.Element {
  const note = fallbackNote(range);
  const short = fallbackShort(range);
  return (
    <div className="time-range-picker">
      <label title={range.note || range.label}>
        <span className="time-range-label">{LABELS.timeLabel}:</span>
        <select
          aria-label="Time range"
          value={custom ? "custom" : range.preset}
          onChange={(e) => {
            const preset = e.target.value as TimePreset;
            if (preset === "custom") onCustom();
            else onPreset(preset);
          }}
        >
          {TIME_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {presetOptionLabel(preset, range)}
            </option>
          ))}
        </select>
      </label>
      {note && (
        <span className="time-range-note" role="note" title={note}>
          {short}
          <span className="visually-hidden"> — {note}</span>
          {canSetSchedule && (
            <>
              {" "}
              <a
                href={teacherPaths.settings("schedule")}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(teacherPaths.settings("schedule"));
                }}
              >
                Set class meetings
              </a>
            </>
          )}
        </span>
      )}
      {custom && (
        <span className="time-range-custom">
          <input type="date" aria-label="From date" value={from} onChange={(e) => onFrom(e.target.value)} />
          <input type="date" aria-label="To date (inclusive)" value={to} onChange={(e) => onTo(e.target.value)} />
          <button type="button" className="outline-button" onClick={onApply}>
            Apply
          </button>
        </span>
      )}
      {error && (
        <span className="error-text" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function TimeRangePicker(): JSX.Element {
  const { timeRange, setTimePreset, me } = useTeacher();
  const [custom, setCustom] = useState(timeRange.preset === "custom");
  const [from, setFrom] = useState(() => (timeRange.preset === "custom" ? isoToDateInputs(timeRange.from, timeRange.to).from : ""));
  const [to, setTo] = useState(() => (timeRange.preset === "custom" ? isoToDateInputs(timeRange.from, timeRange.to).to : ""));
  const [error, setError] = useState("");
  // S-m03: after a reload the applied custom range fills the From/To fields
  useEffect(() => {
    if (timeRange.preset !== "custom" || !timeRange.from || !timeRange.to) return;
    const dates = isoToDateInputs(timeRange.from, timeRange.to);
    setFrom((v) => v || dates.from);
    setTo((v) => v || dates.to);
    setCustom(true);
  }, [timeRange.preset, timeRange.from, timeRange.to]);
  const apply = () => {
    const start = dateInputToIso(from);
    const end = dateInputToIso(to, true);
    if (!start || !end || start >= end) {
      setError("Choose a start date before the end date.");
      return;
    }
    setError("");
    setTimePreset("custom", { from: start, to: end });
  };
  return (
    <TimeRangePickerView
      range={timeRange}
      custom={custom}
      onPreset={(preset) => {
        setCustom(false);
        setError("");
        setTimePreset(preset);
      }}
      onCustom={() => setCustom(true)}
      canSetSchedule={me.permissions.includes("manageCourse")}
      from={from}
      to={to}
      onFrom={setFrom}
      onTo={setTo}
      onApply={apply}
      error={error}
    />
  );
}
