import { useEffect, useRef, useState } from "react";
import { formatCountdown } from "../../lib/format";
import { LABELS } from "../../lib/labels";

/** Sticky "Time left 23:10" bar for timed homework [AU-D1-13] (ASSESS). Renders nothing for untimed work.
 * `onExpire` runs once when the countdown reaches 0:00 (the page auto-submits the current answers). */
export function timeLeftText(endsAt: string | null, now: number): string | null {
  if (!endsAt) return null;
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) return null;
  const left = end - now;
  return left > 0 ? `${LABELS.timeLeft} ${formatCountdown(left)}` : `${LABELS.overTime} — time is up`;
}

/** S-m07: fewer than 5 minutes left (the bar turns red before time is up). */
export const LOW_TIME_MS = 5 * 60_000;
export function isLowTime(endsAt: string | null, now: number): boolean {
  const end = endsAt ? Date.parse(endsAt) : Number.NaN;
  return !Number.isNaN(end) && end - now > 0 && end - now <= LOW_TIME_MS;
}

export function TimeLimitBar({ endsAt, now, onExpire }: { endsAt: string | null; now?: number; onExpire?: () => void }) {
  const [clock, setClock] = useState(() => now ?? Date.now());
  const fired = useRef<string | null>(null);
  useEffect(() => {
    if (!endsAt || now !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [endsAt, now]);
  const current = now ?? clock;
  const end = endsAt ? Date.parse(endsAt) : Number.NaN;
  const expired = !Number.isNaN(end) && end - current <= 0;
  useEffect(() => {
    if (expired && endsAt && onExpire && fired.current !== endsAt) {
      fired.current = endsAt;
      onExpire();
    }
  }, [expired, endsAt, onExpire]);
  const text = timeLeftText(endsAt, current);
  if (!text) return null;
  const low = !expired && isLowTime(endsAt, current);
  return (
    <div className={`time-limit-bar${expired ? " over" : low ? " low" : ""}`} role="timer" aria-live="off">
      {text}
      {low && <span className="assess-visually-hidden"> (less than 5 minutes left)</span>}
    </div>
  );
}
