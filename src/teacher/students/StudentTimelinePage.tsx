import { useEffect, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { ExportMenu } from "../../components/ExportMenu";
import { PageHeader } from "../../components/PageHeader";
import { ResponseText } from "../../components/ResponseText";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { formatDateTime, formatWeekdayDateTime } from "../../lib/format";
import { DIFFICULTY_OPTIONS, LABELS, questionTypeLabel } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import {
  appendTimeline, contextLabel, groupStudySessions, kindLabel, provenanceDetail, statusTone, timelineExportQuery, timelineTitle, titleOutcome,
} from "../insights/timelineModel";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { AiQuestionType, Difficulty, StudentTimeline, TimelineEvent, WorkQuestionType } from "../../types";

/*
 * Full activity timeline and student × assignment timeline [TH09, FD03, DA04, TR03, NM27] (INSIGHTS-06/19):
 * every recorded step in time order — assignments, free and similar practice, R workspace, Kiwi reading and chats —
 * with study-session breaks after 30 minutes without activity. Grade states come from the server (Draft / Released).
 */

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
/** One line of at most `max` characters (accessible names of repeated controls, K-m04). */
const clipText = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function TimelineDetail({ event, canGrade }: { event: TimelineEvent; canGrade: boolean }) {
  const d = event.detail as Record<string, unknown>;
  if (event.kind === "similar_generated" || event.kind === "practice_generated") {
    const choices = Array.isArray(d.choices) ? (d.choices as unknown[]).map(str) : [];
    const level = typeof d.difficulty === "number" ? DIFFICULTY_OPTIONS[d.difficulty as Difficulty] ?? `Difficulty ${d.difficulty}` : "";
    const type = str(d.questionType);
    return (
      <details className="timeline-exercise">
        {/* K-m04: several generated exercises on one timeline — the summary names its exercise and time */}
        {/* P-m03: two exercises can share a stem and a minute, so the name also carries the exercise's short id */}
        <summary aria-label={`${LABELS.openExercise} — ${clipText(str(d.stem), 60) || event.title}, ${formatDateTime(event.at)} (#${(event.questionId || event.id).slice(-6)})`}>{LABELS.openExercise}</summary>
        <p className="exercise-meta">
          {[type ? questionTypeLabel(type as WorkQuestionType | AiQuestionType) : "", level].filter(Boolean).join(" · ")}
        </p>
        <p className="exercise-stem">{str(d.stem)}</p>
        {choices.length > 0 && (
          <ol className="exercise-choices">
            {choices.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        )}
      </details>
    );
  }
  if (event.kind === "grade" || event.kind === "grade_released") {
    return (
      <div className="timeline-detail">
        <p className="muted">
          {str(d.actorLabel) && (d.action === "migrated" ? str(d.actorLabel) : `By ${str(d.actorLabel)}`)}
          {typeof d.attempt === "number" && ` · attempt ${d.attempt}`}
        </p>
        {str(d.feedback) && <p>Feedback: {str(d.feedback)}</p>}
        {canGrade && event.context.assignmentId && (
          <a
            className="text-button"
            href={teacherPaths.grading({ assignmentId: event.context.assignmentId })}
            aria-label={`Open in grading — ${event.title}, ${formatDateTime(event.at)}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(teacherPaths.grading({ assignmentId: event.context.assignmentId ?? undefined }));
            }}
          >
            Open in grading
          </a>
        )}
      </div>
    );
  }
  return (
    <div className="timeline-detail">
      {event.kind === "ai_turn" && str(d.prompt) && (
        <p>
          <strong>Student asked:</strong> {str(d.prompt)}
        </p>
      )}
      {d.answer !== undefined && d.answer !== null && event.kind !== "ai_turn" && <pre className="timeline-answer">{str(d.answer)}</pre>}
      {str(d.code) && <pre className="timeline-code">{str(d.code)}</pre>}
      {str(d.output) && <pre className="timeline-output">{str(d.output)}</pre>}
      {str(d.error) && <pre className="timeline-error error-text">{str(d.error)}</pre>}
      {str(d.response) && <ResponseText text={str(d.response)} />}
      {event.kind === "material_viewed" && <p className="muted">{str(d.title || d.materialTitle)}</p>}
    </div>
  );
}

/** "Thu 09/24 02:47 – 02:57" (end date repeated only when it differs). */
export function sessionSpan(start: string, end: string): string {
  const a = formatWeekdayDateTime(start);
  const b = formatWeekdayDateTime(end);
  const [aDay, aDate] = a.split(" ");
  const [bDay, bDate, bTime] = b.split(" ");
  return aDay === bDay && aDate === bDate ? `${a} – ${bTime}` : `${a} – ${b}`;
}

export function TimelineView({ timeline, canGrade, loading, onLoadMore }: { timeline: StudentTimeline; canGrade: boolean; loading: boolean; onLoadMore: () => void }) {
  const sessions = groupStudySessions(timeline.events);
  if (!timeline.events.length) return <EmptyState>No recorded activity for this view.</EmptyState>;
  return (
    <div className="timeline">
      {sessions.map((session) => (
        <section key={`${session.index}-${session.start}`} className="timeline-session" aria-label={`Study session ${session.index + 1}`}>
          <h2 className="timeline-session-title">
            Study session {session.index + 1} · {sessionSpan(session.start, session.end)}
          </h2>
          <ol className="timeline-events">
            {session.events.map((event) => {
              const outcome = titleOutcome(event);
              const provenance = provenanceDetail(event.provenance);
              return (
                <li key={event.id} className={`timeline-event kind-${event.kind}`}>
                  <time dateTime={event.at}>{formatDateTime(event.at)}</time>
                  <div className="timeline-event-main">
                    <p className="timeline-event-title">
                      <strong>{event.title || kindLabel(event.kind)}</strong>
                      {event.questionLabel && <span className="muted"> · {event.questionLabel}</span>}
                      {outcome && <span className={outcome === "Correct" || outcome === "Success" ? "success-text" : outcome === "Incorrect" || outcome === "Error" ? "error-text" : "muted"}> · {outcome}</span>}
                    </p>
                    <p className="timeline-event-context muted">
                      {contextLabel(event.context)}
                      {event.provenance.where === "kiwi" ? ` · ${LABELS.whereKiwi}` : ""}
                      {provenance && ` · ${provenance}`}
                    </p>
                    <TimelineDetail event={event} canGrade={canGrade} />
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {timeline.hasMore && (
        <button type="button" className="outline-button load-more" disabled={loading} onClick={onLoadMore}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

/** Export of one student's activity requires a stated purpose (§13.6). */
export function PurposeExport({ classId, query, label = LABELS.activityLog }: { classId: string; query: Record<string, string>; label?: string }) {
  const [purpose, setPurpose] = useState("");
  const ready = purpose.trim().length >= 5;
  return (
    <div className="purpose-export">
      <label>
        <span className="muted">Purpose (for one student's data)</span>
        <input aria-label="Purpose of this export" value={purpose} maxLength={500} placeholder="e.g. office hours follow-up" onChange={(e) => setPurpose(e.target.value)} />
      </label>
      {ready ? (
        <ExportMenu
          classId={classId}
          items={[
            { label: `${label} (this view, CSV)`, path: "activity.csv", query: { ...query, purpose: purpose.trim() } },
            { label: `${label} (this view, JSONL)`, path: "activity.jsonl", query: { ...query, purpose: purpose.trim() } },
          ]}
        />
      ) : (
        <button type="button" className="outline-button" disabled title="Enter a purpose of at least 5 characters">
          {LABELS.exportMenu} ▾
        </button>
      )}
    </div>
  );
}

export function StudentTimelinePage({ params, route }: TeacherPageProps) {
  const { classId, me } = useTeacher();
  const { studentId = "", assignmentId } = params;
  const search = new URL(route, "http://lab.local").searchParams;
  const filters = { from: search.get("from") || undefined, to: search.get("to") || undefined, unitId: search.get("unitId") || undefined,
    where: (search.get("where") as "lab" | "kiwi" | null) || undefined };
  const key = JSON.stringify(filters);
  const [timeline, setTimeline] = useState<StudentTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const canGrade = me.permissions.includes("grade");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setTimeline(null);
    setError("");
    api
      .timeline(classId, { studentId, assignmentId, ...(JSON.parse(key) as typeof filters) })
      .then((t) => {
        if (active) setTimeline(t);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [classId, studentId, assignmentId, key]);

  const loadMore = () => {
    if (!timeline?.nextCursor) return;
    setLoading(true);
    api
      .timeline(classId, { studentId, assignmentId, ...filters, after: timeline.nextCursor })
      .then((page) => setTimeline((t) => appendTimeline(t, page)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  const name = timeline?.student.studentName || "Student";
  const setWhere = (where: string) =>
    navigate(
      assignmentId
        ? teacherPaths.studentAssignmentTimeline(studentId, assignmentId)
        : teacherPaths.studentTimeline(studentId, { ...filters, where: where || undefined }),
      true,
    );
  return (
    <>
      <PageHeader
        title={timeline ? timelineTitle(name, timeline.assignment?.title) : assignmentId ? LABELS.studentAssignmentTimeline : LABELS.fullActivityTimeline}
        meta={timeline?.status ? <StatusBadge tone={statusTone(timeline.status)}>{timeline.status.label}</StatusBadge> : undefined}
        actions={<PurposeExport classId={classId} query={timelineExportQuery(studentId, { assignmentId, ...filters })} />}
      />
      <div className="timeline-toolbar">
        {me.permissions.includes("viewStudents") && (
          <a
            className="text-button"
            href={teacherPaths.studentProfile(studentId)}
            onClick={(e) => {
              e.preventDefault();
              navigate(teacherPaths.studentProfile(studentId));
            }}
          >
            {LABELS.openProfile}
          </a>
        )}
        {assignmentId ? (
          <a
            className="text-button"
            href={teacherPaths.studentTimeline(studentId)}
            onClick={(e) => {
              e.preventDefault();
              navigate(teacherPaths.studentTimeline(studentId));
            }}
          >
            {LABELS.fullActivityTimeline}
          </a>
        ) : (
          <div className="segmented" role="group" aria-label={LABELS.whereLabel}>
            {[
              ["", LABELS.whereAll],
              ["lab", LABELS.whereLab],
              ["kiwi", LABELS.whereKiwi],
            ].map(([value, label]) => (
              <button key={value} type="button" aria-pressed={(filters.where || "") === value} onClick={() => setWhere(value)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {assignmentId && canGrade && (
          <a
            className="text-button"
            href={teacherPaths.grading({ assignmentId, studentId })}
            onClick={(e) => {
              e.preventDefault();
              navigate(teacherPaths.grading({ assignmentId, studentId }));
            }}
          >
            Grade this student's submission
          </a>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <section className="panel work-panel">
        {timeline ? <TimelineView timeline={timeline} canGrade={canGrade} loading={loading} onLoadMore={loadMore} /> : !error && <EmptyState>Loading the timeline…</EmptyState>}
      </section>
    </>
  );
}
