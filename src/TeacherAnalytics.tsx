import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  Code2,
  Download,
  MessagesSquare,
  RefreshCw,
  Users,
} from "lucide-react";
import { api } from "./lib/api";
import { navigate } from "./lib/navigation";
import { ResponseText } from "./LearningTools";
import { Pager } from "./TeacherWork";
import { KiwiActivityConnection } from "./KiwiIntegration";
import type {
  AnalyticsMetrics,
  AnalyticsRow,
  AnalyticsTable,
  WorkOption,
  Course,
  HubData,
  QuestionEvidence,
  SessionEvidence,
  KiwiSyncStatus,
} from "./types";

const number = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(
        n,
      );
const time = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "No activity";
const labels: Record<string, string> = {
  question_generated: "Exercise generated",
  question_viewed: "Question opened",
  answer_submitted: "Answer attempt",
  code_run: "Code execution",
  code_shared: "Code shared with Kiwi",
  material_viewed: "Lecture page opened",
  code_edited: "Code saved",
  hint_requested: "Hint requested",
  ai_question: "Kiwi conversation",
  similar_requested: "Similar exercise requested",
  work_answer_saved: "Assignment answer saved",
  work_submitted: "Assignment submitted",
  work_opened: "Assignment opened",
  topic_changed: "Chapter changed",
  difficulty_changed: "Difficulty changed",
  profile_updated: "Learning focus updated",
};
const tableGroups = [
  ["students", "Students"],
  ["sessions", "Sessions"],
  ["topics", "Chapters"],
  ["assignments", "Assignments"],
  ["questions", "Questions"],
  ["materials", "Kiwi materials"],
];
const csvCell = (value: unknown) => {
  let s = String(value ?? "");
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return `"${s.replaceAll('"', '""')}"`;
};
function exportHub(hub: HubData) {
  const head = [
    "Student ID",
    "Student",
    ...hub.assignments.flatMap((a) => [
      `${a.title} score`,
      `${a.title} submissions`,
    ]),
    "Interactions",
    "Active minutes",
    "Generated exercises",
    "R runs",
    "Kiwi questions",
  ];
  const rows = hub.students.map((s) => [
    s.studentId,
    s.studentName,
    ...hub.assignments.flatMap((a) => [
      s.scoreByAssignment[a.id] ?? "",
      s.attemptsByAssignment[a.id] ?? 0,
    ]),
    s.interactions,
    Math.round(s.learningSeconds / 60),
    s.freePracticeCount,
    s.codeRuns,
    s.aiQuestions,
  ]);
  const href = URL.createObjectURL(
    new Blob(
      [
        "\uFEFF" +
          [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n"),
      ],
      { type: "text/csv;charset=utf-8" },
    ),
  );
  const a = document.createElement("a");
  a.href = href;
  a.download = "kiwi-course-data.csv";
  a.click();
  URL.revokeObjectURL(href);
}

export function TeacherAnalytics({
  classId,
  teacherKey,
  course,
  route,
}: {
  classId: string;
  teacherKey: string;
  course: Course;
  route: string;
}) {
  const url = new URL(route, location.origin),
    pageType = url.pathname.split("/")[3] || "overview",
    sessionId = url.pathname.split("/")[4] || "";
  const values = Object.fromEntries(url.searchParams),
    group = values.group || "students",
    page = Number(values.page || 1);
  const [metrics, setMetrics] = useState<AnalyticsMetrics | null>(null);
  const [data, setData] = useState<AnalyticsTable | null>(null);
  const [works, setWorks] = useState<WorkOption[]>([]);
  const [evidence, setEvidence] = useState<QuestionEvidence | null>(null);
  const [session, setSession] = useState<SessionEvidence | null>(null);
  const [hub, setHub] = useState<HubData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [kiwiStatus, setKiwiStatus] = useState<KiwiSyncStatus | null>(null);
  const onKiwiState = useCallback((s: KiwiSyncStatus) => { setKiwiStatus(s); setRevision(r => r + 1); }, []);
  const [hubSearch, setHubSearch] = useState("");
  const [hubPage, setHubPage] = useState(1);
  useEffect(() => {
    let active = true;
    void Promise.all([
      api.metrics(classId, teacherKey),
      api.workOptions(classId, teacherKey),
    ])
      .then(([m, w]) => {
        if (active) {
          setMetrics(m);
          setWorks(w);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [classId, teacherKey, revision]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setData(null);
    setEvidence(null);
    setSession(null);
    const task =
      pageType === "table"
        ? api.analytics(classId, teacherKey, values).then((r) => {
            if (active) setData(r);
          })
        : pageType === "evidence"
          ? api.evidence(classId, teacherKey, values).then((r) => {
              if (active) setEvidence(r);
            })
          : pageType === "session"
            ? api.session(classId, teacherKey, sessionId).then((r) => {
                if (active) setSession(r);
              })
            : pageType === "hub"
              ? api.hub(classId, teacherKey).then((r) => {
                  if (active) setHub(r);
                })
              : Promise.resolve();
    void task
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [route, classId, teacherKey, revision]);
  const path = (v: Record<string, string | undefined>, type = "table") => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(v))
      if (value) params.set(key, value);
    return `/teacher/analytics/${type}?${params.toString()}`;
  };
  const patch = (v: Record<string, string>) =>
    navigate(path({ ...values, ...v, page: v.page || "1" }), "search" in v);
  const sort = (id: string) =>
    patch({
      sort: id,
      direction:
        values.sort === id && values.direction !== "asc" ? "asc" : "desc",
    });
  const drill = (r: AnalyticsRow) => {
    const context: Record<string, string> = {
      ...values,
      page: "1",
      activity: "",
      group: "sessions",
    };
    if (group === "students") context.studentId = r.studentId || "";
    if (group === "topics") context.unitId = r.unitId || "unattributed";
    if (group === "assignments") context.assignmentId = r.assignmentId || "";
    if (group === "materials") context.materialId = r.materialId || "";
    if (group === "questions") {
      context.questionId = r.questionId || "";
      context.assignmentId = r.assignmentId || "";
      context.unitId = r.unitId || "unattributed";
    }
    if (group === "sessions") navigate(`/teacher/analytics/session/${r.id}`);
    else navigate(path(context));
  };
  const title = (r: AnalyticsRow) =>
    group === "sessions"
      ? r.title
      : group === "topics"
        ? course.units.find((u) => u.id === r.unitId)?.title ||
          "Not linked to a chapter"
        : r.label || r.studentName || "Untitled";
  const sortHead = (key: string, label: string) => (
    <th
      key={key}
      aria-sort={
        values.sort === key
          ? values.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <button onClick={() => sort(key)}>
        {label}{" "}
        {values.sort === key ? (values.direction === "asc" ? "↑" : "↓") : "↕"}
      </button>
    </th>
  );
  const activeFilters = Object.entries(values).filter(
    ([k, v]) =>
      v && !["group", "page", "pageSize", "sort", "direction"].includes(k),
  );
  const filteredHub =
    hub?.students.filter((s) =>
      (s.studentName + " " + s.studentId)
        .toLowerCase()
        .includes(hubSearch.toLowerCase()),
    ) || [];
  return (
    <>
      <nav className="page-tabs" aria-label="Analytics pages">
        <a
          href="/teacher/analytics/overview"
          aria-current={pageType === "overview" ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate("/teacher/analytics/overview");
          }}
        >
          Overview
        </a>
        <a
          href="/teacher/analytics/table?group=students"
          aria-current={
            ["table", "evidence", "session"].includes(pageType)
              ? "page"
              : undefined
          }
          onClick={(e) => {
            e.preventDefault();
            navigate("/teacher/analytics/table?group=students");
          }}
        >
          Interaction explorer
        </a>
        <a
          href="/teacher/analytics/hub"
          aria-current={pageType === "hub" ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate("/teacher/analytics/hub");
          }}
        >
          Grades & Data Hub
        </a>
      </nav>
      <KiwiActivityConnection classId={classId} teacherKey={teacherKey} onState={onKiwiState} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {pageType === "overview" ? (
        <>
          {metrics ? (
            <>
              <p className="muted metrics-note">
                Course totals use all recorded activity. Active students means
                the last 7 days. Average attempts and interactions use{" "}
                {metrics.engagedStudents} students with recorded activity;
                timing heartbeats are excluded.
              </p>
              <div className="analytics-metrics">
                {[
                  {
                    label: "Course progress",
                    value: `${metrics.completedUnits} / ${metrics.totalUnits}`,
                    note: "Chapters completed · current chapter in progress",
                    icon: BookOpen,
                    filter: { group: "sessions", unitId: course.currentUnitId },
                  },
                  {
                    label: "Published assignments",
                    value: String(metrics.publishedAssignments),
                    note: "Published homework in this course",
                    icon: BookOpen,
                    filter: { group: "assignments", published: "homework" },
                  },
                  {
                    label: "Active students",
                    value: String(metrics.activeStudents),
                    note: "Students with activity in the last 7 days",
                    icon: Users,
                    filter: { group: "students", active: "7d" },
                  },
                  {
                    label: "Average answer attempts",
                    value: number(metrics.averageAttempts, 2),
                    note: "All recorded attempts / engaged students",
                    icon: BarChart3,
                    filter: { group: "students", sort: "attempts" },
                  },
                  {
                    label: "Average interactions",
                    value: number(metrics.averageInteractions, 2),
                    note: "Meaningful events / engaged students",
                    icon: MessagesSquare,
                    filter: { group: "students", sort: "interactions" },
                  },
                  {
                    label: "Code runs",
                    value: number(metrics.codeRuns),
                    note: "All recorded executions, including unknown outcomes",
                    icon: Code2,
                    filter: {
                      group: "sessions",
                      activity: "runs",
                      sort: "codeRuns",
                    },
                  },
                ].map((c) => (
                  <a
                    className="metric-card metric-link"
                    key={c.label}
                    href={path(c.filter)}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(path(c.filter));
                    }}
                  >
                    <div className="row-between">
                      <span className="metric-icon lavender">
                        <c.icon size={20} />
                      </span>
                      <ArrowRight size={17} />
                    </div>
                    <span>{c.label}</span>
                    <strong>{c.value}</strong>
                    <small>{c.note}</small>
                    <span className="metric-action">Explore evidence</span>
                  </a>
                ))}
              </div>
              <div className="activity-sources">
                {[ ["lab", "CSS Lab", "Assignments, practice, code, and Kiwi questions"], ["kiwi", "Kiwi", "Scratchpad, lecture pages, and AI threads"] ].map(([source, label, description]) => {
                  const s = metrics.sources.find(s => s.source === source);
                  return <a className="panel source-card" key={source} href={path({ group: "sessions", source })} onClick={e => { e.preventDefault(); navigate(path({ group: "sessions", source })); }}><strong>{label}</strong><span>{source === "kiwi" && !kiwiStatus?.lastSynced ? "Awaiting Kiwi refresh" : `${number(s?.interactions || 0)} interactions · ${number(s?.codeRuns || 0)} code runs · ${number(s?.aiQuestions || 0)} AI questions`}</span><small>{description}</small></a>;
                })}
              </div>
              <section className="panel work-panel analytics-intro">
                <h2>Start with a learning question</h2>
                <p className="muted">
                  Explore chapters and questions to compare attempts,
                  checked-answer accuracy, code errors, and what students ask.
                  Open a session to see the actual attempts, code, output, and
                  conversation in order.
                </p>
                <div className="work-actions">
                  <button
                    className="outline-button"
                    onClick={() =>
                      navigate(
                        path({ group: "questions", sort: "averageAttempts" }),
                      )
                    }
                  >
                    Which questions need more attempts?
                  </button>
                  <button
                    className="outline-button"
                    onClick={() =>
                      navigate(
                        path({ group: "topics", sort: "averageQuestions" }),
                      )
                    }
                  >
                    Which chapters prompt questions?
                  </button>
                </div>
              </section>
            </>
          ) : (
            <p className="empty-state">Loading course metrics…</p>
          )}
        </>
      ) : pageType === "table" ? (
        <section className="panel work-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">INTERACTION EXPLORER</p>
              <h2>Find the evidence</h2>
            </div>
            <button
              className="outline-button"
              onClick={() => setRevision((r) => r + 1)}
            >
              <RefreshCw size={15} />
              Refresh
            </button>
          </div>
          <div className="table-view-tabs" aria-label="Group interactions">
            {tableGroups.map(([id, label]) => (
              <button
                className={group === id ? "selected" : ""}
                key={id}
                onClick={() => patch({ group: id })}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="table-toolbar">
            <label>Source<select value={values.source || ""} onChange={e => patch({ source: e.target.value })}><option value="">Kiwi + CSS Lab</option><option value="lab">CSS Lab</option><option value="kiwi">Kiwi</option></select></label>
            <label>Kiwi material<select value={values.materialId || ""} onChange={e => patch({ materialId: e.target.value })}><option value="">All materials & workspaces</option>{kiwiStatus?.materials.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label>
            <label>
              Student
              <input
                aria-label="Search students"
                value={values.search || ""}
                onChange={(e) => patch({ search: e.target.value })}
                placeholder="Search name or ID"
              />
            </label>
            <label>
              Chapter
              <select
                value={values.unitId || ""}
                onChange={(e) => patch({ unitId: e.target.value })}
              >
                <option value="">All chapters</option>
                {course.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Assignment
              <select
                value={values.assignmentId || ""}
                onChange={(e) =>
                  patch({ assignmentId: e.target.value, questionId: "" })
                }
              >
                <option value="">All assigned & free practice</option>
                {works.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Activity
              <select
                value={values.activity || ""}
                onChange={(e) => patch({ activity: e.target.value })}
              >
                <option value="">All interactions</option>
                <option value="attempts">Answer attempts</option>
                <option value="runs">Code runs</option>
                <option value="errors">Includes code errors</option>
                <option value="success">Includes successful code runs</option>
                <option value="unknown">Includes unknown code outcomes</option>
                <option value="reading">Lecture reading</option>
                <option value="questions">Kiwi questions & hints</option>
              </select>
            </label>
          </div>
          {activeFilters.length > 0 && (
            <div className="filter-chips">
              {activeFilters.map(([key, value]) => (
                <button
                  key={key}
                  onClick={() => patch({ [key]: "" })}
                  aria-label={`Remove ${key} filter`}
                >
                  {key}:{" "}
                  {key === "unitId"
                    ? course.units.find((u) => u.id === value)?.title || value
                    : key === "assignmentId"
                      ? works.find((w) => w.id === value)?.title || value
                      : value}{" "}
                  ×
                </button>
              ))}
              <button onClick={() => navigate(path({ group }))}>
                Clear filters
              </button>
            </div>
          )}
          <p className="muted table-help">
            {group === "sessions"
              ? "A session groups one student’s work on the same question, code workspace, or thread. A 30-minute inactivity gap starts a new session."
              : "Select a row to open the matching sessions. Averages use students represented in that row."}{" "}
            Accuracy includes automatically checked attempts only; ungraded
            homework is shown as —.
          </p>
          {loading ? (
            <p role="status" className="empty-state">
              Loading interactions…
            </p>
          ) : (
            <>
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Learning interaction table"
              >
                <table className="data-table">
                  <thead>
                    <tr>
                      {sortHead(
                        "label",
                        group === "students"
                          ? "Student"
                          : group === "sessions"
                            ? "Session"
                            : group === "topics"
                              ? "Chapter"
                              : group === "questions"
                                ? "Question"
                                : group === "materials" ? "Kiwi material" : "Assignment",
                      )}
                      {group === "sessions" && (
                        <>
                          <th>Student</th>
                          <th>Chapter / assignment</th>
                        </>
                      )}
                      {group !== "students" &&
                        group !== "sessions" &&
                        sortHead("students", "Students")}
                      {sortHead("interactions", "Interactions")}
                      {sortHead("attempts", "Attempts")}
                      {sortHead("codeRuns", "Code runs")}
                      {sortHead("codeSuccesses", "Successes")}
                      {sortHead("codeErrors", "Errors")}
                      <th>Unknown outcomes</th>
                      {sortHead("aiQuestions", "Kiwi questions")}
                      {sortHead("accuracy", "Checked accuracy")}
                      {group !== "sessions" &&
                        sortHead("averageAttempts", "Attempts / student")}
                      {["topics", "materials"].includes(group) &&
                        sortHead("averageQuestions", "Questions / student")}
                      {sortHead("lastActive", "Last activity")}
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.rows.map((r, i) => (
                      <tr
                        key={
                          r.id ||
                          [
                            r.studentId,
                            r.unitId,
                            r.assignmentId,
                            r.questionId,
                            i,
                          ].join(":")
                        }
                      >
                        <td className="row-title">
                          <button
                            className="table-row-link"
                            onClick={() => drill(r)}
                          >
                            {title(r)}
                          </button>
                          {group === "students" && <small>{r.studentId}</small>}
                          {group === "sessions" && (
                            <small>
                              <span className="source-badge">{r.source === "kiwi" ? "Kiwi" : "CSS Lab"}</span> {r.kind} · {time(r.startedAt)}
                            </small>
                          )}
                        </td>
                        {group === "sessions" && (
                          <>
                            <td>{r.studentName}</td>
                            <td className="row-context">
                              {course.units.find((u) => u.id === r.unitId)
                                ?.title || "Not linked to a chapter"}
                              <small>
                                {works.find((w) => w.id === r.assignmentId)
                                  ?.title || kiwiStatus?.materials.find(m => m.id === r.materialId)?.title || (r.source === "kiwi" ? "Kiwi workspace" : "Free practice")}
                              </small>
                            </td>
                          </>
                        )}
                        {group !== "students" && group !== "sessions" && (
                          <td>{r.students}</td>
                        )}
                        <td>{number(r.interactions)}</td>
                        <td>{number(r.attempts)}</td>
                        <td>{number(r.codeRuns)}</td>
                        <td>{number(r.codeSuccesses)}</td>
                        <td>{number(r.codeErrors)}</td>
                        <td>{number(r.codeRuns - r.codeSuccesses - r.codeErrors)}</td>
                        <td>{number(r.aiQuestions)}</td>
                        <td>
                          {r.accuracy === null ? "—" : `${number(r.accuracy)}%`}
                        </td>
                        {group !== "sessions" && (
                          <td>{number(r.averageAttempts, 2)}</td>
                        )}
                        {["topics", "materials"].includes(group) && (
                          <td>{number(r.averageQuestions, 2)}</td>
                        )}
                        <td>{time(r.lastActive)}</td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => drill(r)}
                          >
                            {group === "sessions"
                              ? "Open session"
                              : "View sessions"}
                          </button>
                          {[
                            "questions",
                            "topics",
                            "assignments",
                            "students",
                            "materials",
                          ].includes(group) && (
                            <button
                              className="text-button"
                              onClick={() =>
                                navigate(
                                  path(
                                    {
                                      ...values,
                                      ...(group === "questions"
                                        ? {
                                            questionId: r.questionId || "",
                                            assignmentId: r.assignmentId || "",
                                            unitId: r.unitId || "unattributed",
                                          }
                                        : group === "topics"
                                          ? {
                                              unitId:
                                                r.unitId || "unattributed",
                                            }
                                          : group === "assignments"
                                            ? {
                                                assignmentId:
                                                  r.assignmentId || "",
                                              }
                                            : group === "materials" ? { materialId: r.materialId || "" } : { studentId: r.studentId || "" }),
                                    },
                                    "evidence",
                                  ),
                                )
                              }
                            >
                              Answers & questions
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data?.total === 0 && (
                <p className="empty-state">
                  No interactions match these filters. Try another chapter or
                  clear the filters.
                </p>
              )}
              <Pager
                page={data?.page || page}
                total={data?.total || 0}
                size={data?.pageSize || 25}
                onPage={(p) => patch({ page: String(p) })}
              />
            </>
          )}
        </section>
      ) : pageType === "session" ? (
        <section className="panel work-panel">
          <button
            className="text-button"
            onClick={() =>
              session &&
              navigate(
                path({
                  group: "sessions",
                  studentId: session.session.studentId || "",
                  unitId: session.session.unitId || "unattributed",
                  assignmentId: session.session.assignmentId || "",
                  source: session.session.source || "",
                  materialId: session.session.materialId || "",
                }),
              )
            }
          >
            <ArrowLeft size={16} />
            Related sessions
          </button>
          {session ? (
            <>
              <p className="eyebrow">COMPLETE LEARNING SESSION</p>
              <span className="source-badge">{session.session.source === "kiwi" ? "Kiwi" : "CSS Lab"}</span>
              <h2>{session.session.title}</h2>
              <p className="muted">
                {session.session.studentName} ·{" "}
                {course.units.find((u) => u.id === session.session.unitId)
                  ?.title || "Not linked to a chapter"}{" "}
                · {time(session.session.startedAt)} –{" "}
                {time(session.session.lastActive)}
              </p>
              <div className="session-totals">
                <span>{session.session.attempts} answer attempts</span>
                <span>{session.session.codeRuns} code runs</span>
                <span>{session.session.codeErrors} code errors</span>
                <span>{session.session.aiQuestions} Kiwi questions</span>
              </div>
              <div className="session-timeline">
                {session.events.map((event) => (
                  <article className="session-event" key={event.id}>
                    <div className="row-between">
                      <h3>{labels[event.type] || event.type}</h3>
                      <time>{time(event.createdAt)}</time>
                    </div>
                    <EventContent payload={event.payload} />
                  </article>
                ))}
              </div>
              {session.hasMore && (
                <button
                  className="outline-button"
                  disabled={loading}
                  onClick={() => {
                    setLoading(true);
                    void api
                      .session(
                        classId,
                        teacherKey,
                        sessionId,
                        session.events.at(-1)?.id,
                      )
                      .then((r) =>
                        setSession((s) =>
                          s ? { ...r, events: [...s.events, ...r.events] } : r,
                        ),
                      )
                      .catch((e) => setError(e.message))
                      .finally(() => setLoading(false));
                  }}
                >
                  Load more session events
                </button>
              )}
            </>
          ) : (
            !error && <p className="empty-state">Loading session…</p>
          )}
        </section>
      ) : pageType === "evidence" ? (
        <section className="panel work-panel">
          <button
            className="text-button"
            onClick={() => navigate(path({ ...values, group: "sessions" }))}
          >
            <ArrowLeft size={16} />
            Matching sessions
          </button>
          <p className="eyebrow">ANSWER & CONVERSATION EVIDENCE</p>
          <h2>What students tried and asked</h2>
          <p className="muted">
            This view uses the same student, chapter, assignment, and question
            filters as the explorer. Repeated questions below are exact matches
            after case and whitespace normalization. Shared topics use named
            keyword rules and link to actual questions.
          </p>
          {evidence ? (
            <>
              <h3>Answer / option distribution</h3>
              <p className="muted">
                Up to 50 distinct answers are shown. Shares use all recorded
                attempts in this selection.
              </p>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Answer / option</th>
                      <th>Attempts</th>
                      <th>Share</th>
                      <th>Students</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evidence.distribution.map((d, i) => (
                      <tr key={i}>
                        <td className="answer-cell">
                          <pre>{d.answer}</pre>
                        </td>
                        <td>{d.attempts}</td>
                        <td>{d.share}%</td>
                        <td>{d.students}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!evidence.distribution.length && (
                <p className="muted">No recorded answers for this selection.</p>
              )}
              <h3>Shared question topics</h3>
              <p className="muted">
                Keyword groups highlight topics asked about by multiple
                students. Examples are evidence to inspect, not a diagnosis of a
                misconception.
              </p>
              {evidence.sharedTopics.map((topic) => (
                <details className="common-question" key={topic.theme}>
                  <summary>
                    {topic.theme} · {topic.students} students ·{" "}
                    {topic.questions} questions
                  </summary>
                  {topic.examples.map((example, i) => (
                    <div key={i}>
                      <p>
                        {example.studentName}: {example.prompt}
                      </p>
                      <button
                        className="text-button"
                        onClick={() =>
                          navigate(
                            `/teacher/analytics/session/${example.sessionId}`,
                          )
                        }
                      >
                        Open example session
                      </button>
                    </div>
                  ))}
                </details>
              ))}
              {evidence.sharedTopics.length === 0 && (
                <p className="muted">
                  No shared topic has enough student evidence in this selection.
                </p>
              )}
              <h3>Repeated questions across students</h3>
              {evidence.commonQuestions.length ? (
                evidence.commonQuestions.map((q, i) => (
                  <div className="common-question" key={i}>
                    <p>{q.prompt}</p>
                    <small>
                      {q.students} students · {q.occurrences} questions
                    </small>
                  </div>
                ))
              ) : (
                <p className="muted">
                  No identical question has been recorded from more than one
                  student.
                </p>
              )}
              <h3>Individual student questions</h3>
              {evidence.questions.map((q) => (
                <article className="session-event" key={q.id}>
                  <div className="row-between">
                    <strong>
                      {q.studentName} · {time(q.createdAt)}
                    </strong>
                    <button
                      className="text-button"
                      onClick={() =>
                        navigate(`/teacher/analytics/session/${q.sessionId}`)
                      }
                    >
                      Open full session
                    </button>
                  </div>
                  <EventContent payload={q.payload} />
                </article>
              ))}
              {!evidence.questions.length && (
                <p className="muted">
                  No Kiwi questions recorded for this selection.
                </p>
              )}
              {evidence.hasMore && (
                <button
                  className="outline-button"
                  disabled={loading}
                  onClick={() => {
                    setLoading(true);
                    void api
                      .evidence(classId, teacherKey, {
                        ...values,
                        beforeId: String(evidence.questions.at(-1)?.id),
                      })
                      .then((r) =>
                        setEvidence((v) =>
                          v
                            ? {
                                ...r,
                                questions: [...v.questions, ...r.questions],
                              }
                            : r,
                        ),
                      )
                      .catch((e) => setError(e.message))
                      .finally(() => setLoading(false));
                  }}
                >
                  Load earlier questions
                </button>
              )}
            </>
          ) : (
            !error && <p className="empty-state">Loading evidence…</p>
          )}
        </section>
      ) : (
        <section className="panel work-panel">
          <div className="panel-heading">
            <h2>Grades & student Data Hub</h2>
            <button
              className="outline-button"
              disabled={!hub}
              onClick={() => hub && exportHub(hub)}
            >
              <Download size={16} />
              Export CSV
            </button>
          </div>
          <p className="muted">
            Scores use the latest graded submission. Submission counts include
            all attempts. Active minutes are an estimate from activity
            heartbeats. Interactions exclude those heartbeats.
          </p>
          <label className="work-label">
            Find a student
            <input
              value={hubSearch}
              onChange={(e) => {
                setHubSearch(e.target.value);
                setHubPage(1);
              }}
              placeholder="Search name or ID"
            />
          </label>
          <div className="table-scroll">
            <table className="data-table hub-table">
              <thead>
                <tr>
                  <th>Student</th>
                  {hub?.assignments.map((a) => (
                    <th key={a.id}>
                      {a.title}
                      <small>Score / submissions</small>
                    </th>
                  ))}
                  <th>Interactions</th>
                  <th>Active minutes</th>
                  <th>R runs</th>
                  <th>Kiwi questions</th>
                </tr>
              </thead>
              <tbody>
                {filteredHub
                  .slice((hubPage - 1) * 25, hubPage * 25)
                  .map((s) => (
                    <tr key={s.studentId}>
                      <td>
                        <button
                          className="table-row-link"
                          onClick={() =>
                            navigate(
                              path({
                                group: "sessions",
                                studentId: s.studentId,
                              }),
                            )
                          }
                        >
                          {s.studentName}
                        </button>
                      </td>
                      {hub?.assignments.map((a) => (
                        <td key={a.id}>
                          {s.scoreByAssignment[a.id] ?? "—"} /{" "}
                          {s.attemptsByAssignment[a.id] ?? 0}
                        </td>
                      ))}
                      <td>{s.interactions}</td>
                      <td>{Math.round(s.learningSeconds / 60)}</td>
                      <td>{s.codeRuns}</td>
                      <td>{s.aiQuestions}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {!loading && !filteredHub.length && (
            <p className="empty-state">No students match this search.</p>
          )}
          <Pager
            page={hubPage}
            total={filteredHub.length}
            size={25}
            onPage={setHubPage}
          />
        </section>
      )}
    </>
  );
}
function EventContent({ payload: p }: { payload: Record<string, unknown> }) {
  return (
    <div className="event-content">
      {p.source === "kiwi" && <>
        <p className="event-provenance"><span className="source-badge">Kiwi · {String(p.surface || "chat")}</span>{p.materialTitle ? ` ${String(p.materialTitle)}` : ""}{typeof p.page === "number" ? ` · page ${p.page}` : ""}</p>
        <details className="event-record-ids"><summary>Original record & thread</summary><p>Kiwi interaction: {String(p.upstreamId)}</p><p>Thread: {String(p.threadId)}</p>{Boolean(p.upstreamActionId) && <p>AI response: {String(p.upstreamActionId)}</p>}</details>
        {p.upstreamType === "frontend-interaction-ide-runcode" && p.ok === undefined && <p className="muted">Kiwi did not record the outcome status for this run.</p>}
        {p.responseState === "not-recorded" && p.surface !== "scratchpad" && Boolean(p.prompt) && <p className="muted">No AI response has been recorded for this question yet.</p>}
        {Boolean(p.truncated) && <p className="muted">Long evidence is abbreviated here. The original Kiwi record ID is shown above.</p>}
      </>}
      {Boolean(p.recoveredFromSubmission) && (
        <p className="muted">
          Recovered from the original homework submission snapshot.
        </p>
      )}
      {Boolean(p.prompt) && (
        <p>
          <strong>Student question:</strong> {String(p.prompt)}
        </p>
      )}
      {p.answer !== undefined && (
        <>
          <strong>Answer attempt</strong>
          <pre>{String(p.answer)}</pre>
          <p>
            {p.correct === true
              ? "Checked correct"
              : p.correct === false
                ? "Checked incorrect"
                : "Awaiting manual grading"}
          </p>
        </>
      )}
      {Boolean(p.code) && (
        <>
          <strong>Code{p.language && p.language !== "not-recorded" ? ` · ${String(p.language)}` : ""}</strong>
          <pre>{String(p.code)}</pre>
        </>
      )}
      {p.ok !== undefined && (
        <span className={p.ok ? "success-text" : "error-text"}>
          {p.ok ? "Completed" : "Failed"}
        </span>
      )}
      {Boolean(p.output) && (
        <>
          <strong>Output</strong>
          <pre>{String(p.output)}</pre>
        </>
      )}
      {Boolean(p.error) && (
        <>
          <strong>Error</strong>
          <pre className="error-text">{String(p.error)}</pre>
        </>
      )}
      {Boolean(p.response || p.hint) && (
        <>
          <span className="ai-source">
            {p.source === "kiwi-ai" || p.source === "kiwi" ? "Kiwi AI" : "Local guidance"}
          </span>
          <ResponseText text={String(p.response || p.hint)} />
        </>
      )}
      {!p.prompt && !p.answer && !p.code && !p.response && !p.hint && (
        <p>
          {String(
            p.questionTitle ||
              p.title ||
              p.action ||
              "Learning activity recorded.",
          )}
        </p>
      )}
    </div>
  );
}
