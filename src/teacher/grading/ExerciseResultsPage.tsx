import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";
import { api, type R } from "../../lib/api";
import { displayTimeZone, formatPercent, formatRelative } from "../../lib/format";
import { LABELS, pluralize } from "../../lib/labels";
import { navigate, useRoute } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { ExerciseResults, Group, TimePreset } from "../../types";

/*
 * In-class exercise results (GRADE; F10, AU-D1-M10, AU-D1-22). /teacher/assignments/:assignmentId/results
 * Page-local `Time: This class ▾` (default this_class, §13.0) instead of the global picker, a Group filter, and an
 * auto-refresh every 15 s while the page is visible.
 */

export const RESULTS_DEFAULT_PRESET: TimePreset = "this_class";
export const RESULTS_REFRESH_MS = 15_000;
export const RESULTS_PRESETS: readonly { value: TimePreset; label: string }[] = [
  { value: "this_class", label: "This class" },
  { value: "since_last_class", label: "Since last class" },
  { value: "this_week", label: "This week" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "whole_term", label: "Whole term" },
];

/**
 * "Refreshed 10:42:05" in the course time zone. RT-07: without an explicit zone it uses the course zone that App set for
 * every page (`displayTimeZone`), like the grading card and the autosave label; the browser zone is only the last resort.
 */
export function refreshedLabel(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "";
  const zone = timeZone ?? displayTimeZone();
  const time = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
  return `Refreshed ${time}`;
}

function follow(href: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    navigate(href);
  };
}

export interface ExerciseResultsViewProps {
  results: ExerciseResults | null;
  preset: TimePreset;
  onPreset: (preset: TimePreset) => void;
  groups: readonly Group[];
  groupId: string;
  onGroup: (groupId: string) => void;
  timeZone?: string;
  rangeLabel?: string;
  loading?: boolean;
}

export function ExerciseResultsView({ results, preset, onPreset, groups, groupId, onGroup, timeZone, rangeLabel, loading }: ExerciseResultsViewProps) {
  const assignmentId = results?.assignment.id ?? "";
  return (
    <section className="panel work-panel exercise-results">
      <div className="table-toolbar">
        <label>
          Time
          <select aria-label="Time range for these results" value={preset} onChange={(e) => onPreset(e.target.value as TimePreset)}>
            {RESULTS_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {groups.length > 0 && (
          <label>
            Group
            <select value={groupId} onChange={(e) => onGroup(e.target.value)}>
              <option value="">All students</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="muted results-meta" role="status">
          {rangeLabel && <span>{rangeLabel} · </span>}
          {results ? refreshedLabel(results.refreshedAt, timeZone) : loading ? "Loading…" : ""}
        </p>
      </div>
      {results && !results.questions.length && <EmptyState>This exercise has no questions.</EmptyState>}
      <div className="results-questions">
        {results?.questions.map((q) => (
          <article key={q.questionId} className="results-question" aria-label={q.label}>
            <h2>{q.label}</h2>
            <dl className="results-stats">
              <div>
                <dt>Attempted</dt>
                <dd>{`Attempted ${q.attempted}/${results.enrolled}`}</dd>
              </div>
              <div title={LABELS.firstTryCorrectHelp}>
                <dt>First try</dt>
                <dd>{`${LABELS.firstTryCorrect} ${formatPercent(q.correctFirstTryPct)}`}</dd>
              </div>
              <div>
                <dt>Eventually</dt>
                <dd>{`${LABELS.correctEventually} ${formatPercent(q.correctEventuallyPct)}`}</dd>
              </div>
            </dl>
            {q.topWrongAnswers.length > 0 && (
              <div className="results-wrong">
                <h3>Top wrong answers</h3>
                <ul>
                  {q.topWrongAnswers.map((w) => (
                    <li key={w.answer}>
                      <code>{`${w.answer || "(blank)"} (${pluralize(w.students, "student")})`}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {q.stuck.length > 0 && (
              <div className="results-stuck">
                <h3>
                  <StatusBadge tone="warning">Stuck now</StatusBadge>
                </h3>
                <ul>
                  {q.stuck.map((s) => {
                    const href = teacherPaths.studentAssignmentTimeline(s.studentId, assignmentId);
                    return (
                      <li key={s.studentId}>
                        <a href={href} onClick={follow(href)}>
                          {s.studentName}
                        </a>{" "}
                        · {pluralize(s.wrongAttempts, "wrong attempt")} · last {formatRelative(s.lastAttemptAt)}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </article>
        ))}
      </div>
      {results && results.students.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Student</th>
                <th scope="col">Questions correct</th>
                <th scope="col">Last active</th>
              </tr>
            </thead>
            <tbody>
              {results.students.map((s) => {
                const href = teacherPaths.studentAssignmentTimeline(s.studentId, assignmentId);
                return (
                  <tr key={s.studentId}>
                    <th scope="row">
                      <a className="table-row-link" href={href} onClick={follow(href)}>
                        {s.studentName}
                      </a>
                    </th>
                    <td>
                      {s.correct} of {s.attempted} attempted
                    </td>
                    <td>{formatRelative(s.lastActive)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {results && !results.students.length && <EmptyState>No attempts in this time range yet.</EmptyState>}
    </section>
  );
}

export function ExerciseResultsPage({ params }: TeacherPageProps) {
  const { classId } = useTeacher();
  const assignmentId = params.assignmentId || "";
  const route = useRoute();
  const groupId = new URL(route, "http://lab.local").searchParams.get("groupId") || "";
  const [preset, setPreset] = useState<TimePreset>(RESULTS_DEFAULT_PRESET);
  const [results, setResults] = useState<ExerciseResults | null>(null);
  const [rangeLabel, setRangeLabel] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api.groups(classId).then((list) => active && setGroups(list.filter((g) => !g.archived))).catch(() => active && setGroups([]));
    return () => {
      active = false;
    };
  }, [classId]);

  const load = useCallback(async () => {
    const range = await api.timeRange(classId, preset);
    const r: R = {};
    if (range.from) r.from = range.from;
    if (range.to) r.to = range.to;
    if (groupId) r.groupId = groupId;
    const data = await api.exerciseResults(classId, assignmentId, r);
    setRangeLabel(range.note ? `${range.label} (${range.note})` : range.label);
    setResults(data);
    setError("");
  }, [classId, assignmentId, preset, groupId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const run = () =>
      load()
        .catch((e: unknown) => active && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => active && setLoading(false));
    void run();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void run();
    }, RESULTS_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load]);

  return (
    <>
      <PageHeader
        title={results ? `${results.assignment.title} — results` : "In-class exercise results"}
        meta={results ? `${pluralize(results.enrolled, "student")} enrolled` : undefined}
        actions={
          <button type="button" className="outline-button" onClick={() => navigate(teacherPaths.activity({ group: "question-activities", assignmentId }))}>
            See details
          </button>
        }
      />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <ExerciseResultsView
        results={results}
        preset={preset}
        onPreset={setPreset}
        groups={groups}
        groupId={groupId}
        onGroup={(g) => navigate(`${teacherPaths.exerciseResults(assignmentId)}${g ? `?groupId=${encodeURIComponent(g)}` : ""}`, true)}
        rangeLabel={rangeLabel}
        loading={loading}
      />
    </>
  );
}
