import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { api } from "../../lib/api";
import { formatDateTime, formatNumber } from "../../lib/format";
import { LABELS, pluralize } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { PurposeExport } from "../students/StudentTimelinePage";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import { EventContent, eventLabel } from "./EventContent";
import { QUESTION_ACTIVITY_RULE } from "./explorerColumns";
import type { Course, EventRecord, QuestionActivity } from "../../types";

/*
 * Question activity [NM23] — one student's work on one question, code workspace or thread, with every event
 * (paginated, KEEP). Follows re-indexed ids through learning_session_aliases (`aliasOf`) so old links keep working.
 */

/** Appends a page of events without duplicates ("Load more" survives Kiwi sync [AU-D4-18]). */
export function appendEvents(current: QuestionActivity | null, page: QuestionActivity): QuestionActivity {
  if (!current) return page;
  const seen = new Set(current.events.map((e) => e.id));
  return { ...page, events: [...current.events, ...page.events.filter((e: EventRecord) => !seen.has(e.id))] };
}

export function QuestionActivityView({ course, data, loading, onLoadMore }: { course: Course; data: QuestionActivity; loading: boolean; onLoadMore: () => void }) {
  const s = data.activity;
  return (
    <section className="panel work-panel">
      {data.aliasOf && (
        <p className="global-status" role="status">
          This link pointed to an older question activity ({data.aliasOf}); it now opens the re-indexed activity.
        </p>
      )}
      <span className="source-badge">{s.source === "kiwi" ? "Kiwi" : "CSS Lab"}</span>
      <h2>{s.title || s.label}</h2>
      <p className="muted">
        {s.studentName} · {course.units.find((u) => u.id === s.unitId)?.title || "Not linked to a chapter"} · {formatDateTime(s.startedAt)} – {formatDateTime(s.lastActive)}
      </p>
      <div className="session-totals">
        <span>{pluralize(s.attempts, "answer attempt")}</span>
        <span>{pluralize(s.codeRuns, "code run")}</span>
        <span>{pluralize(s.codeErrors, "code error")}</span>
        <span>
          {s.aiQuestions} {LABELS.aiTutorQuestions}
        </span>
        {typeof s.activeMinutes === "number" && <span>{formatNumber(s.activeMinutes)} active minutes</span>}
        {s.result && <span>Result: {s.result}</span>}
      </div>
      <div className="session-timeline">
        {data.events.map((event) => (
          <article className="session-event" key={event.id}>
            <div className="row-between">
              <h3>{eventLabel(event.type, event.payload)}</h3>
              <time>{formatDateTime(event.createdAt)}</time>
            </div>
            <EventContent payload={event.payload} type={event.type} />
          </article>
        ))}
      </div>
      {data.hasMore && (
        <button className="outline-button" disabled={loading} onClick={onLoadMore}>
          Load more events
        </button>
      )}
      <p className="muted question-activity-rule">{QUESTION_ACTIVITY_RULE}</p>
    </section>
  );
}

export function QuestionActivityPage({ params }: TeacherPageProps) {
  const { classId, course } = useTeacher();
  const activityId = params.activityId || "";
  const [data, setData] = useState<QuestionActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setData(null);
    setError("");
    api
      .questionActivity(classId, activityId)
      .then((r) => {
        if (active) setData(r);
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
  }, [classId, activityId]);
  const loadMore = () => {
    if (!data) return;
    setLoading(true);
    api
      .questionActivity(classId, data.activity.id || activityId, data.events.at(-1)?.id)
      .then((r) => setData((d) => appendEvents(d, r)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  if (!course) return null;
  const s = data?.activity;
  const exportQuery: Record<string, string> = {};
  if (s?.studentId) exportQuery.studentId = s.studentId;
  if (s?.assignmentId) exportQuery.assignmentId = s.assignmentId;
  if (s?.questionId) exportQuery.questionId = s.questionId;
  if (s?.unitId) exportQuery.unitIds = s.unitId;
  if (s?.source) exportQuery.where = s.source;
  if (s?.startedAt) exportQuery.from = s.startedAt;
  return (
    <>
      <PageHeader
        title={LABELS.questionActivity}
        tabs={<SectionTabs section="insights" />}
        actions={s?.studentId ? <PurposeExport classId={classId} query={exportQuery} /> : undefined}
      />
      <div className="timeline-toolbar">
        <button
          className="text-button"
          disabled={!s}
          onClick={() =>
            s &&
            navigate(
              teacherPaths.activity({
                group: "question-activities",
                studentId: s.studentId,
                unitId: s.unitId || "unattributed",
                assignmentId: s.assignmentId,
                where: s.source,
                materialId: s.materialId,
              }),
            )
          }
        >
          <ArrowLeft size={16} />
          Related question activities
        </button>
        {s?.studentId && (
          <a
            className="text-button"
            href={s.assignmentId ? teacherPaths.studentAssignmentTimeline(s.studentId, s.assignmentId) : teacherPaths.studentTimeline(s.studentId)}
            onClick={(e) => {
              e.preventDefault();
              navigate(s.assignmentId ? teacherPaths.studentAssignmentTimeline(s.studentId ?? "", s.assignmentId) : teacherPaths.studentTimeline(s.studentId ?? ""));
            }}
          >
            {s.assignmentId ? LABELS.studentAssignmentTimeline : LABELS.fullActivityTimeline}
          </a>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {data ? <QuestionActivityView course={course} data={data} loading={loading} onLoadMore={loadMore} /> : !error && <EmptyState>Loading question activity…</EmptyState>}
    </>
  );
}
