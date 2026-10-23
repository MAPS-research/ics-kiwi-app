import { useEffect, useMemo, useState, type ReactNode } from "react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { SparkBars } from "../../components/SparkBars";
import { api } from "../../lib/api";
import { formatNumber, formatShortDate } from "../../lib/format";
import { activeOfEnrolledLabel, LABELS, pluralize, thisWeeksChapterLabel } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { rangeQuery } from "../../lib/timeRange";
import { useKiwiRefreshRevision } from "../kiwi/useKiwiSync";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { CourseMetrics, Metric, OutagePeriod, TimeRange, TrendBucket } from "../../types";

/*
 * Course metrics [TR06, TR10, NM35–NM39, DA10, AU-D4-24] (§13.7, §13.9): every card states its denominator and the
 * change vs the comparison window; weekly trends, learning curve and time on task are inline SVG / tables.
 */

/** `↑ 18% vs last week` / `↓ 5% vs previous period`; empty without a comparison (Whole term). */
export function deltaLabel(metric: Metric, compareLabel: string | null): string {
  if (!compareLabel || metric.deltaPct === null || metric.deltaPct === undefined) return "";
  if (metric.deltaPct === 0) return `= ${compareLabel}`;
  return `${metric.deltaPct > 0 ? "↑" : "↓"} ${Math.abs(metric.deltaPct)}% ${compareLabel}`;
}

export interface MetricCardModel { key: string; label: string; value: string; note: string; delta: string; href: string; secondary?: boolean; compact?: boolean }

const fmt = (v: number | null | undefined, suffix = "") => (v === null || v === undefined ? "—" : `${formatNumber(v)}${suffix}`);

/** Cards with denominators (INSIGHTS-07/09). */
export function metricCards(m: CourseMetrics, range: TimeRange): MetricCardModel[] {
  const compare = range.compareLabel;
  const active = m.active.value ?? 0;
  const perActive = `per active student · ${active} of ${m.enrolled} enrolled`;
  return [
    { key: "active", label: activeOfEnrolledLabel(range.effectivePreset, active, m.enrolled), value: `${active}`, note: `of ${m.enrolled} enrolled (never-active students included)`, delta: deltaLabel(m.active, compare), href: teacherPaths.activity({ group: "students" }) },
    { key: "chapter", label: thisWeeksChapterLabel((m.thisWeekChapter as CourseMetrics["thisWeekChapter"] & { number?: number }).number ?? 0, m.thisWeekChapter.completed, m.thisWeekChapter.total), value: m.thisWeekChapter.title.replace(/^\d+\s*·\s*/, ""), note: `${m.thisWeekChapter.completed} of ${m.thisWeekChapter.total} chapters completed`, delta: "", href: teacherPaths.activity({ group: "chapters" }), compact: true },
    { key: "published", label: "Published homework", value: `${m.publishedHomework} (+${pluralize(m.inClassExercises, "in-class exercise")})`, note: "Published and not archived", delta: "", href: teacherPaths.activity({ group: "assignments" }), compact: true },
    { key: "attempts", label: LABELS.answerAttemptsPerActive, value: fmt(m.answerAttemptsPerActive.value), note: perActive, delta: deltaLabel(m.answerAttemptsPerActive, compare), href: teacherPaths.activity({ group: "students", sort: "attempts" }) },
    { key: "accuracy", label: LABELS.autoCheckedAccuracy, value: fmt(m.autoCheckedAccuracy.value, "%"), note: "Server-checked attempts on your questions", delta: deltaLabel(m.autoCheckedAccuracy, compare), href: teacherPaths.activity({ group: "questions" }) },
    { key: "similar", label: LABELS.similarPracticeAccuracy, value: fmt(m.similarAccuracy.value, "%"), note: "Server-checked attempts on similar items", delta: deltaLabel(m.similarAccuracy, compare), href: teacherPaths.activity({ group: "questions", origin: "ai-similar" }) },
    { key: "ai", label: LABELS.aiTutorQuestions, value: fmt(m.aiTutorQuestions.value), note: "Lab AI tutor + Kiwi lecture AI + hints", delta: deltaLabel(m.aiTutorQuestions, compare), href: teacherPaths.aiConversations() },
    { key: "runs", label: LABELS.codeRuns, value: fmt(m.codeRuns.value), note: "All recorded executions", delta: deltaLabel(m.codeRuns, compare), href: teacherPaths.activity({ group: "question-activities", activity: "runs" }) },
    { key: "actions", label: LABELS.avgLoggedActions, value: fmt(m.loggedActionsPerActive.value), note: perActive, delta: deltaLabel(m.loggedActionsPerActive, compare), href: teacherPaths.activity({ group: "students", sort: "actions", columns: "research" }), secondary: true },
  ];
}

