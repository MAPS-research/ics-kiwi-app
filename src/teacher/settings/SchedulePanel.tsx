import { useEffect, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import type { ClassMeeting, CourseSchedule, CourseSettings } from "../../types";

/* Class schedule: time zone, term start and weekly meetings with durations (drives This class / Since last class, §13.0). */

export const WEEKDAYS: readonly { value: ClassMeeting["weekday"]; label: string }[] = [
  { value: 1, label: "Monday" }, { value: 2, label: "Tuesday" }, { value: 3, label: "Wednesday" }, { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" }, { value: 6, label: "Saturday" }, { value: 7, label: "Sunday" },
];

export function meetingSummary(meeting: ClassMeeting): string {
  const day = WEEKDAYS.find((d) => d.value === meeting.weekday)?.label ?? `Day ${meeting.weekday}`;
  return `${day} ${meeting.time} · ${meeting.durationMinutes} min`;
}

/** "" when the schedule can be saved (the server validates again). */
export function scheduleProblem(schedule: CourseSchedule): string {
  if (!schedule.timezone.trim()) return "Enter a time zone such as Asia/Shanghai.";
  for (const m of schedule.meetings) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(m.time)) return "Meeting times use HH:MM (24-hour).";
    if (!Number.isInteger(m.durationMinutes) || m.durationMinutes < 15 || m.durationMinutes > 300) return "Meetings last 15–300 minutes.";
  }
  if (schedule.meetings.length > 14) return "Use at most 14 meetings per week.";
  return "";
}

export function SchedulePanel({ settings, busy, rangeLabel, onSave }: { settings: CourseSettings; busy: boolean; rangeLabel: string; onSave: (patch: Partial<CourseSettings>) => void }) {
  const [draft, setDraft] = useState<CourseSchedule>(settings.schedule);
  useEffect(() => setDraft(settings.schedule), [settings]);
  const problem = scheduleProblem(draft);
  const update = (index: number, meeting: Partial<ClassMeeting>) =>
    setDraft({ ...draft, meetings: draft.meetings.map((m, i) => (i === index ? { ...m, ...meeting } : m)) });
  return (
    <section className="panel work-panel focused-panel">
      <h2 className="panel-heading">Class schedule</h2>
      <p className="muted">Home and Insights use these meetings for “This class” and “Since last class”. Current range: {rangeLabel}.</p>
      <fieldset className="editor-fields" disabled={busy}>
        <label className="work-label">
          Time zone
          <input value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} placeholder="Asia/Shanghai" />
        </label>
        <label className="work-label">
          Term start (optional)
          <input type="date" value={draft.termStart ?? ""} onChange={(e) => setDraft({ ...draft, termStart: e.target.value || null })} />
        </label>
        <div className="meeting-list" role="group" aria-label="Class meetings">
          {draft.meetings.map((m, i) => (
            <div key={i} className="meeting-row">
              <label className="work-label">
                Day
                <select aria-label={`Meeting ${i + 1} weekday`} value={m.weekday} onChange={(e) => update(i, { weekday: Number(e.target.value) as ClassMeeting["weekday"] })}>
                  {WEEKDAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="work-label">
                Starts
                <input aria-label={`Meeting ${i + 1} start time`} type="time" value={m.time} onChange={(e) => update(i, { time: e.target.value })} />
              </label>
              <label className="work-label">
                Minutes
                <input
                  aria-label={`Meeting ${i + 1} duration in minutes`}
                  type="number"
                  min={15}
                  max={300}
                  value={m.durationMinutes}
                  onChange={(e) => update(i, { durationMinutes: Number(e.target.value) })}
                />
              </label>
              <button type="button" className="icon-button" aria-label={`Remove meeting ${i + 1}`} onClick={() => setDraft({ ...draft, meetings: draft.meetings.filter((_, j) => j !== i) })}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button type="button" className="outline-button" onClick={() => setDraft({ ...draft, meetings: [...draft.meetings, { weekday: 2, time: "10:00", durationMinutes: 90 }] })}>
            <Plus size={15} /> Add class meeting
          </button>
        </div>
      </fieldset>
      {problem && <p className="error-text">{problem}</p>}
      <div className="work-actions">
        <button className="primary-button" disabled={busy || Boolean(problem)} onClick={() => onSave({ schedule: draft })}>
          <Save size={16} /> Save schedule
        </button>
      </div>
    </section>
  );
}
