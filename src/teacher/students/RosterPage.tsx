import { useCallback, useEffect, useMemo, useState } from "react";
import { Upload, UserRound } from "lucide-react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { MultiSelectBar, allSelected, setAllSelected, toggleSelected } from "../../components/MultiSelectBar";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { Pager } from "../../components/Pager";
import { StatusBadge, type BadgeTone } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { displayTimeZone, formatRelative } from "../../lib/format";
import { LABELS, lastLearningActionText, missingItemText, missingWorkTooltip, rowActionLabel } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import { mappingProblem, parseRosterFile, ROSTER_FIELDS, toImportRows, type ParsedRoster, type RosterField, type RosterMapping } from "./rosterImport";
import type { ConsentState, Group, RosterEntry, RosterImportResult } from "../../types";

/*
 * Roster [PEOPLE-04/10/14, NM24]: Student · ID · Group · Last seen · Missing work · Research consent · Profile.
 * B-m01: "Last seen" is any student event; the cell also shows the last learning action (the Needs attention rule).
 * D8: the Missing work count opens the list of homework, a revision with its original (a homework and its revisions count
 * once). K-m05: these explanations are visible text (definitions above the table, notes under the headers, the last
 * learning action under each time, a disclosure for the missing list) — the `title` tooltips stay as a second copy, but
 * keyboard and touch users never depend on them.
 * Instructors import (CSV with header mapping, preview diff, apply), mark students dropped or excluded from
 * analytics, and record consent overrides with a note. Names come from the server in the current name mode.
 */

export const PAGE_SIZE = 50;
export const ROSTER_COLUMNS = ["Student", "ID", "Group", LABELS.lastSeen, LABELS.missingWork, LABELS.researchConsent, "Profile"] as const;
/** Header tooltips that define the activity and missing-work columns (README › Metric definitions). */
export const ROSTER_COLUMN_HELP: Readonly<Partial<Record<(typeof ROSTER_COLUMNS)[number], string>>> = {
  [LABELS.lastSeen]: `${LABELS.lastSeenHelp} ${LABELS.learningActionsHelp}`,
  [LABELS.missingWork]: LABELS.missingWorkHelp,
};
/** K-m05: the short note printed under a header (the definition itself is printed above the table). */
export const ROSTER_COLUMN_NOTES: Readonly<Partial<Record<(typeof ROSTER_COLUMNS)[number], string>>> = {
  [LABELS.lastSeen]: LABELS.lastSeenNote,
  [LABELS.missingWork]: LABELS.missingWorkNote,
};
export const ROSTER_HELP_ID = "roster-column-help";

/** K-m05: the Missing work cell — the count, and a disclosure that lists the homework (keyboard and touch reachable). */
export function MissingWorkCell({ entry }: { entry: Pick<RosterEntry, "studentName" | "missingWork" | "missingWorkItems"> }) {
  const items = entry.missingWorkItems ?? [];
  if (!entry.missingWork || !items.length) return <>{entry.missingWork}</>;
  return (
    <details className="roster-missing">
      <summary aria-label={`${LABELS.missingWork} for ${entry.studentName}: ${entry.missingWork}`}>{entry.missingWork}</summary>
      <ul>
        {items.map((item) => <li key={item.assignmentId}>{missingItemText(item)}</li>)}
      </ul>
    </details>
  );
}

export function consentLabel(consent: ConsentState): string {
  return consent === "yes" ? "Yes" : consent === "no" ? "No" : "Not asked";
}
export function consentTone(consent: ConsentState): BadgeTone {
  return consent === "yes" ? "success" : consent === "no" ? "danger" : "neutral";
}
export function consentSourceLabel(entry: Pick<RosterEntry, "consentSource">): string {
  return entry.consentSource === "teacher" ? "teacher record" : entry.consentSource === "kiwi" ? "from Kiwi" : "";
}
export function groupSummary(groups: RosterEntry["groups"]): string {
  return groups.map((g) => g.name).join(" · ") || "—";
}

export interface RosterFilters { search: string; groupId: string; consent: "" | ConsentState; status: "" | "active" | "dropped" }

