/*
 * Number and date formatting (frozen after FOUNDATION). Dates are shown in the course time zone when one is given
 * (CourseSettings.schedule.timezone), else in the browser's zone. All functions are pure apart from `Date.now()` defaults.
 */

const EMPTY = "—";

/*
 * Display time zone (review 2, TEACHER-02): App sets the course time zone once the course loads, so every date on every
 * page — teacher and student — uses the same zone even when a call site passes none. An explicit `timeZone` argument
 * still wins (tests, previews of another zone).
 */
let displayZone: string | undefined;
export function setDisplayTimeZone(timeZone: string | null | undefined): void {
  displayZone = timeZone && isValidTimeZone(timeZone) ? timeZone : undefined;
}
export function displayTimeZone(): string | undefined {
  return displayZone;
}
function zone(timeZone?: string): string | undefined {
  return timeZone ?? displayZone;
}
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
/** Short zone label shown next to due times: "GMT+8", "GMT-7", "UTC" (the zone's offset at `iso`, default now). */
export function zoneLabel(timeZone?: string, iso?: string | null): string {
  const z = zone(timeZone);
  const date = validDate(iso) ?? new Date();
  if (z === "UTC" || z === "Etc/UTC") return "UTC";
  for (const style of ["shortOffset", "short"] as const) {
    try {
      const part = new Intl.DateTimeFormat("en-US", { timeZone: z, timeZoneName: style }).formatToParts(date).find((p) => p.type === "timeZoneName");
      if (part?.value) return part.value;
    } catch {
      // WHY: older engines lack "shortOffset"; fall through to "short".
    }
  }
  return z ?? "";
}

export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined || Number.isNaN(value) ? EMPTY : `${formatNumber(value, digits)}%`;
}

function validDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.valueOf()) ? null : date;
}

interface Parts { weekday: string; month: string; day: string; year: string; hour: string; minute: string }
function partsIn(date: Date, timeZone?: string): Parts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone(timeZone), weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) out[part.type] = part.value;
  return { weekday: out.weekday, month: out.month, day: out.day, year: out.year, hour: out.hour, minute: out.minute };
}

/** "Oct 22, 2026, 9:00 AM" (v0.5.1 analytics format); `empty` when the value is missing or invalid. */
export function formatDateTime(iso: string | null | undefined, opts: { timeZone?: string; empty?: string } = {}): string {
  const date = validDate(iso);
  if (!date) return opts.empty ?? "No activity";
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: zone(opts.timeZone) });
}

/** "Oct 22, 2026" */
export function formatDate(iso: string | null | undefined, timeZone?: string): string {
  const date = validDate(iso);
  return date ? date.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: zone(timeZone) }) : EMPTY;
}

/** "10/22" */
export function formatShortDate(iso: string | null | undefined, timeZone?: string): string {
  const date = validDate(iso);
  if (!date) return EMPTY;
  const p = partsIn(date, timeZone);
  return `${p.month}/${p.day}`;
}

/** "Thu 10/22" */
export function formatWeekdayDate(iso: string | null | undefined, timeZone?: string): string {
  const date = validDate(iso);
  if (!date) return EMPTY;
  const p = partsIn(date, timeZone);
  return `${p.weekday} ${p.month}/${p.day}`;
}

/** "Thu 10/22 23:59" (24-hour clock) */
export function formatWeekdayDateTime(iso: string | null | undefined, timeZone?: string): string {
  const date = validDate(iso);
  if (!date) return EMPTY;
  const p = partsIn(date, timeZone);
  return `${p.weekday} ${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", "in 10 min". */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  const date = validDate(iso);
  if (!date) return EMPTY;
  const seconds = Math.round((date.valueOf() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  const unit = abs < 3600 ? `${Math.round(abs / 60)} min` : abs < 86400 ? `${Math.round(abs / 3600)} h` : pluralDays(Math.round(abs / 86400));
  return seconds < 0 ? `${unit} ago` : `in ${unit}`;
}
const pluralDays = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;

/** "Due Fri 10/24 23:59", "Past due · Fri 10/24 23:59", "No due date"; `{ zone: true }` appends "GMT+8". */
export function formatDue(dueAt: string | null | undefined, now: number = Date.now(), timeZone?: string,
  opts: { zone?: boolean } = {}): string {
  const date = validDate(dueAt);
  if (!date) return "No due date";
  const when = formatWeekdayDateTime(dueAt, timeZone) + (opts.zone ? ` ${zoneLabel(timeZone, dueAt)}` : "");
  return date.valueOf() > now ? `Due ${when}` : `Past due · ${when}`;
}

/** Countdown for timed attempts: "4:05", "1:02:03"; never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** "45 s", "5 min", "1 h 05 min". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return EMPTY;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Offset (ms) of `timeZone` from UTC at the instant `ms`: wall time there minus UTC. */
function offsetAt(ms: number, timeZone: string): number {
  const p = partsIn(new Date(ms), timeZone);
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  return wall - Math.floor(ms / 60000) * 60000;
}

/**
 * Value for `<input type="datetime-local">`: the wall time in the course zone (or the browser's zone when none is
 * known). Review 2 (TEACHER-02): the editor no longer reads dates in the browser's zone while showing the course zone.
 */
export function toDateTimeLocal(iso: string | null | undefined, timeZone?: string): string {
  const date = validDate(iso);
  if (!date) return "";
  const z = zone(timeZone);
  if (!z) return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const p = partsIn(date, z);
  return `${p.year}-${p.month}-${p.day}T${String(Number(p.hour) % 24).padStart(2, "0")}:${p.minute}`;
}
/** Inverse of toDateTimeLocal: the instant whose wall time in the zone is `value`, or null for an empty input. */
export function fromDateTimeLocal(value: string, timeZone?: string): string | null {
  if (!value) return null;
  const z = zone(timeZone);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!z || !match) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  const [, y, mo, d, h, mi] = match.map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let instant = wall - offsetAt(wall, z);
  instant = wall - offsetAt(instant, z);   // second pass settles DST transitions
  return Number.isNaN(instant) ? null : new Date(instant).toISOString();
}