/** Which trend buckets overlap an outage period (shaded in the charts, §13.10). */
export function shadedBuckets(buckets: readonly TrendBucket[], outages: readonly OutagePeriod[]): boolean[] {
  return buckets.map((b, i) => {
    const start = Date.parse(b.start);
    const end = i + 1 < buckets.length ? Date.parse(buckets[i + 1].start) : start + 7 * 86_400_000;
    return outages.some((o) => Date.parse(o.from) < end && Date.parse(o.to) > start);
  });
}

export function sourceText(source: CourseMetrics["sources"][number]): string {
  if (source.where === "kiwi" && !source.linked) return LABELS.kiwiNotLinked;
  return `${formatNumber(source.actions)} logged actions · ${formatNumber(source.codeRuns)} code runs · ${formatNumber(source.aiQuestions)} AI questions`;
}

type Trends = { buckets: TrendBucket[]; outages: OutagePeriod[] };
type Curve = { attemptIndex: number; accuracy: number | null; n: number }[];
type TimeOnTask = { questionId: string; label: string; medianMinutes: number; p75Minutes: number; students: number; prompt?: string }[];

export function CourseMetricsView({ metrics, range, trends, curve, timeOnTask, onOpen }: {
  metrics: CourseMetrics; range: TimeRange; trends: Trends | null; curve: Curve | null; timeOnTask: TimeOnTask | null; onOpen: (href: string) => void;
}) {
  const cards = metricCards(metrics, range);
  const link = (href: string, children: ReactNode, className = "metric-link", key?: string) => (
    <a key={key ?? href} className={className} href={href} onClick={(e) => { e.preventDefault(); onOpen(href); }}>
      {children}
    </a>
  );
  const shaded = trends ? shadedBuckets(trends.buckets, trends.outages) : [];
  const labels = trends?.buckets.map((b) => `Week of ${formatShortDate(b.start)}`) ?? [];
  return (
    <>
      <div className="analytics-metrics metric-cards">
        {cards.map((c) =>
          link(
            c.href,
            <>
              <span className="metric-label">{c.label}</span>
              <strong>{c.value}</strong>
              <small>{c.note}</small>
              {c.delta && <span className="metric-delta">{c.delta}</span>}
              <span className="metric-action">{LABELS.seeDetails}</span>
            </>,
            `metric-card metric-link${c.secondary ? " secondary" : ""}${c.compact ? " compact" : ""}`,
            c.key,
          ),
        )}
      </div>
      <div className="activity-sources">
        {metrics.sources.map((s) =>
          link(
            teacherPaths.activity({ group: "question-activities", where: s.where }),
            <>
              <strong>{s.where === "kiwi" ? LABELS.whereKiwi : LABELS.whereLab}</strong>
              <span>{sourceText(s)}</span>
            </>,
            "panel source-card",
            s.where,
          ),
        )}
      </div>
      <section className="panel work-panel metrics-charts">
        <h2>Weekly trends</h2>
        {trends && trends.buckets.length ? (
          <div className="trend-grid">
            {(
              [
                ["Active students", trends.buckets.map((b) => b.active)],
                [LABELS.aiTutorQuestions, trends.buckets.map((b) => b.aiQuestions)],
                ["Answer attempts", trends.buckets.map((b) => b.attempts)],
                [LABELS.autoCheckedAccuracy, trends.buckets.map((b) => b.autoCheckedAccuracy)],
              ] as const
            ).map(([title, values]) => (
              <figure key={title} className="trend-chart">
                <figcaption>{title}</figcaption>
                <SparkBars values={values} labels={labels} shaded={shaded} width={220} height={48} max={title === LABELS.autoCheckedAccuracy ? 100 : undefined} ariaLabel={`${title} by week`} />
              </figure>
            ))}
          </div>
        ) : (
          <p className="muted">No weekly activity in this range yet.</p>
        )}
        {shaded.some(Boolean) && <p className="muted">Shaded weeks overlap a data-collection outage (see {LABELS.dataHealth}).</p>}
        <h2>Learning curve</h2>
        {curve && curve.length ? (
          <figure className="trend-chart">
            <figcaption>Auto-checked accuracy by attempt number</figcaption>
            <SparkBars values={curve.map((p) => p.accuracy)} labels={curve.map((p) => `Attempt ${p.attemptIndex} (n=${p.n})`)} width={220} height={48} max={100} ariaLabel="Accuracy by attempt number" />
          </figure>
        ) : (
          <p className="muted">No server-checked attempts yet.</p>
        )}
        <h2>Time on task</h2>
        {timeOnTask && timeOnTask.some((t) => t.students) ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Median active minutes</th>
                  <th>75th percentile</th>
                  <th>Students</th>
                </tr>
              </thead>
              <tbody>
                {timeOnTask.filter((t) => t.students).map((t) => (
                  <tr key={`${t.label}:${t.questionId}`}>
                    <td>
                      {t.label}
                      {t.prompt && <small>{t.prompt}</small>}
                    </td>
                    <td>{formatNumber(t.medianMinutes)}</td>
                    <td>{formatNumber(t.p75Minutes)}</td>
                    <td>{t.students}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Active minutes appear after students work on assignment questions.</p>
        )}
        {metrics.difficulty.length > 0 && (
          <>
            <h2>AI practice difficulty: requested vs observed</h2>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Requested difficulty</th>
                    <th>Items</th>
                    <th>Observed correct %</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.difficulty.map((d) => (
                    <tr key={d.level}>
                      <td>{d.nominal}</td>
                      <td>{d.items}</td>
                      <td>{fmt(d.observedCorrectPct, "%")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <section className="panel work-panel analytics-intro">
        <h2>Start with a learning question</h2>
        <div className="work-actions">
          <button className="outline-button" onClick={() => onOpen(teacherPaths.activity({ group: "questions", sort: "attempts" }))}>
            {LABELS.questionsNeedingAttempts}
          </button>
          <button className="outline-button" onClick={() => onOpen(teacherPaths.activity({ group: "chapters", sort: "aiQuestions" }))}>
            {LABELS.chaptersAskedMost}
          </button>
        </div>
      </section>
    </>
  );
}

export function CourseMetricsPage(_props: TeacherPageProps) {
  const { classId, course, timeRange } = useTeacher();
  const kiwiRevision = useKiwiRefreshRevision();
  const query = useMemo(() => rangeQuery(timeRange), [timeRange]);
  const key = JSON.stringify(query);
  const [metrics, setMetrics] = useState<CourseMetrics | null>(null);
  const [trends, setTrends] = useState<Trends | null>(null);
  const [curve, setCurve] = useState<Curve | null>(null);
  const [tot, setTot] = useState<TimeOnTask | null>(null);
  const [error, setError] = useState("");
  const unitId = course?.currentUnitId ?? "";
  useEffect(() => {
    let active = true;
    const r = JSON.parse(key) as Record<string, string>;
    setError("");
    const fail = (e: unknown) => {
      if (active) setError(e instanceof Error ? e.message : String(e));
    };
    api.metrics(classId, r).then((m) => active && setMetrics(m)).catch(fail);
    const trendRange: Record<string, string> = { bucket: "week" };
    if (r.to) trendRange.to = r.to;
    api.trends(classId, trendRange).then((t) => active && setTrends(t)).catch(fail);
    api.learningCurves(classId, {}).then((c) => active && setCurve(c.points)).catch(fail);
    if (unitId) api.timeOnTask(classId, { unitId }).then((t) => active && setTot(t.questions)).catch(fail);
    return () => {
      active = false;
    };
  }, [classId, key, kiwiRevision, unitId]);
  if (!course) return null;
  return (
    <>
      <PageHeader title="Course metrics" meta={timeRange.label} tabs={<SectionTabs section="insights" />} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {metrics ? (
        <CourseMetricsView metrics={metrics} range={timeRange} trends={trends} curve={curve} timeOnTask={tot} onOpen={navigate} />
      ) : (
        !error && <EmptyState>Loading course metrics…</EmptyState>
      )}
    </>
  );
}
