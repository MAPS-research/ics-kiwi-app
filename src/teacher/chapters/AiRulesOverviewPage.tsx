import { useEffect, useState } from "react";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { AiStatus } from "../../types";
import { cellLabel, effectiveAccessLabel, statusBarText, type OverviewCell, type RulesOverview } from "./policyForm";

/*
 * AI tutor rules overview (/teacher/chapters/ai) [TH08, TH16, AU-D2-23]: matrix rows = course default + chapters,
 * columns = all students + each section/condition group; cells `Default` / `Customized · v4 · 10/21` / `Uses course
 * default`, each linking to the editor for that scope.
 */

function CellLink({ cell, href, label, timeZone }: { cell: OverviewCell | null; href: string; label: string; timeZone?: string }) {
  const text = cellLabel(cell, timeZone);
  return (
    <a
      href={href}
      className={`airules-cell is-${cell?.status ?? "default"}`}
      aria-label={`${label}: ${text}`}
      title={cell?.updatedBy ? `Saved by ${cell.updatedBy}` : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(href);
      }}
    >
      {text}
    </a>
  );
}

export function AiRulesOverviewView({ overview, status, timeZone }: { overview: RulesOverview; status: AiStatus | null; timeZone?: string }) {
  const columns = [{ id: "", name: "All students" }, ...overview.groups.map((g) => ({ id: g.id, name: g.name }))];
  const courseCell = (groupId: string): OverviewCell | null =>
    groupId ? overview.courseCells?.[groupId] ?? null : { ...overview.courseDefault, updatedBy: null };
  return (
    <>
      <div className={`airules-status ${status?.configured ? "is-connected" : "is-local"}`} role="status">
        <span>{statusBarText(status, !status)}</span>
      </div>
      <section className="panel work-panel airules-section">
        <p className="muted">
          A chapter without its own rules uses the course default; the course default without its own rules uses the platform default. Group rules apply to the
          students in that section or condition.
        </p>
        <div className="table-scroll">
          <table className="data-table airules-matrix">
            <thead>
              <tr>
                <th scope="col">Chapter</th>
                {columns.map((c) => (
                  <th key={c.id || "all"} scope="col">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Course default</th>
                {columns.map((c) => (
                  <td key={c.id || "all"}>
                    <CellLink cell={courseCell(c.id)} href={teacherPaths.aiRulesEditor("course", c.id ? { groupId: c.id } : {})} label={`Course default, ${c.name}`} timeZone={timeZone} />
                  </td>
                ))}
              </tr>
              {overview.units.map((unit) => (
                <tr key={unit.unitId}>
                  <th scope="row">
                    {unit.title}
                    {unit.effectiveAccess !== "open" && (
                      <>
                        {" "}
                        <StatusBadge tone="neutral">{effectiveAccessLabel(unit.effectiveAccess)}</StatusBadge>
                      </>
                    )}
                  </th>
                  {columns.map((c) => (
                    <td key={c.id || "all"}>
                      <CellLink
                        cell={unit.cells[c.id] ?? null}
                        href={teacherPaths.aiRulesEditor(unit.unitId, c.id ? { groupId: c.id } : {})}
                        label={`${unit.title}, ${c.name}`}
                        timeZone={timeZone}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export function AiRulesOverviewPage(_props: TeacherPageProps) {
  const { classId } = useTeacher();
  const [overview, setOverview] = useState<RulesOverview | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Promise.all([api.aiRulesOverview(classId), api.aiStatus(classId)])
      .then(([o, s]) => {
        if (!live) return;
        setOverview(o as RulesOverview);
        setStatus(s);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [classId]);
  return (
    <>
      <PageHeader title={LABELS.aiTutorRulesTitle} tabs={<SectionTabs section="chapters" />} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {overview ? <AiRulesOverviewView overview={overview} status={status} /> : !error && <p className="muted">Loading AI tutor rules…</p>}
    </>
  );
}