export function RosterView({
  students, total, page, filters, groups, canManage, selected, onFilter, onPage, onEdit, onToggle, onToggleAll, hideIds = false,
}: {
  /** Presentation mode: ids can carry names (e.g. demo-ada), so they are not shown while projecting. */
  hideIds?: boolean;
  students: RosterEntry[] | null;
  total: number;
  page: number;
  filters: RosterFilters;
  groups: Group[];
  canManage: boolean;
  selected: ReadonlySet<string>;
  onFilter: (f: RosterFilters) => void;
  onPage: (page: number) => void;
  onEdit: (entry: RosterEntry) => void;
  onToggle: (studentId: string) => void;
  onToggleAll: (on: boolean) => void;
}) {
  const ids = students?.map((s) => s.studentId) ?? [];
  return (
    <section className="panel work-panel">
      <div className="table-toolbar people-filters">
        <label className="work-label">
          Search
          <input aria-label="Search students" value={filters.search} placeholder="Name, ID, email or S-0…" onChange={(e) => onFilter({ ...filters, search: e.target.value })} />
        </label>
        <label className="work-label">
          Group
          <select aria-label="Filter by group" value={filters.groupId} onChange={(e) => onFilter({ ...filters, groupId: e.target.value })}>
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.kind})
              </option>
            ))}
          </select>
        </label>
        <label className="work-label">
          {LABELS.researchConsent}
          <select aria-label="Filter by research consent" value={filters.consent} onChange={(e) => onFilter({ ...filters, consent: e.target.value as RosterFilters["consent"] })}>
            <option value="">Any</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
            <option value="not_asked">Not asked</option>
          </select>
        </label>
        <label className="work-label">
          Status
          <select aria-label="Filter by status" value={filters.status} onChange={(e) => onFilter({ ...filters, status: e.target.value as RosterFilters["status"] })}>
            <option value="">Active and dropped</option>
            <option value="active">Active</option>
            <option value="dropped">Dropped</option>
          </select>
        </label>
      </div>
      <p className="muted roster-column-help" id={ROSTER_HELP_ID}>
        {ROSTER_COLUMN_HELP[LABELS.lastSeen]} {LABELS.missingWork}: {LABELS.missingWorkHelp}
      </p>
      <div className="table-scroll">
        <table className="data-table roster-table" aria-describedby={ROSTER_HELP_ID}>
          <thead>
            <tr>
              {canManage && (
                <th>
                  <input type="checkbox" aria-label="Select all students on this page" checked={allSelected(selected, ids)} onChange={(e) => onToggleAll(e.target.checked)} />
                </th>
              )}
              {ROSTER_COLUMNS.map((c) => (
                <th key={c} title={ROSTER_COLUMN_HELP[c]}>
                  {c}
                  {/* aria-hidden: screen readers get the full definition through the table's description */}
                  {ROSTER_COLUMN_NOTES[c] && <small className="th-note" aria-hidden="true">{ROSTER_COLUMN_NOTES[c]}</small>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {students?.map((s) => (
              <tr key={s.studentId} className={s.status === "dropped" || s.excluded ? "muted-row" : undefined}>
                {canManage && (
                  <td>
                    <input type="checkbox" aria-label={`Select ${s.studentName}`} checked={selected.has(s.studentId)} onChange={() => onToggle(s.studentId)} />
                  </td>
                )}
                <td>
                  <strong>{s.studentName}</strong>
                  {s.email && <small className="muted block">{s.email}</small>}
                  {s.status === "dropped" && <StatusBadge tone="neutral">Dropped</StatusBadge>}
                  {s.excluded && <StatusBadge tone="warning" title={s.exclusionReason}>Excluded from analytics</StatusBadge>}
                </td>
                <td className="mono">{hideIds ? "hidden" : s.studentId}</td>
                <td className="roster-wrap-cell">{groupSummary(s.groups)}</td>
                <td className="roster-wrap-cell roster-seen-cell" title={lastLearningActionText(s.lastLearningAction ? formatRelative(s.lastLearningAction) : "")}>
                  {s.lastActive ? formatRelative(s.lastActive) : "Not seen yet"}
                  <small className="muted block">{lastLearningActionText(s.lastLearningAction ? formatRelative(s.lastLearningAction) : "")}</small>
                </td>
                <td className="roster-wrap-cell" title={missingWorkTooltip(s.missingWorkItems ?? []) || undefined}>
                  <MissingWorkCell entry={s} />
                </td>
                <td>
                  <StatusBadge tone={consentTone(s.consent)} title={consentSourceLabel(s)}>
                    {consentLabel(s.consent)}
                  </StatusBadge>
                </td>
                <td className="roster-wrap-cell roster-profile-cell">
                  <button className="text-button" aria-label={rowActionLabel(LABELS.openProfile, s.studentName)}
                    onClick={() => navigate(teacherPaths.studentProfile(s.studentId))}>
                    {LABELS.openProfile}
                  </button>
                  {canManage && (
                    <button className="text-button" aria-label={`Edit ${s.studentName}`} onClick={() => onEdit(s)}>
                      Edit
                    </button>
                  )}
                  <small className="muted block">
                    {LABELS.activitiesRecorded}: {s.activitiesRecorded}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {students && !students.length && <EmptyState>No students match these filters.</EmptyState>}
      <Pager page={page} total={total} size={PAGE_SIZE} onPage={onPage} />
    </section>
  );
}

// ─── Edit one student ──────────────────────────────────────────────────────────────────────────

export interface RosterEditDraft { displayName: string; status: "active" | "dropped"; excluded: boolean; reason: string; consent: "keep" | "yes" | "no" | "clear"; note: string }

export function editDraftFor(entry: RosterEntry): RosterEditDraft {
  return { displayName: entry.displayName, status: entry.status, excluded: entry.excluded, reason: entry.exclusionReason, consent: "keep", note: "" };
}

/** PATCH body with only the changed fields; null when nothing changed. */
export function rosterPatch(entry: RosterEntry, draft: RosterEditDraft): Parameters<typeof api.updateRosterEntry>[2] | null {
  const body: Parameters<typeof api.updateRosterEntry>[2] = {};
  if (draft.displayName.trim() !== entry.displayName) body.displayName = draft.displayName.trim();
  if (draft.status !== entry.status) body.status = draft.status;
  if (draft.excluded !== entry.excluded || (draft.excluded && draft.reason.trim() !== entry.exclusionReason))
    body.excluded = { value: draft.excluded, reason: draft.excluded ? draft.reason.trim() : "" };
  if (draft.consent !== "keep") body.consentOverride = { value: draft.consent === "clear" ? null : draft.consent, note: draft.note.trim() };
  return Object.keys(body).length ? body : null;
}

export function RosterEditForm({ entry, draft, setDraft }: { entry: RosterEntry; draft: RosterEditDraft; setDraft: (d: RosterEditDraft) => void }) {
  return (
    <div className="editor-fields people-edit">
      <label className="work-label">
        Display name (shown instead of the Kiwi email)
        <input value={draft.displayName} maxLength={100} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
      </label>
      <label className="work-label">
        Status
        <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as RosterEditDraft["status"] })}>
          <option value="active">Active</option>
          <option value="dropped">Dropped</option>
        </select>
      </label>
      <label className="checkbox-label">
        <input type="checkbox" checked={draft.excluded} onChange={(e) => setDraft({ ...draft, excluded: e.target.checked })} />
        {LABELS.excludeFromAnalytics} (staff or test account)
      </label>
      {draft.excluded && (
        <label className="work-label">
          Reason
          <input value={draft.reason} maxLength={200} placeholder="Test account" onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
        </label>
      )}
      <label className="work-label">
        {LABELS.researchConsent} (now: {consentLabel(entry.consent)}
        {consentSourceLabel(entry) ? `, ${consentSourceLabel(entry)}` : ""})
        <select value={draft.consent} onChange={(e) => setDraft({ ...draft, consent: e.target.value as RosterEditDraft["consent"] })}>
          <option value="keep">Keep as is</option>
          <option value="yes">Record Yes (teacher record)</option>
          <option value="no">Record No (teacher record)</option>
          <option value="clear">Clear teacher record (use Kiwi)</option>
        </select>
      </label>
      {draft.consent !== "keep" && (
        <label className="work-label">
          Note (required, e.g. "Paper consent form 10/20")
          <input value={draft.note} maxLength={500} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        </label>
      )}
    </div>
  );
}

/**
 * Student demo link (RV6-m11): standalone (demo) courses have no Kiwi sign-in, so an instructor creates a link that
 * signs this student in (POST /teacher/demo-links). The student error "Ask your teacher for a new link" points here.
 */
export interface DemoLinkState { url: string; expiresAt: string }
export function demoLinkUrl(path: string, origin: string): string {
  return path.startsWith("/") ? `${origin}${path}` : path;
}
export function DemoLinkView({ studentName, link, busy, error, copied, onCreate, onCopy }: {
  studentName: string; link: DemoLinkState | null; busy: boolean; error: string; copied: boolean; onCreate: () => void; onCopy: () => void;
}) {
  return (
    <div className="people-demo-link">
      <strong>Student demo link</strong>
      <p className="muted">This course is not linked to Kiwi. A demo link signs {studentName} in to the student workspace without a password; share it only with this student.</p>
      {link ? (
        <>
          <label className="work-label">
            Link (expires {new Date(link.expiresAt).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: displayTimeZone() })})
            <input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <div className="work-actions">
            <button type="button" className="outline-button" onClick={onCopy}>{copied ? "Copied" : "Copy link"}</button>
            <button type="button" className="text-button" disabled={busy} onClick={onCreate}>Create a new link</button>
          </div>
        </>
      ) : (
        <button type="button" className="outline-button" disabled={busy} onClick={onCreate}>Create demo link</button>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}

// ─── Import ────────────────────────────────────────────────────────────────────────────────────

export function importActionTone(action: RosterImportResult["rows"][number]["action"]): BadgeTone {
  return action === "add" ? "success" : action === "update" ? "info" : action === "error" ? "danger" : "neutral";
}
export function diffText(diff: Record<string, [unknown, unknown]>): string {
  return Object.entries(diff)
    .map(([field, [before, after]]) => `${field}: ${before === null || before === undefined || before === "" ? "—" : String(before)} → ${String(after)}`)
    .join("; ");
}

export function RosterImportView({
  text, parsed, mapping, matchBy, result, busy, error, onText, onMapping, onMatchBy, onPreview, onApply,
}: {
  text: string;
  parsed: ParsedRoster | null;
  mapping: RosterMapping;
  matchBy: "studentId" | "email";
  result: RosterImportResult | null;
  busy: boolean;
  error: string;
  onText: (value: string) => void;
  onMapping: (field: RosterField, index: number | null) => void;
  onMatchBy: (value: "studentId" | "email") => void;
  onPreview: () => void;
  onApply: () => void;
}) {
  const problem = parsed ? mappingProblem(mapping, matchBy) : "";
  const canApply = result?.mode === "preview" && result.rows.some((r) => r.action === "add" || r.action === "update");
  return (
    <details className="roster-import panel work-panel">
      <summary>
        <Upload size={15} /> Import or update students (CSV)
      </summary>
      <p className="muted">
        Paste or choose a CSV with a header row (Student ID, Name, Email, Section, Condition; quotes allowed). Match by email to attach names to Kiwi
        accounts without asking Kiwi for names. Nothing changes until you apply the preview.
      </p>
      <textarea aria-label="Roster CSV" rows={5} value={text} onChange={(e) => onText(e.target.value)} placeholder={"Student ID,Name,Email,Section\ns-001,Ada Chen,ada@example.edu,Section 1"} />
      <div className="work-actions">
        <label className="outline-button file-picker">
          Choose CSV / TSV
          <input
            type="file"
            accept=".csv,.tsv,.txt"
            aria-label="Choose roster file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then(onText);
            }}
          />
        </label>
        <fieldset className="radio-row">
          <legend>Match students by</legend>
          <label className="radio-label">
            <input type="radio" name="matchBy" checked={matchBy === "studentId"} onChange={() => onMatchBy("studentId")} /> Student ID
          </label>
          <label className="radio-label">
            <input type="radio" name="matchBy" checked={matchBy === "email"} onChange={() => onMatchBy("email")} /> Email (Kiwi accounts)
          </label>
        </fieldset>
      </div>
      {parsed && parsed.header.length > 0 && (
        <div className="mapping-grid" role="group" aria-label="Column mapping">
          {ROSTER_FIELDS.map(({ field, label }) => (
            <label key={field} className="work-label">
              {label}
              <select aria-label={`Column for ${label}`} value={mapping[field] ?? ""} onChange={(e) => onMapping(field, e.target.value === "" ? null : Number(e.target.value))}>
                <option value="">(not in file)</option>
                {parsed.header.map((h, i) => (
                  <option key={`${h}-${i}`} value={i}>
                    {h || `Column ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <p className="muted">
            {parsed.rows.length} rows{parsed.hasHeader ? " (header row detected)" : " (no header: first column = ID, second = name)"}; other columns are ignored.
          </p>
        </div>
      )}
      {problem && <p className="error-text">{problem}</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="work-actions">
        <button className="outline-button" disabled={busy || !parsed?.rows.length || Boolean(problem)} onClick={onPreview}>
          Preview changes
        </button>
        <button className="primary-button" disabled={busy || !canApply} onClick={onApply}>
          Apply import
        </button>
      </div>
      {result && (
        <div className="table-scroll">
          <p className="work-message" role="status">
            {result.mode === "apply" ? `${result.applied} students added or updated.` : "Preview — nothing has been saved yet."}
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Row</th>
                <th>Student ID</th>
                <th>Action</th>
                <th>Changes</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.index}>
                  <td>{r.index + 1}</td>
                  <td className="mono">{r.studentId ?? "—"}</td>
                  <td>
                    <StatusBadge tone={importActionTone(r.action)}>{r.action}</StatusBadge>
                  </td>
                  <td>{r.action === "error" ? r.message : diffText(r.diff) || r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

// ─── Container ─────────────────────────────────────────────────────────────────────────────────

const EMPTY_MAPPING: RosterMapping = { studentId: null, name: null, email: null, section: null, condition: null };

export function RosterPage({ route }: TeacherPageProps) {
  const { classId, me, nameMode } = useTeacher();
  const canManage = me.permissions.includes("manageStudents");
  const initial = useMemo(() => new URL(route, "http://lab.local").searchParams, [route]);
  const [filters, setFilters] = useState<RosterFilters>({
    search: initial.get("search") ?? "",
    groupId: initial.get("groupId") ?? "",
    consent: (initial.get("consent") as RosterFilters["consent"]) ?? "",
    status: (initial.get("status") as RosterFilters["status"]) ?? "",
  });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ students: RosterEntry[]; total: number } | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<RosterEntry | null>(null);
  const [draft, setDraft] = useState<RosterEditDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [mapping, setMapping] = useState<RosterMapping>(EMPTY_MAPPING);
  const [matchBy, setMatchBy] = useState<"studentId" | "email">("studentId");
  const [importResult, setImportResult] = useState<RosterImportResult | null>(null);
  const [importError, setImportError] = useState("");
  const [demoLink, setDemoLink] = useState<DemoLinkState | null>(null);
  const [demoError, setDemoError] = useState("");
  const [demoCopied, setDemoCopied] = useState(false);
  const canDemoLink = canManage && me.role === "instructor" && !me.classLinked;
  const parsed = useMemo(() => (text.trim() ? parseRosterFile(text) : null), [text]);
  useEffect(() => setMapping(parsed?.mapping ?? EMPTY_MAPPING), [parsed]);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      api
        .roster(classId, { search: filters.search, groupId: filters.groupId, consent: filters.consent, status: filters.status, page: String(page), pageSize: String(PAGE_SIZE) })
        .then((r) => {
          if (!active) return;
          setData({ students: r.students, total: r.total });
          setError("");
        })
        .catch((e: unknown) => {
          if (active) setError(e instanceof Error ? e.message : String(e));
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [classId, filters, page, revision, nameMode]);
  useEffect(() => {
    api.groups(classId).then(setGroups).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [classId, revision]);

  const saveEdit = useCallback(async () => {
    if (!editing || !draft) return;
    const body = rosterPatch(editing, draft);
    if (!body) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.updateRosterEntry(classId, editing.studentId, body);
      setMessage(`Saved ${editing.studentName}.`);
      setEditing(null);
      setRevision((r) => r + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [classId, editing, draft]);

  const createDemoLink = async () => {
    if (!editing) return;
    setBusy(true);
    setDemoError("");
    setDemoCopied(false);
    try {
      const created = await api.demoLink(classId, editing.studentId);
      setDemoLink({ url: demoLinkUrl(created.url, location.origin), expiresAt: created.expiresAt });
    } catch (e) {
      setDemoError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const copyDemoLink = async () => {
    if (!demoLink) return;
    try {
      await navigator.clipboard.writeText(demoLink.url);
      setDemoCopied(true);
    } catch {
      setDemoError("Copying is blocked in this browser; select the link and copy it.");
    }
  };

  const runImport = async (mode: "preview" | "apply") => {
    if (!parsed) return;
    setBusy(true);
    setImportError("");
    try {
      const rows = toImportRows(parsed.rows, mapping);
      const result = await api.importRoster(classId, { rows, mode, matchBy });
      setImportResult(result);
      if (mode === "apply") {
        setRevision((r) => r + 1);
        setMessage(`${result.applied} students added or updated. Existing work and grades are preserved.`);
      }
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createCohort = async () => {
    const name = `Selected students · ${new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", timeZone: displayTimeZone() })}`;
    setBusy(true);
    try {
      const group = await api.createGroup(classId, { name, kind: "cohort", description: "Created from the roster", studentIds: [...selected] });
      setMessage(`Created ${group.name} with ${group.members} students.`);
      setSelected(new Set());
      setRevision((r) => r + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Roster"
        count={data?.total}
        tabs={<SectionTabs section="students" />}
        actions={
          <button className="outline-button" onClick={() => navigate(teacherPaths.groups())}>
            <UserRound size={15} /> Groups
          </button>
        }
      />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="work-message" role="status">
          {message}
        </p>
      )}
      {canManage && (
        <MultiSelectBar
          count={selected.size}
          noun="student"
          onClear={() => setSelected(new Set())}
          actions={[
            { label: LABELS.createGroupFromSelected, onClick: () => void createCohort(), disabled: busy },
            {
              label: LABELS.assignWorkToSelected,
              disabled: busy,
              onClick: () =>
                void api
                  .createGroup(classId, { name: `Assigned work · ${Date.now().toString(36)}`, kind: "cohort", description: "Created from the roster", studentIds: [...selected] })
                  .then((g) => navigate(teacherPaths.assignmentNew({ audienceGroupId: g.id })))
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))),
            },
          ]}
        />
      )}
      <RosterView
        students={data?.students ?? null}
        total={data?.total ?? 0}
        page={page}
        filters={filters}
        groups={groups}
        canManage={canManage}
        selected={selected}
        hideIds={nameMode === "pseudonyms"}
        onFilter={(f) => {
          setFilters(f);
          setPage(1);
        }}
        onPage={setPage}
        onEdit={(entry) => {
          setEditing(entry);
          setDraft(editDraftFor(entry));
          setDemoLink(null);
          setDemoError("");
          setDemoCopied(false);
        }}
        onToggle={(id) => setSelected((s) => toggleSelected(s, id))}
        onToggleAll={(on) => setSelected((s) => setAllSelected(s, data?.students.map((x) => x.studentId) ?? [], on))}
      />
      {canManage && (
        <RosterImportView
          text={text}
          parsed={parsed}
          mapping={mapping}
          matchBy={matchBy}
          result={importResult}
          busy={busy}
          error={importError}
          onText={(value) => {
            setText(value);
            setImportResult(null);
          }}
          onMapping={(field, index) => {
            setMapping((m) => ({ ...m, [field]: index }));
            setImportResult(null);
          }}
          onMatchBy={(value) => {
            setMatchBy(value);
            setImportResult(null);
          }}
          onPreview={() => void runImport("preview")}
          onApply={() => void runImport("apply")}
        />
      )}
      <ConfirmDialog
        open={Boolean(editing && draft)}
        title={editing ? `Edit ${editing.studentName}` : "Edit student"}
        confirmLabel="Save"
        busy={busy}
        onConfirm={() => void saveEdit()}
        onCancel={() => setEditing(null)}
      >
        {editing && draft && <RosterEditForm entry={editing} draft={draft} setDraft={setDraft} />}
        {editing && canDemoLink && (
          <DemoLinkView studentName={editing.studentName} link={demoLink} busy={busy} error={demoError} copied={demoCopied}
            onCreate={() => void createDemoLink()} onCopy={() => void copyDemoLink()} />
        )}
      </ConfirmDialog>
    </>
  );
}
