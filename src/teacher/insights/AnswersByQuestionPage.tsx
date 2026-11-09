import { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { api } from "../../lib/api";
import { formatNumber } from "../../lib/format";
import { LABELS, pluralize } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { rangeQuery } from "../../lib/timeRange";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import { ORIGIN_LABELS } from "./explorerColumns";
import type { AnswersByQuestion } from "../../types";

/*
 * Answers by question [TR02, DA02, AU-D4-17] (INSIGHTS-04): one table per question — a code question and a text question
 * never share a table — with correct / incorrect / not auto-checked counts per answer.
 */

const SELECTORS = ["assignmentId", "questionId", "unitId", "itemGroup"] as const;

/** The request keys this page understands (explorer drill-down filters plus the global range and group). */
export function answersQuery(values: Readonly<Record<string, string>>, range: { from?: string; to?: string }): Record<string, string> | null {
  const q: Record<string, string> = {};
  for (const key of [...SELECTORS, "groupId"] as const) if (values[key] && values[key] !== "unattributed") q[key] = values[key];
  if (!SELECTORS.some((k) => q[k])) return null;
  if (range.from) q.from = range.from;
  if (range.to) q.to = range.to;
  return q;
}

export function AnswersByQuestionView({ data }: { data: AnswersByQuestion }) {
  if (!data.questions.length) return <EmptyState>No recorded answers for this selection.</EmptyState>;
  return (
    <div className="answers-by-question">
      {data.questions.map((question) => (
        <section className="panel work-panel answers-table" key={`${(question as { assignmentId?: string }).assignmentId ?? ""}:${question.questionId}`} aria-label={question.label}>
          <div className="row-between">
            <h2>
              {question.label} <span className="muted">· {ORIGIN_LABELS[question.origin] ?? question.origin}</span>
            </h2>
            <span className="muted">{pluralize(question.totalAttempts, "attempt")}</span>
          </div>
          {question.prompt && <p className="question-prompt">{question.prompt}</p>}
          <div className="table-scroll" tabIndex={0} role="region" aria-label={`Answers to ${question.label}`}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Answer</th>
                  <th>Attempts</th>
                  <th>Students</th>
                  <th>Correct</th>
                  <th>Incorrect</th>
                  <th>Not auto-checked</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {question.answers.map((a, i) => (
                  <tr key={i}>
                    <td className="answer-cell">
                      <pre>{a.answer || "(blank)"}</pre>
                    </td>
                    <td>{a.attempts}</td>
                    <td>{a.students}</td>
                    <td>{a.correct}</td>
                    <td>{a.incorrect}</td>
                    <td>{a.unchecked}</td>
                    <td>{formatNumber(a.share)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {question.hasMore && <p className="muted">Showing the 50 most common answers.</p>}
        </section>
      ))}
    </div>
  );
}

export function AnswersByQuestionPage({ route }: TeacherPageProps) {
  const { classId, timeRange } = useTeacher();
  const search = new URL(route, "http://lab.local").search;
  const values = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search]);
  const query = answersQuery(values, rangeQuery(timeRange));
  const key = JSON.stringify(query);
  const [data, setData] = useState<AnswersByQuestion | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!key || key === "null") return;
    let active = true;
    setData(null);
    setError("");
    api
      .answers(classId, JSON.parse(key) as Record<string, string>)
      .then((r) => {
        if (active) setData(r);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [classId, key]);
  return (
    <>
      <PageHeader title="Answers by question" meta={timeRange.label} tabs={<SectionTabs section="insights" />} />
      <div className="timeline-toolbar">
        <button className="text-button" onClick={() => navigate(teacherPaths.activity({ group: "questions", ...(values.assignmentId ? { assignmentId: values.assignmentId } : {}) }))}>
          <ArrowLeft size={16} />
          {LABELS.activityExplorer}
        </button>
        {values.assignmentId && (
          <button className="text-button" onClick={() => navigate(teacherPaths.aiConversations({ assignmentId: values.assignmentId }))}>
            {LABELS.whatStudentsAsked}
          </button>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {!query ? (
        <EmptyState>Open this page from a question or assignment row in the {LABELS.activityExplorer}.</EmptyState>
      ) : data ? (
        <AnswersByQuestionView data={data} />
      ) : (
        !error && <EmptyState>Loading answers…</EmptyState>
      )}
    </>
  );
}
