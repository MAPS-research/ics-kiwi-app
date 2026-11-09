import { fromDateTimeLocal, toDateTimeLocal } from "../../lib/format";
import { AFTER_DUE_HINT, AUTO_LATE_NOTE, NO_END_NOTE, TIME_LIMIT_RANGE, dueWithZone, gradesDefaultLabel, timeLimitProblem } from "./assignmentRules";
import type { AssignmentInput, Group, LatePolicy, SolutionsVisibility, TimeLimit } from "../../types";

/** Editor section 4 — dates, late policy, attempts, time limit, visibility and audience [F01, TH01, AU-D1-13, AU-D1-10]. Pure view. */

const SOLUTIONS: readonly { value: SolutionsVisibility; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "after_submit", label: "After the student submits" },
  { value: "after_due", label: "After the due date" },
  { value: "after_release", label: "After grades are released" },
];
const GROUP_KIND_LABEL = { section: "Section", condition: "Condition", cohort: "Cohort" } as const;
/**
 * RV6-M08: an in-class exercise is auto-checked and not graded, so it has no late policy, grade release or solutions
 * setting; students see each question's explanation after a correct answer (or once their attempts run out).
 */
export const IN_CLASS_NOTE =
  "In-class exercises are auto-checked and not graded: students check one answer at a time, so there is no late policy, grade release or solutions setting. The explanation shows after a correct answer.";

