import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { FilterChips } from "../../components/FilterChips";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { Pager } from "../../components/Pager";
import { Popover } from "../../components/Popover";
import { StatusBadge, assignmentStateBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { formatRelative } from "../../lib/format";
import { LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { rememberPreviewReturn } from "../../lib/previewReturn";
import { previewPaths, teacherPaths } from "../../lib/routes";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import { AssignmentRowMenu } from "./AssignmentRowMenu";
import {
  fieldLabel,
  homeworkButton,
  lineageLinks,
  metaParts,
  protectionNote,
  STATUS_FILTERS,
  STUDENT_LIST_TITLES,
  studentStatusLabel,
  type ListItem,
  type RowAction,
  type StudentListState,
} from "./assignmentRules";
import type { AssignmentStudentStatus, Course, Permission } from "../../types";

/*
 * Assignments list (/teacher/assignments?status=&search=&page=) [DA01, TH01, NM10, NM11, F13]: one row per assignment
 * with a meta line whose numbers open student lists, Grade (n) → Release (n) → Graded ✓ for homework, Results for
 * in-class exercises, Edit and a ⋯ menu.
 */

export type StudentListLoader = (assignmentId: string, state: StudentListState) => Promise<{ students: AssignmentStudentStatus[]; emails: string[] | null }>;

function StudentList({ item, states, initial, load }: { item: ListItem; states: StudentListState[]; initial: StudentListState; load: StudentListLoader }) {
  const [state, setState] = useState(initial);
  const [startedOnly, setStartedOnly] = useState(false);
  const [rows, setRows] = useState<AssignmentStudentStatus[] | null>(null);
  const [emails, setEmails] = useState<string[] | null>(null);
  const [note, setNote] = useState("");
  const effective: StudentListState = state === "not_submitted" && startedOnly ? "started" : state;
  useEffect(() => {
    let active = true;
    setRows(null);
    load(item.id, effective)
      .then((result) => {
        if (!active) return;
        setRows(result.students);
        setEmails(result.emails);
      })
      .catch((e: unknown) => active && setNote(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, [item.id, effective, load]);
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNote(`${what} copied.`);
    } catch {
      setNote(`Could not copy ${what.toLowerCase()} — select them in the list instead.`);
    }
  };
  return (
    <div className="assess-student-list">
      {states.length > 1 && (
        <div className="assess-segmented" role="group" aria-label="Student list">
          {states.map((s) => (
            <button key={s} type="button" aria-pressed={state === s} onClick={() => setState(s)}>
              {STUDENT_LIST_TITLES[s]}
            </button>
          ))}
        </div>
      )}
      {state === "not_submitted" && (
        <label className="checkbox-label">
          <input type="checkbox" checked={startedOnly} onChange={(e) => setStartedOnly(e.target.checked)} /> Started only
        </label>
      )}
      {rows === null ? (
        <p role="status" className="muted">{note || "Loading students…"}</p>
      ) : rows.length === 0 ? (
        <p className="muted">No students in this list.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>Student</th><th>ID</th><th>Last active</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.studentId}>
                  <td>{row.studentName}</td>
                  <td className="mono">{row.studentId}</td>
                  <td>{row.lastActive ? formatRelative(row.lastActive) : "No activity"}</td>
                  <td>{studentStatusLabel(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="work-actions">
          {emails && <button type="button" className="outline-button" onClick={() => void copy(emails.join(", "), "Emails")}>Copy emails</button>}
          <button type="button" className="outline-button" onClick={() => void copy(rows.map((r) => r.studentName).join("\n"), "Names")}>Copy names</button>
        </div>
      )}
      {rows !== null && note && <p role="status" className="muted">{note}</p>}
    </div>
  );
}

function CountPopover({ item, label, states, initial, load, defaultOpen = false }: { item: ListItem; label: string; states: StudentListState[];
  initial: StudentListState; load?: StudentListLoader; defaultOpen?: boolean }) {
  if (!load) return <span>{label}</span>;
  return (
    <Popover label={label} ariaLabel={fieldLabel.countButton(label, item.title)} buttonClassName="text-button assess-count" align="start"
      className="assess-count-popover" defaultOpen={defaultOpen}>
      {() => <StudentList item={item} states={states} initial={initial} load={load} />}
    </Popover>
  );
}

export function AssignmentRow({ item, course, permissions, busy, timeZone, load, onAction, openList }: {
  item: ListItem; course: Course; permissions: readonly Permission[]; busy: boolean; timeZone?: string; load?: StudentListLoader;
  onAction: (action: RowAction | "edit" | "open", item: ListItem, href?: string) => void;
  /** student list to open on first render (`?open=<id>&list=missing`, Home › Missing › List) */
  openList?: "missing" | "late" | null;
}) {
  const parts = metaParts(item, timeZone);
  const badge = assignmentStateBadge(item.state);
  const homework = item.kind === "homework";
  const published = item.status === "published";
  const pastDue = item.state === "past_due" || item.state === "closed";
  const button = homeworkButton(item.stats, item.id);
  const chapter = course.units.find((u) => u.id === item.unitId)?.title || item.unitId;
  const canGrade = permissions.includes("grade");
  // Decision D2: published homework shows its actual answer-protection state (needs the server's solutionsVisibility).
  const protection = homework && published && item.solutionsVisibility
    ? protectionNote({ ...item, solutionsVisibility: item.solutionsVisibility, revisions: item.revisions }, timeZone)
    : null;
  const meta = parts.map((part) => {
    // RT-02: the in-class number carries its definition (the same one as Exercise results and the Gradebook)
    if (!homework && part.startsWith(`${LABELS.firstTryCorrect} `)) return <span key={part} title={LABELS.firstTryCorrectHelp}>{part}</span>;
    if (!homework || !published) return part;
    if (part.startsWith("Submitted the original ")) return <CountPopover key={part} item={item} label={part} load={load} initial="not_submitted"
      states={["submitted", "not_submitted", "missing"]} />;
    if (part.startsWith("Submitted ")) {
      return <CountPopover key={part} item={item} label={part} load={load} initial="submitted"
        states={pastDue ? ["submitted", "not_submitted", "missing"] : ["submitted", "not_submitted"]} />;
    }
    if (part.startsWith("To grade ")) return <CountPopover key={part} item={item} label={part} load={load} initial="to_grade" states={["to_grade"]} />;
    if (part.startsWith("Late ")) return <CountPopover key={part} item={item} label={part} load={load} initial="late" states={["late"]} defaultOpen={openList === "late"} />;
    if (part.startsWith("Missing ")) return <CountPopover key={part} item={item} label={part} load={load} initial="missing"
      states={["submitted", "not_submitted", "missing"]} defaultOpen={openList === "missing"} />;
    return part;
  });
  return (
    <article className="assess-row">
      <div className="assess-row-main">
        <div className="assess-row-title">
          <a href={teacherPaths.assignmentEdit(item.id)} onClick={(e) => { e.preventDefault(); onAction("edit", item); }}>{item.title}</a>
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        </div>
        {lineageLinks(item).length > 0 && (
          <div className="assess-lineage">
            {lineageLinks(item).map((link) => (
              <a key={link.id} href={teacherPaths.assignmentEdit(link.id)} onClick={(e) => { e.preventDefault(); navigate(teacherPaths.assignmentEdit(link.id)); }}>
                {link.label}
              </a>
            ))}
          </div>
        )}
        <div className="assess-meta">
          {meta.map((part, i) => (
            <span key={i}>{i > 0 && <span aria-hidden="true"> · </span>}{part}</span>
          ))}
          <span><span aria-hidden="true"> · </span>{chapter}</span>
        </div>
        {protection && <small className="muted assess-protection">{protection}</small>}
      </div>
      <div className="assess-row-actions">
        {homework ? (
          published && canGrade && button.href ? (
            <button type="button" className={button.kind === "done" || (button.kind === "grade" && item.stats.toGrade === 0) ? "outline-button" : "primary-button"} disabled={busy}
              onClick={() => onAction("open", item, button.href ?? undefined)}>
              {button.label}
            </button>
          ) : published ? <span className="muted">{button.label}</span> : null
        ) : (
          published && <button type="button" className="outline-button" onClick={() => onAction("open", item, teacherPaths.exerciseResults(item.id))}>{LABELS.results}</button>
        )}
        <button type="button" className="outline-button" onClick={() => onAction("edit", item)}>
          {permissions.includes("editAssignments") ? "Edit" : "View"}
        </button>
        <AssignmentRowMenu item={item} permissions={permissions} busy={busy} onAction={onAction} />
      </div>
    </article>
  );
}

export function AssignmentListView({ course, items, total, page, pageSize, loaded, busy, status, search, permissions, timeZone, load, onSearch,
  onStatus, onPage, onAction, unitId = "", onClearUnit, openItem = null }: {
  course: Course; items: ListItem[]; total: number; page: number; pageSize: number; loaded: boolean; busy: boolean; status: string; search: string;
  permissions: readonly Permission[]; timeZone?: string; load?: StudentListLoader; onSearch: (value: string) => void; onStatus: (value: string) => void;
  onPage: (page: number) => void; onAction: (action: RowAction | "edit" | "open", item: ListItem, href?: string) => void;
  /** Chapter filter from `?unitId=` (Chapters card link, CR-AIRULES-4; wired by INTEGRATION). */
  unitId?: string; onClearUnit?: () => void;
  /** `?open=&list=` deep link (TEACHER-12) */
  openItem?: { id: string; list: "missing" | "late" } | null;
}) {
  const canEdit = permissions.includes("editAssignments");
  const unitTitle = unitId ? course.units.find((u) => u.id === unitId)?.title || unitId : "";
  return (
    <section className="panel work-panel assess-list">
      <div className="assess-toolbar">
        <div className="assess-segmented" role="group" aria-label="Status">
          {STATUS_FILTERS.map((f) => (
            <button key={f.value} type="button" aria-pressed={status === f.value} onClick={() => onStatus(f.value)}>{f.label}</button>
          ))}
        </div>
        <label className="assess-search">
          <span className="assess-visually-hidden">Find an assignment</span>
          <input type="search" value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Find an assignment" aria-label="Find an assignment" />
        </label>
      </div>
      {unitId && (
        <FilterChips chips={[{ key: "unitId", label: "Chapter", value: unitTitle, onRemove: () => onClearUnit?.() }]} />
      )}
      {!loaded && <p role="status" className="empty-state">Loading assignments…</p>}
      {loaded && items.map((item) => (
        <AssignmentRow key={item.id} item={item} course={course} permissions={permissions} busy={busy} timeZone={timeZone} load={load} onAction={onAction}
          openList={openItem && openItem.id === item.id ? openItem.list : null} />
      ))}
      {loaded && !items.length && (
        <EmptyState>{status === "all" && !search && !unitId ? "No assignments yet. Create one or add starter assignments." : "No assignments match these filters."}</EmptyState>
      )}
      <Pager page={page} total={total} size={pageSize} onPage={onPage} />
      {canEdit && (
        <p className="assess-starter-link">
          <a href={teacherPaths.starterAssignments()} onClick={(e) => { e.preventDefault(); navigate(teacherPaths.starterAssignments()); }}>
            {LABELS.starterAssignments}
          </a>
        </p>
      )}
    </section>
  );
}

type Confirm = { action: RowAction; item: ListItem } | null;
const DONE: Partial<Record<RowAction, string>> = {
  close: "submissions closed", reopen: "reopened", archive: "archived", unarchive: "unarchived", delete: "deleted",
};
const CONFIRM: Partial<Record<RowAction, { title: string; body: string; label: string; danger?: boolean }>> = {
  clearPreview: { title: LABELS.clearTestSubmissions, body: "Delete the preview submissions, drafts, checks and AI chats made with Preview as student on this assignment? Student work is not affected.", label: LABELS.clearTestSubmissions },
  close: { title: "Close submissions", body: "Students can still open the assignment but can no longer submit.", label: "Close submissions" },
  archive: { title: "Archive assignment", body: "Archived work is hidden from students and from the default list. Grades and submissions are kept.", label: "Archive" },
  delete: { title: "Delete draft", body: "This draft has no student work. Delete it?", label: "Delete draft", danger: true },
};

export function AssignmentListPage({ route }: TeacherPageProps) {
  const { classId, course, me } = useTeacher();
  const url = new URL(route, "http://lab.local");
  const status = url.searchParams.get("status") || "all";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const urlSearch = url.searchParams.get("search") || "";
  const unitId = url.searchParams.get("unitId") || "";
  const openId = url.searchParams.get("open") || "";
  const openListParam = url.searchParams.get("list");
  const openItem: { id: string; list: "missing" | "late" } | null =
    openId && (openListParam === "missing" || openListParam === "late") ? { id: openId, list: openListParam } : null;
  const [search, setSearch] = useState(urlSearch);
  const [items, setItems] = useState<ListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);
  const loadId = useRef(0);

  const setQuery = useCallback((values: { status?: string; search?: string; page?: number; unitId?: string }) => {
    const next = { status, search: urlSearch, page, unitId, ...values };
    navigate(teacherPaths.assignments({ status: next.status === "all" ? undefined : next.status, search: next.search || undefined,
      page: next.page > 1 ? next.page : undefined, unitId: next.unitId || undefined }), true);
  }, [status, urlSearch, page, unitId]);
  useEffect(() => setSearch(urlSearch), [urlSearch]);
  useEffect(() => {
    if (search === urlSearch) return;
    const timer = setTimeout(() => setQuery({ search, page: 1 }), 250);
    return () => clearTimeout(timer);
  }, [search, urlSearch, setQuery]);
  useEffect(() => {
    api.settings(classId).then((s) => setTimeZone(s.schedule.timezone)).catch(() => undefined /* WHY: dates fall back to the browser zone */);
  }, [classId]);

  const refresh = useCallback(async () => {
    const request = ++loadId.current;
    setLoaded(false);
    const result = await api.assignments(classId, { status, search: urlSearch, page: String(page), unitId });
    if (request !== loadId.current) return;
    setItems(result.assignments as ListItem[]);
    setTotal(result.total);
    setPageSize(result.pageSize);
    setLoaded(true);
  }, [classId, status, urlSearch, page, unitId]);
  useEffect(() => {
    void refresh().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setLoaded(true);
    });
    return () => {
      loadId.current += 1;
    };
  }, [refresh]);
  const load = useCallback<StudentListLoader>((id, state) => api.assignmentStudents(classId, id, state), [classId]);

  const execute = async (action: RowAction, item: ListItem) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (action === "duplicate" || action === "revision") {
        const copy = await api.duplicateAssignment(classId, item.id, action === "revision" ? { asRevision: true, retireOriginalOnPublish: true } : {});
        navigate(teacherPaths.assignmentEdit(copy.id));
        return;
      }
      if (action === "clearPreview") {
        const result = await api.clearPreviewSubmissions(classId, item.id);
        const removed = Object.values(result.counts).reduce((n, v) => n + v, 0);
        setMessage(`Test submissions cleared (${removed} records).`);
      } else if (action === "close") await api.closeAssignment(classId, item.id);
      else if (action === "reopen") await api.reopenAssignment(classId, item.id);
      else if (action === "archive") await api.archiveAssignment(classId, item.id);
      else if (action === "unarchive") await api.unarchiveAssignment(classId, item.id);
      else if (action === "delete") await api.deleteAssignment(classId, item.id);
      const done = DONE[action];
      if (done) setMessage(`${item.title}: ${done}.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const onAction = (action: RowAction | "edit" | "open", item: ListItem, href?: string) => {
    if (action === "edit") return navigate(teacherPaths.assignmentEdit(item.id));
    if (action === "open") return href ? navigate(href) : undefined;
    if (action === "preview") {
      rememberPreviewReturn(location.pathname + location.search);   // RV6-m01: Exit preview returns to this list
      return navigate(previewPaths.assignment(item.id));
    }
    if (CONFIRM[action]) return setConfirm({ action, item });
    void execute(action, item);
  };
  if (!course) return null;
  const dialog = confirm ? CONFIRM[confirm.action] : undefined;
  return (
    <div className="teacher-work">
      <PageHeader title={LABELS.navAssignments} count={loaded ? total : undefined} tabs={<SectionTabs section="assignments" />}
        actions={me.permissions.includes("editAssignments") && (
          <button type="button" className="primary-button" onClick={() => navigate(teacherPaths.assignmentNew())}>
            <Plus size={16} /> New assignment
          </button>
        )} />
      {error && <p className="error-text" role="alert">{error}</p>}
      {message && <p className="work-message" role="status">{message}</p>}
      <AssignmentListView course={course} items={items} total={total} page={page} pageSize={pageSize} loaded={loaded} busy={busy} status={status}
        search={search} permissions={me.permissions} timeZone={timeZone} load={load} onSearch={setSearch}
        onStatus={(value) => setQuery({ status: value, page: 1 })} onPage={(p) => setQuery({ page: p })} onAction={onAction}
        unitId={unitId} onClearUnit={() => setQuery({ unitId: "", page: 1 })} openItem={openItem} />
      <ConfirmDialog open={Boolean(confirm && dialog)} title={dialog?.title ?? ""} confirmLabel={dialog?.label ?? "Confirm"} danger={dialog?.danger} busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const current = confirm;
          setConfirm(null);
          if (current) void execute(current.action, current.item);
        }}>
        {confirm && <p><strong>{confirm.item.title}</strong> — {dialog?.body}</p>}
      </ConfirmDialog>
    </div>
  );
}
