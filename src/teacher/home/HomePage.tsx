import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { useStudentLabel } from "../../components/NameContext";
import { api } from "../../lib/api";
import { formatShortDate } from "../../lib/format";
import { LABELS } from "../../lib/labels";
import { teacherPaths } from "../../lib/routes";
import { rangeQuery } from "../../lib/timeRange";
import { useKiwiRefreshRevision } from "../kiwi/useKiwiSync";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import { AskedAiPanel } from "./AskedAiPanel";
import { AttentionList } from "./AttentionList";
import { GlanceRow } from "./GlanceRow";
import { HomeLink } from "./HomeLink";
import { KiwiBanner } from "./KiwiBanner";
import { NeedsActionStrip } from "./NeedsActionStrip";
import { ReteachPanel } from "./ReteachPanel";
import { assignmentLine, bannerDismissed, dismissBanner, headerParts, homeLinks } from "./homeModel";
import type { AttentionItem, HomeData, Permission, ReteachCandidate, ReteachMark, TimeRange } from "../../types";

/*
 * Home [F05, TH06, LY01] — the teacher's landing page (§13.1). Desktop: header strip, Needs your action, then
 * Students needing attention | What to re-teach, Assignments | What students asked the AI, glance row.
 * Narrow screens follow the mobile order of §13.1 (CSS order in insights.css).
 */

export type HomeViewData = HomeData & { attention: HomeData["attention"] & { rules?: string[] } };

export interface HomeViewProps {
  data: HomeViewData;
  range: TimeRange;
  permissions: readonly Permission[];
  bannerHidden: boolean;
  onDismissBanner: () => void;
  onMark: (c: ReteachCandidate) => void;
  onDone: (m: ReteachMark) => void;
  busy?: string;
  studentLabel: (item: AttentionItem) => string;
}

export function HomeView({ data, range, permissions, bannerHidden, onDismissBanner, onMark, onDone, busy, studentLabel }: HomeViewProps) {
  const links = homeLinks(permissions);
  const can = (p: Permission) => permissions.includes(p);
  const parts = headerParts(data.header, (iso) => formatShortDate(iso));
  return (
    <div className="home-page">
      <KiwiBanner linked={data.header.kiwi.linked} dismissed={bannerHidden} canSetUp={links.settings} onDismiss={onDismissBanner} />
      <section className="home-header-strip" aria-label="Course status">
        <p>
          <strong>{data.header.courseTitle}</strong>
          <span className="separator-dot"> · </span>
          {parts.thisWeek}{" "}
          {can("manageCourse") && (
            <HomeLink className="text-button" href={teacherPaths.chapters()} allowed>
              Change
            </HomeLink>
          )}
          <span className="separator-dot"> · </span>
          {parts.freePractice}
        </p>
        <p>
          {parts.aiRules} · {parts.aiStatus}{" "}
          {links.chapters && (
            <HomeLink className="text-button" href={teacherPaths.aiRulesEditor(data.header.aiRules.unitId || "course")} allowed>
              {can("manageAiRules") ? "Edit AI rules" : "View AI rules"}
            </HomeLink>
          )}
        </p>
      </section>
      <div className="home-grid">
        <NeedsActionStrip action={data.needsAction} links={links} />
        <AttentionList
          students={data.attention.students}
          total={data.attention.total}
          rulesText={data.attention.rules ?? []}
          canGrade={links.grading}
          studentLabel={studentLabel}
        />
        <ReteachPanel candidates={data.reteach.candidates} marked={data.reteach.marked} canMark={can("viewStudents") && can("grade")} busy={busy} onMark={onMark} onDone={onDone} />
        <section className="panel home-block home-assignments" aria-labelledby="home-assignments-title">
          <div className="home-block-head">
            <h2 id="home-assignments-title">Assignments</h2>
            {can("editAssignments") && (
              <HomeLink className="outline-button" href={teacherPaths.assignmentNew()} allowed>
                + New assignment
              </HomeLink>
            )}
          </div>
          {data.assignments.length ? (
            <ul className="home-assignment-list">
              {data.assignments.map((a) => (
                <li key={a.id}>
                  <HomeLink
                    href={
                      a.kind === "practice"
                        ? teacherPaths.exerciseResults(a.id)
                        : links.grading
                          ? teacherPaths.grading({ assignmentId: a.id, show: "latest" })
                          : teacherPaths.activity({ group: "question-activities", assignmentId: a.id })
                    }
                    allowed={links.insights}
                  >
                    {assignmentLine(a)}
                  </HomeLink>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No homework or in-class exercise is due in the next 7 days or closed in this period.</p>
          )}
        </section>
        <AskedAiPanel asked={data.askedAi} flaggedVisible={data.needsAction.flaggedReplies !== null} />
        <GlanceRow glance={data.glance} range={range} />
      </div>
    </div>
  );
}

export function HomePage(_props: TeacherPageProps) {
  const { classId, me, timeRange } = useTeacher();
  const studentLabel = useStudentLabel();
  const kiwiRevision = useKiwiRefreshRevision();
  const [data, setData] = useState<HomeViewData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [revision, setRevision] = useState(0);
  const [hidden, setHidden] = useState(() => bannerDismissed(classId));
  const query = useMemo(() => rangeQuery(timeRange), [timeRange]);
  const key = JSON.stringify(query);

  useEffect(() => {
    let active = true;
    setError("");
    api
      .home(classId, JSON.parse(key) as typeof query)
      .then((d) => {
        if (active) setData(d as HomeViewData);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [classId, key, revision, kiwiRevision]);

  const reload = useCallback(() => setRevision((r) => r + 1), []);
  const onMark = (c: ReteachCandidate) => {
    const id = `${c.assignmentId}:${c.questionId}`;
    setBusy(id);
    api
      .markReteach(classId, { targetKind: "question", assignmentId: c.assignmentId, questionId: c.questionId, unitId: "", chatTurnId: null, label: `${c.label} ${c.prompt}`.trim(), note: "" })
      .then(reload)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(""));
  };
  const onDone = (m: ReteachMark) => {
    api
      .updateReteach(classId, m.id, { resolved: true })
      .then(reload)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <>
      <PageHeader title={LABELS.navHome} meta={timeRange.label} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {data ? (
        <HomeView
          data={data}
          range={timeRange}
          permissions={me.permissions}
          bannerHidden={hidden}
          onDismissBanner={() => {
            dismissBanner(classId);
            setHidden(true);
          }}
          onMark={onMark}
          onDone={onDone}
          busy={busy}
          studentLabel={(item) => studentLabel(item)}
        />
      ) : (
        !error && <EmptyState>Loading Home…</EmptyState>
      )}
    </>
  );
}