export function DatesSection({
  input,
  timeZone,
  defaultGradesVisibility,
  groups,
  groupsNote,
  readOnly,
  autoLate = false,
  onChange,
}: {
  input: AssignmentInput;
  timeZone: string;
  defaultGradesVisibility: "immediately" | "on_release";
  groups: Group[];
  groupsNote?: string;
  readOnly: boolean;
  /** the default late window still follows the due date (new homework, late policy untouched) */
  autoLate?: boolean;
  onChange: (patch: Partial<AssignmentInput>) => void;
}) {
  const late = input.latePolicy;
  const setLate = (values: Partial<LatePolicy>) => onChange({ latePolicy: { ...late, ...values } });
  const homework = input.kind === "homework";
  const limit: TimeLimit | null = input.timeLimit;
  const limitProblem = timeLimitProblem(input);
  const selected = input.audience.type === "groups" ? input.audience.groupIds : [];
  const liveGroups = groups.filter((g) => !g.archived);
  const toggleGroup = (id: string, on: boolean) => {
    const next = on ? [...new Set([...selected, id])] : selected.filter((g) => g !== id);
    onChange({ audience: next.length ? { type: "groups", groupIds: next } : { type: "all" } });
  };
  return (
    <section className="panel assess-section" aria-labelledby="assess-dates-title">
      <h2 id="assess-dates-title">{homework ? "Dates & late policy" : "Dates"}</h2>
      <fieldset className="assess-fieldset" disabled={readOnly}>
        {!homework && <p className="muted" role="note">{IN_CLASS_NOTE}</p>}
        <div className="work-form-grid assess-dates-grid">
          <label>
            Opens (optional)
            <input type="datetime-local" value={toDateTimeLocal(input.openAt, timeZone)} onChange={(e) => onChange({ openAt: fromDateTimeLocal(e.target.value, timeZone) })} />
          </label>
          <label>
            Due
            <input type="datetime-local" value={toDateTimeLocal(input.dueAt, timeZone)} onChange={(e) => onChange({ dueAt: fromDateTimeLocal(e.target.value, timeZone) })}
              aria-describedby="assess-due-zone" />
            <small id="assess-due-zone" className="muted">{dueWithZone(input.dueAt, timeZone)}</small>
          </label>
        </div>
        {homework && (
        <div className="work-form-grid assess-dates-grid">
          <label>
            Late submissions
            <select value={late.mode} onChange={(e) => setLate({ mode: e.target.value as LatePolicy["mode"] })}>
              <option value="not_accepted">Not accepted</option>
              <option value="accept_until">Accepted until a date</option>
              <option value="accept_marked">Accepted, marked late</option>
            </select>
          </label>
          {late.mode === "accept_until" && (
            <label>
              Accepted until
              <input type="datetime-local" value={toDateTimeLocal(late.untilAt, timeZone)} onChange={(e) => setLate({ untilAt: fromDateTimeLocal(e.target.value, timeZone) })} />
            </label>
          )}
          {late.mode !== "not_accepted" && (
            <label>
              Late penalty (% per day)
              <input type="number" min={0} max={100} value={late.penaltyPctPerDay} aria-describedby="assess-penalty-rule"
                onChange={(e) => setLate({ penaltyPctPerDay: Number(e.target.value) || 0 })} />
              {/* S-M04: the rule students are told too */}
              <small id="assess-penalty-rule" className="muted">Each started day counts as a full day (25 h late = 2 days).</small>
            </label>
          )}
          <label>
            Grace minutes
            <input type="number" min={0} max={120} value={late.graceMinutes} onChange={(e) => setLate({ graceMinutes: Number(e.target.value) || 0 })} />
          </label>
        </div>
        )}
        {homework && autoLate && late.mode === "accept_until" && <p className="muted">{AUTO_LATE_NOTE}</p>}
        {homework && late.mode === "accept_marked" && !input.closeAt && <p className="muted">{NO_END_NOTE}</p>}
        {homework && (
          <div className="work-form-grid">
            <label>
              Attempts allowed
              <input type="number" min={1} max={100} placeholder="Unlimited" value={input.maxAttempts ?? ""}
                onChange={(e) => onChange({ maxAttempts: e.target.value === "" ? null : Number(e.target.value) })} />
            </label>
            <label>
              Time limit
              <select value={limit ? "minutes" : "none"}
                onChange={(e) => onChange({ timeLimit: e.target.value === "none" ? null : { minutes: 30, onExpiry: "submit_marked" } })}>
                <option value="none">None</option>
                <option value="minutes">Minutes per attempt</option>
              </select>
            </label>
            {limit && (
              <>
                <label>
                  Minutes per attempt
                  <input type="number" min={TIME_LIMIT_RANGE.min} max={TIME_LIMIT_RANGE.max} step={1} value={limit.minutes}
                    aria-invalid={limitProblem ? true : undefined} aria-describedby="assess-time-limit-help"
                    onChange={(e) => onChange({ timeLimit: { ...limit, minutes: Number(e.target.value) } })} />
                  {/* S-M06: the range is stated next to the field, and a wrong value is reported here, not only above the page */}
                  <small id="assess-time-limit-help" className={limitProblem ? "error-text" : "muted"}>
                    {limitProblem ?? `${TIME_LIMIT_RANGE.min}–${TIME_LIMIT_RANGE.max} minutes`}
                  </small>
                </label>
                <label>
                  When time runs out
                  <select value={limit.onExpiry} onChange={(e) => onChange({ timeLimit: { ...limit, onExpiry: e.target.value as TimeLimit["onExpiry"] } })}>
                    <option value="submit_marked">Submit and mark over time</option>
                    <option value="reject">Do not accept</option>
                  </select>
                </label>
              </>
            )}
          </div>
        )}
        {homework && (
        <div className="work-form-grid assess-dates-grid">
          <label>
            Grades visible to students
            <select value={input.gradesVisibility} onChange={(e) => onChange({ gradesVisibility: e.target.value as AssignmentInput["gradesVisibility"] })}
              aria-describedby="assess-grades-default">
              <option value="immediately">Immediately</option>
              <option value="on_release">When I release</option>
            </select>
            <small id="assess-grades-default" className="muted">{gradesDefaultLabel(defaultGradesVisibility)}</small>
          </label>
          <label>
            Solutions visible
            <select value={input.solutionsVisibility} onChange={(e) => onChange({ solutionsVisibility: e.target.value as SolutionsVisibility })}
              aria-describedby={input.solutionsVisibility === "after_due" ? "assess-solutions-hint" : undefined}>
              {SOLUTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {input.solutionsVisibility === "after_due" && <small id="assess-solutions-hint" className="muted">{AFTER_DUE_HINT}</small>}
          </label>
        </div>
        )}
        <fieldset className="assess-inline-group">
          <legend>Assign to</legend>
          <label className="checkbox-label">
            <input type="radio" name="assess-audience" checked={input.audience.type === "all"} onChange={() => onChange({ audience: { type: "all" } })} />
            All students
          </label>
          {liveGroups.map((group) => (
            <label key={group.id} className="checkbox-label">
              <input type="checkbox" checked={selected.includes(group.id)} onChange={(e) => toggleGroup(group.id, e.target.checked)} />
              {GROUP_KIND_LABEL[group.kind]}: {group.name}
            </label>
          ))}
          {!liveGroups.length && <small className="muted">{groupsNote || "No groups yet. Create sections, conditions or cohorts on the Students page."}</small>}
        </fieldset>
      </fieldset>
    </section>
  );
}
