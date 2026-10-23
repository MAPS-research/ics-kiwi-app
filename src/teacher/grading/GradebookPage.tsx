import { useEffect, useState, type MouseEvent } from "react";
import { ChevronDown, Download } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { Pager } from "../../components/Pager";
import { StatusBadge } from "../../components/StatusBadge";
import { api, type Q } from "../../lib/api";
import { downloadBlob } from "../../lib/csv";
import { LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { Gradebook, Group } from "../../types";
import { gradingTabCounts } from "./gradingKeys";
import { useToGradeCount } from "./useToGradeCount";
import { cellAriaLabel, cellHref, cellLineageNote, cellMuted, cellText, cellTone, inClassText, parsePolicy, POLICY_OPTIONS, type ScorePolicy } from "./gradebookCells";

/*
 * Gradebook (GRADE; NM17–NM19, TR04, FD04, AU-D4-26). ?policy=latest|highest&search=&groupId=
 * Viewers see the same data without grading links or the LMS export.
 */

const PAGE_SIZE = 50;

function follow(href: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    navigate(href);
  };
}

export type GradebookDownload = "grades" | "status";

/** Export ▾ (NM19): Grades for LMS (CSV) · Student × assignment status (CSV) · Activity log · AI conversations · Research package. */
export function GradebookExportMenu({ canExport, busy, onDownload }: { canExport: boolean; busy: boolean; onDownload: (kind: GradebookDownload) => void }) {
  return (
    <details className="export-menu gradebook-export">
      <summary className="outline-button">
        <Download size={15} aria-hidden="true" /> {busy ? "Preparing…" : LABELS.exportMenu} <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <ul className="menu-list">
        {canExport && (
          <>
            <li>
              <button type="button" className="menu-item" disabled={busy} onClick={() => onDownload("grades")}>
                {LABELS.gradesForLms}
              </button>
            </li>
            <li>
              <button type="button" className="menu-item" disabled={busy} onClick={() => onDownload("status")}>
                {LABELS.studentAssignmentStatusCsv}
              </button>
            </li>
          </>
        )}
        {[LABELS.activityLog, LABELS.aiConversations, LABELS.researchPackage].map((label) => (
          <li key={label}>
            <a className="menu-item" href={teacherPaths.exports()} onClick={follow(teacherPaths.exports())}>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

export interface GradebookViewProps {
  book: Gradebook | null;
  canGrade: boolean;
  canExport: boolean;
  groups: readonly Group[];
  policy: ScorePolicy;
  search: string;
  groupId: string;
  page: number;
  loading: boolean;
  exportBusy?: boolean;
  onPolicy: (policy: ScorePolicy) => void;
  onSearch: (value: string) => void;
  onGroup: (groupId: string) => void;
  onPage: (page: number) => void;
  onDownload?: (kind: GradebookDownload) => void;
}

export function GradebookView({ book, canGrade, canExport, groups, policy, search, groupId, page, loading, exportBusy = false,
  onPolicy, onSearch, onGroup, onPage, onDownload = () => undefined }: GradebookViewProps) {
  // RV6-m15: Section / Condition columns only when the course has such groups (empty columns pushed grades off-screen)
  const showSection = groups.some((g) => g.kind === "section") || Boolean(book?.rows.some((r) => r.section));
  const showCondition = groups.some((g) => g.kind === "condition") || Boolean(book?.rows.some((r) => r.condition));
  return (
    <section className="panel work-panel">
      <div className="table-toolbar gradebook-toolbar">
        <div className="segmented" role="group" aria-label="Score policy">
          {POLICY_OPTIONS.map((o) => (
            <button key={o.value} type="button" className="outline-button" aria-pressed={policy === o.value} onClick={() => onPolicy(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
        <label>
          Find a student
          <input type="search" value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search name or ID" />
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
        <GradebookExportMenu canExport={canExport} busy={exportBusy} onDownload={onDownload} />
      </div>
      <p className="muted gradebook-note">
        {policy === "highest" ? "Scores use each student's highest released attempt." : "Scores use each student's latest attempt."} Every cell opens
        {canGrade ? " its grading card (or the timeline when nothing was submitted)." : " the student's timeline for that assignment."}
      </p>
      <div className="table-scroll">
        <table className="data-table gradebook-table">
          <thead>
            <tr>
              <th scope="col">Student</th>
              {showSection && <th scope="col" className="gradebook-group-col">Section</th>}
              {showCondition && <th scope="col" className="gradebook-group-col">Condition</th>}
              {book?.columns.map((c) => (
                <th scope="col" key={c.assignmentId}>
                  {c.header}
                </th>
              ))}
              {book?.inClassColumns.map((c) => (
                <th scope="col" key={c.assignmentId}>
                  {c.title}
                  <small>In-class exercise</small>
                </th>
              ))}
              <th scope="col">Active minutes<small>Whole term</small></th>
              <th scope="col">{LABELS.aiTutorQuestions}<small>Whole term</small></th>
              <th scope="col">R runs<small>Whole term</small></th>
            </tr>
          </thead>
          <tbody>
            {book?.rows.map((row) => (
              <tr key={row.studentId}>
                <th scope="row">
                  <a className="table-row-link" href={teacherPaths.studentProfile(row.studentId)} onClick={follow(teacherPaths.studentProfile(row.studentId))}>
                    {row.studentName}
                  </a>
                  {/* S-m14: like the roster, the student id under the name (pseudonyms appear only in Presentation mode) */}
                  {row.pseudonym !== row.studentName && row.studentId !== row.studentName && <small className="mono">{row.studentId}</small>}
                  {/* RV6-m15: on phones the group columns fold under the name so the grades stay in view */}
                  {(row.section || row.condition) && <small className="gradebook-groups">{[row.section, row.condition].filter(Boolean).join(" · ")}</small>}
                </th>
                {showSection && <td className="gradebook-group-col">{row.section ?? "—"}</td>}
                {showCondition && <td className="gradebook-group-col">{row.condition ?? "—"}</td>}
                {book.columns.map((column, i) => {
                  const cell = row.cells[i];
                  if (!cell) return <td key={column.assignmentId}>—</td>;
                  const href = cellHref(cell, row.studentId, canGrade);
                  return (
                    <td key={column.assignmentId} className={cellMuted(cell) ? "gradebook-cell cell-muted" : "gradebook-cell"}>
                      <a href={href} onClick={follow(href)} aria-label={cellAriaLabel(row.studentName, column.header, cell)}
                        title={cellLineageNote(cell) || undefined}>
                        <StatusBadge tone={cellTone(cell.state)}>{cellText(cell)}</StatusBadge>
                        {cell.late && <StatusBadge tone="warning">Late</StatusBadge>}
                      </a>
                    </td>
                  );
                })}
                {book.inClassColumns.map((column) => {
                  const entry = row.inClass.find((e) => e.assignmentId === column.assignmentId) ?? { completionPct: null, accuracyPct: null };
                  return <td key={column.assignmentId} className="gradebook-inclass" title={LABELS.firstTryCorrectHelp}>{inClassText(entry)}</td>;
                })}
                <td>{Math.round(row.activeMinutes)}</td>
                <td>{row.aiQuestions}</td>
                <td>{row.codeRuns}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && book && !book.rows.length && <EmptyState>No enrolled students match these filters.</EmptyState>}
      {book && <Pager page={page} total={book.total} size={PAGE_SIZE} onPage={onPage} />}
    </section>
  );
}

export function GradebookPage({ route }: TeacherPageProps) {
  const { classId, me } = useTeacher();
  const toGradeCount = useToGradeCount();
  const query = new URL(route, "http://lab.local").searchParams;
  const policy = parsePolicy(query.get("policy"));
  const groupId = query.get("groupId") || "";
  const [search, setSearch] = useState(query.get("search") || "");
  const [applied, setApplied] = useState(search);
  const [page, setPage] = useState(1);
  const [book, setBook] = useState<Gradebook | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportBusy, setExportBusy] = useState(false);
  const [error, setError] = useState("");
  const canGrade = me.permissions.includes("grade");
  const canExport = me.permissions.includes("exportGrades");

  useEffect(() => {
    const timer = setTimeout(() => setApplied(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    // WHY: the Group filter is optional; without groups (or before PEOPLE's endpoint exists) it is simply hidden.
    api.groups(classId).then((list) => active && setGroups(list.filter((g) => !g.archived))).catch(() => active && setGroups([]));
    return () => {
      active = false;
    };
  }, [classId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const q: Q = { policy, page: String(page), pageSize: String(PAGE_SIZE) };
    if (applied) q.search = applied;
    if (groupId) q.groupId = groupId;
    api
      .gradebook(classId, q)
      .then((result) => active && setBook(result))
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [classId, policy, page, applied, groupId]);

  const go = (patch: { policy?: ScorePolicy; groupId?: string }) => {
    setPage(1);
    navigate(teacherPaths.gradebook({ policy: patch.policy ?? policy, groupId: patch.groupId ?? groupId, search: applied }), true);
  };
  const download = async (kind: GradebookDownload) => {
    setExportBusy(true);
    setError("");
    try {
      const q: Q = { policy, releasedOnly: "1", layout: "wide" };
      if (groupId) q.groupIds = groupId;
      const file = kind === "grades" ? await api.gradesCsv(classId, q) : await api.assignmentStatusCsv(classId, groupId ? { groupIds: groupId } : {});
      downloadBlob(file.blob, file.filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportBusy(false);
    }
  };
  return (
    <>
      <PageHeader title={LABELS.gradebook} count={book ? book.total : undefined} tabs={<SectionTabs section="grading" counts={gradingTabCounts(toGradeCount)} />} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <GradebookView
        book={book}
        canGrade={canGrade}
        canExport={canExport}
        groups={groups}
        policy={policy}
        search={search}
        groupId={groupId}
        page={page}
        loading={loading}
        exportBusy={exportBusy}
        onPolicy={(p) => go({ policy: p })}
        onSearch={(value) => {
          setSearch(value);
          setPage(1);
        }}
        onGroup={(g) => go({ groupId: g })}
        onPage={setPage}
        onDownload={(kind) => void download(kind)}
      />
    </>
  );
}
