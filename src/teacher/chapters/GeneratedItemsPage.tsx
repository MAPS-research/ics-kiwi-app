import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { FilterChips, type FilterChip } from "../../components/FilterChips";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { Pager } from "../../components/Pager";
import { ResponseText } from "../../components/ResponseText";
import { StatusBadge, type BadgeTone } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { formatShortDate } from "../../lib/format";
import { LABELS, questionTypeLabel } from "../../lib/labels";
import { hasPermission, useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { AiCallDetail, AiQuestionType, GeneratedItemTeacher, Unit, WorkOption } from "../../types";

/*
 * AI-generated practice review (/teacher/chapters/ai-practice) [F12, DA06, AU-D1-16]. Every generated exercise with its
 * full stem, code, choices (display order), answer key, explanation, provenance (Lab AI tutor · rules version · model ·
 * date), verification result, homework match and attempts. Folded by origin, chapter/assignment question and type.
 * Actions: Flag as wrong / Clear flag (instructor, TA), Retire / Restore (instructor), Show AI call.
 */

export type ItemRow = GeneratedItemTeacher & { flaggedBy?: string | null; isPreview?: boolean };

export interface ReviewFilters {
  origin: "" | "free" | "similar";
  unitId: string;
  status: "" | "active" | "flagged" | "retired" | "rejected";
  verification: "" | "mismatch" | "verified" | "unverified";
  studentId: string;
  from: string;
  to: string;
}
export const EMPTY_FILTERS: ReviewFilters = { origin: "", unitId: "", status: "", verification: "", studentId: "", from: "", to: "" };
export const PAGE_SIZE = 50;

export function filtersFromSearch(search: string): ReviewFilters {
  const q = new URLSearchParams(search);
  const pick = <T extends string>(key: string, allowed: readonly T[]): T | "" => {
    const value = q.get(key) || "";
    return (allowed as readonly string[]).includes(value) ? (value as T) : "";
  };
  return {
    origin: pick("origin", ["free", "similar"] as const),
    unitId: q.get("unitId") || "",
    status: pick("status", ["active", "flagged", "retired", "rejected"] as const),
    verification: pick("verification", ["mismatch", "verified", "unverified"] as const),
    studentId: q.get("studentId") || "",
    from: q.get("from") || "",
    to: q.get("to") || "",
  };
}

export function filterQuery(filters: ReviewFilters, page: number): Record<string, string> {
  const out: Record<string, string> = { page: String(page), pageSize: String(PAGE_SIZE) };
  for (const [key, value] of Object.entries(filters)) if (value) out[key] = value;
  return out;
}

export function chapterLabel(units: readonly Pick<Unit, "id">[], unitId: string): string {
  const index = units.findIndex((u) => u.id === unitId);
  return index >= 0 ? `Ch ${String(index + 1).padStart(2, "0")}` : unitId || "No chapter";
}

export const VERIFICATION_LABELS: Readonly<Record<string, string>> = {
  mismatch: "Failed automatic check",
  verified: "Passed automatic check",
  unverified: "Not yet checked",
  not_applicable: "",
};
export const STATUS_BADGES: Readonly<Record<string, { label: string; tone: BadgeTone }>> = {
  active: { label: "Shown to student", tone: "success" },
  flagged: { label: "Flagged as wrong", tone: "warning" },
  retired: { label: "Retired", tone: "neutral" },
  rejected_invalid: { label: "Rejected · invalid", tone: "danger" },
  rejected_leak: { label: "Rejected · revealed homework answer", tone: "danger" },
  rejected_not_novel: { label: "Rejected · not new", tone: "danger" },
};

/** "Lab AI tutor · Ch 03 rules v4 · gpt-5.4-mini · 10/21" (§12.9); local items name their source instead. */
export function provenanceLine(item: Pick<ItemRow, "source" | "policyLabel" | "model" | "createdAt">, timeZone?: string): string {
  const date = formatShortDate(item.createdAt, timeZone);
  if (item.source === "ai") return [LABELS.labAiTutor, item.policyLabel, item.model || "model not recorded", date].join(" · ");
  const source = item.source === "teacher_bank" ? "Teacher exercise bank (no AI)" : "Local template (no AI)";
  return [source, item.policyLabel, date].join(" · ");
}

export interface ItemGroup { key: string; label: string; items: ItemRow[] }

/** `Free practice · Ch 03 · Multiple choice (12)` / `Similar practice · HW3 · q2 · Predict output (4)`. */
export function foldItems(items: readonly ItemRow[], units: readonly Pick<Unit, "id">[], titles: Readonly<Record<string, string>>): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();
  for (const item of items) {
    const similar = item.origin === "similar";
    const where = similar
      ? `${titles[item.relatedAssignmentId] || item.relatedAssignmentId || "Assignment"} · ${item.relatedQuestionId || "question"}`
      : chapterLabel(units, item.unitId);
    // SB-m13: local templates (no AI key) are grouped apart and never called "(AI)"
    const local = item.source !== "ai";
    const origin = local
      ? (similar ? "Similar practice (local template, no AI)" : item.origin === "free" ? "Free practice (local template, no AI)" : "Rule test (staff)")
      : similar ? LABELS.similarPracticeAi : item.origin === "free" ? LABELS.freePracticeAi : "Rule test (staff)";
    const key = `${item.origin}|${local ? "local" : "ai"}|${similar ? `${item.relatedAssignmentId}|${item.relatedQuestionId}` : item.unitId}|${item.questionType}`;
    const group = groups.get(key) ?? { key, label: `${origin} · ${where} · ${questionTypeLabel(item.questionType as AiQuestionType)}`, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => ({ ...g, label: `${g.label} (${g.items.length})` }));
}

export function filterChips(filters: ReviewFilters, units: readonly Pick<Unit, "id">[], onRemove: (key: keyof ReviewFilters) => void): FilterChip[] {
  const labels: Record<keyof ReviewFilters, string> = {
    origin: "Origin", unitId: "Chapter", status: "Status", verification: "Check", studentId: "Student", from: "From", to: "To",
  };
  const display = (key: keyof ReviewFilters, value: string): string => {
    if (key === "origin") return value === "free" ? LABELS.freePracticeAi : LABELS.similarPracticeAi;
    if (key === "unitId") return chapterLabel(units, value);
    if (key === "verification") return VERIFICATION_LABELS[value] || value;
    if (key === "status") return value === "rejected" ? "Rejected drafts" : STATUS_BADGES[value]?.label ?? value;
    return value;
  };
  return (Object.keys(labels) as (keyof ReviewFilters)[])
    .filter((key) => filters[key])
    .map((key) => ({ key, label: labels[key], value: display(key, filters[key]), onRemove: () => onRemove(key) }));
}

export type ItemAction = "flag" | "unflag" | "retire" | "restore" | "call";

/** Inline "Flag as wrong" note (no blocking dialogs). */
export interface FlagDraft { itemId: string; note: string }

export function ItemCard({ item, canFlag, canRetire, busy, onAction, timeZone, flagDraft, onFlagNote, onConfirmFlag, onCancelFlag }: {
  item: ItemRow; canFlag: boolean; canRetire: boolean; busy: boolean; onAction: (item: ItemRow, action: ItemAction) => void; timeZone?: string;
  flagDraft?: FlagDraft | null; onFlagNote?: (note: string) => void; onConfirmFlag?: () => void; onCancelFlag?: () => void;
}) {
  const drafting = flagDraft?.itemId === item.id;
  const badge = STATUS_BADGES[item.status] ?? { label: item.status, tone: "neutral" as BadgeTone };
  const verification = VERIFICATION_LABELS[item.verification] ?? item.verification;
  const rejected = item.status.startsWith("rejected");
  const answerText = item.item.answer || item.item.expectedOutput || "";
  return (
    <article className="airun-item-card" aria-label={`${item.item.title} for ${item.studentName}`}>
      <header className="airun-item-head">
        <strong>{item.item.title || "Untitled exercise"}</strong>
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        {item.verification === "mismatch" && <StatusBadge tone="danger">{verification}</StatusBadge>}
        {item.homeworkMatch && <StatusBadge tone="info">Homework match {Math.round((item.homeworkMatch.containment ?? 0) * 100)}%</StatusBadge>}
      </header>
      <p className="airun-provenance">{provenanceLine(item, timeZone)}</p>
      <p className="airun-meta">
        {item.studentName} · {questionTypeLabel(item.questionType as AiQuestionType)} · difficulty {item.difficulty}
        {item.requestedType !== item.questionType || item.requestedDifficulty !== item.difficulty ? ` (asked for ${questionTypeLabel(item.requestedType as AiQuestionType)} ${item.requestedDifficulty})` : ""}
        {` · ${item.attempts} ${item.attempts === 1 ? "attempt" : "attempts"}, ${item.correctAttempts} correct`}
        {item.noveltyRetries ? ` · regenerated ${item.noveltyRetries}×` : ""}
      </p>
      {item.focusNote && <p className="airun-meta">Focus note: “{item.focusNote}”</p>}
      <ResponseText className="question-prompt" text={item.item.prompt} />
      {item.item.code && <pre className="question-code">{item.item.code}</pre>}
      {item.item.starterCode && <pre className="question-code">{item.item.starterCode}</pre>}
      {item.item.choices && item.item.choices.length > 0 && (
        <ol className="airun-choices" type="A">
          {item.item.choices.map((choice, i) => (
            <li key={i} className={choice === item.item.answer ? "is-answer" : undefined}>
              {choice}
              {choice === item.item.answer && <span className="airun-answer-mark"> ✓ answer</span>}
            </li>
          ))}
        </ol>
      )}
      <dl className="airun-key">
        <dt>Answer</dt>
        <dd>
          <code>{answerText || "—"}</code>
          {item.item.acceptedAnswers && item.item.acceptedAnswers.length > 0 && <span className="muted"> (also accepted: {item.item.acceptedAnswers.join(", ")})</span>}
        </dd>
        {item.item.expectedOutput && item.item.answer && item.item.expectedOutput !== item.item.answer && (
          <>
            <dt>Expected output</dt>
            <dd>
              <code>{item.item.expectedOutput}</code>
            </dd>
          </>
        )}
        <dt>Explanation</dt>
        <dd>{item.item.explanation ? <ResponseText text={item.item.explanation} /> : "—"}</dd>
        {verification && (
          <>
            <dt>Automatic check</dt>
            <dd>
              {verification}
              {item.clientRunOutput && <pre className="airun-run-output">{item.clientRunOutput}</pre>}
            </dd>
          </>
        )}
        {item.flagNote && (
          <>
            <dt>Flag note</dt>
            <dd>{item.flagNote}</dd>
          </>
        )}
      </dl>
      {drafting && (
        <div className="airun-flag-form">
          <label>
            What is wrong with this exercise? (optional)
            <input value={flagDraft?.note ?? ""} maxLength={1000} onChange={(e) => onFlagNote?.(e.target.value)} />
          </label>
          <div className="work-actions">
            <button className="primary-button" disabled={busy} onClick={onConfirmFlag}>
              Save flag
            </button>
            <button className="text-button" onClick={onCancelFlag}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="work-actions">
        {canFlag && !rejected && (item.status === "flagged" ? (
          <button className="outline-button" disabled={busy} onClick={() => onAction(item, "unflag")}>
            Clear flag
          </button>
        ) : (
          <button className="outline-button" disabled={busy || drafting} onClick={() => onAction(item, "flag")}>
            Flag as wrong
          </button>
        ))}
        {canRetire && !rejected && (item.status === "retired" ? (
          <button className="outline-button" disabled={busy} onClick={() => onAction(item, "restore")}>
            Restore
          </button>
        ) : (
          <button className="outline-button" disabled={busy} onClick={() => onAction(item, "retire")}>
            Retire
          </button>
        ))}
        {item.aiCallId !== null && (
          <button className="text-button" disabled={busy} onClick={() => onAction(item, "call")}>
            {item.source === "ai" ? "Show AI call" : "Show request record"}
          </button>
        )}
      </div>
    </article>
  );
}

export function AiCallPanelView({ call, onClose }: { call: AiCallDetail; onClose: () => void }) {
  return (
    <section className="panel airun-call" aria-label="AI call details">
      <div className="row-between">
        <h2>AI call #{call.id}</h2>
        <button className="text-button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="airun-meta">
        {call.status} · {call.policyLabel} · {call.model || "no model"} · {call.platformRulesVersion}
        {call.latencyMs !== null ? ` · ${call.latencyMs} ms` : ""}
        {call.inputTokens !== null ? ` · ${call.inputTokens} in / ${call.outputTokens ?? 0} out tokens` : ""}
      </p>
      <details>
        <summary>Show instructions sent</summary>
        <pre className="airun-pre">{call.developerText || "—"}</pre>
      </details>
      <details>
        <summary>Show original reply (staff only)</summary>
        <pre className="airun-pre">{call.rawOutput || "—"}</pre>
      </details>
      <details>
        <summary>Learning context sent</summary>
        <pre className="airun-pre">{JSON.stringify(call.contextJson, null, 2)}</pre>
      </details>
      {call.guard.matches.length > 0 && (
        <ul className="airun-guard-list">
          {call.guard.matches.map((m, i) => (
            <li key={i}>
              {m.rule}: “{m.excerpt}”
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface GeneratedItemsViewProps {
  groups: ItemGroup[];
  total: number;
  page: number;
  chips: FilterChip[];
  filters: ReviewFilters;
  units: readonly Pick<Unit, "id" | "title">[];
  showFilters: boolean;
  canFlag: boolean;
  canRetire: boolean;
  busy: boolean;
  error: string;
  loading: boolean;
  call: AiCallDetail | null;
  timeZone?: string;
  flagDraft?: FlagDraft | null;
  onFlagNote?: (note: string) => void;
  onConfirmFlag?: () => void;
  onCancelFlag?: () => void;
  onToggleFilters: () => void;
  onFilter: (next: ReviewFilters) => void;
  onPage: (page: number) => void;
  onAction: (item: ItemRow, action: ItemAction) => void;
  onCloseCall: () => void;
}

export function GeneratedItemsView(props: GeneratedItemsViewProps) {
  const { groups, total, page, chips, filters, units, showFilters, canFlag, canRetire, busy, error, loading, call, timeZone } = props;
  const set = (patch: Partial<ReviewFilters>) => props.onFilter({ ...filters, ...patch });
  return (
    <>
      <PageHeader title={LABELS.aiGeneratedPractice} count={loading ? "" : total} tabs={<SectionTabs section="chapters" />} />
      <FilterChips chips={chips} onAdd={props.onToggleFilters} onClearAll={() => props.onFilter(EMPTY_FILTERS)} />
      {showFilters && (
        <div className="airun-filter-panel" role="group" aria-label="Filters">
          <label>
            Origin
            <select value={filters.origin} onChange={(e) => set({ origin: e.target.value as ReviewFilters["origin"] })}>
              <option value="">All</option>
              <option value="free">{LABELS.freePracticeAi}</option>
              <option value="similar">{LABELS.similarPracticeAi}</option>
            </select>
          </label>
          <label>
            Chapter
            <select value={filters.unitId} onChange={(e) => set({ unitId: e.target.value })}>
              <option value="">All chapters</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select value={filters.status} onChange={(e) => set({ status: e.target.value as ReviewFilters["status"] })}>
              <option value="">Shown to students</option>
              <option value="flagged">Flagged as wrong</option>
              <option value="retired">Retired</option>
              <option value="rejected">Rejected drafts</option>
            </select>
          </label>
          <label>
            Automatic check
            <select value={filters.verification} onChange={(e) => set({ verification: e.target.value as ReviewFilters["verification"] })}>
              <option value="">Any</option>
              <option value="mismatch">Failed automatic check</option>
              <option value="verified">Passed automatic check</option>
              <option value="unverified">Not yet checked</option>
            </select>
          </label>
          <label>
            Student id
            <input value={filters.studentId} onChange={(e) => set({ studentId: e.target.value.trim() })} placeholder="demo-ada" />
          </label>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {call && <AiCallPanelView call={call} onClose={props.onCloseCall} />}
      {!loading && groups.length === 0 ? (
        <section className="panel work-panel">
          <EmptyState title="No AI-generated practice yet">Exercises students generate in Practice exercises or Try a similar question appear here with their answer keys.</EmptyState>
        </section>
      ) : (
        groups.map((group) => (
          <details className="panel airun-group" key={group.key} open>
            <summary>{group.label}</summary>
            {group.items.map((item) => (
              <ItemCard key={item.id} item={item} canFlag={canFlag} canRetire={canRetire} busy={busy} onAction={props.onAction} timeZone={timeZone}
                flagDraft={props.flagDraft} onFlagNote={props.onFlagNote} onConfirmFlag={props.onConfirmFlag} onCancelFlag={props.onCancelFlag} />
            ))}
          </details>
        ))
      )}
      {total > PAGE_SIZE && <Pager page={page} total={total} size={PAGE_SIZE} onPage={props.onPage} />}
    </>
  );
}

export function GeneratedItemsPage({ route }: TeacherPageProps) {
  const { classId, course, me } = useTeacher();
  const [filters, setFilters] = useState<ReviewFilters>(() => filtersFromSearch(route.includes("?") ? route.slice(route.indexOf("?")) : ""));
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [total, setTotal] = useState(0);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [call, setCall] = useState<AiCallDetail | null>(null);
  const [revision, setRevision] = useState(0);
  const [flagDraft, setFlagDraft] = useState<FlagDraft | null>(null);
  const units = course?.units ?? [];
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api
      .generatedItems(classId, filterQuery(filters, page))
      .then((data) => {
        if (!active) return;
        setItems(data.items as ItemRow[]);
        setTotal(data.total);
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
  }, [classId, filters, page, revision]);
  useEffect(() => {
    let active = true;
    api
      .workOptions<WorkOption>(classId)
      .then((options) => {
        if (active) setTitles(Object.fromEntries(options.map((o) => [o.id, o.title])));
      })
      .catch(() => {
        if (active) setTitles({}); // WHY: group labels fall back to assignment ids
      });
    return () => {
      active = false;
    };
  }, [classId]);
  const groups = useMemo(() => foldItems(items, units, titles), [items, units, titles]);
  const changeFilters = (next: ReviewFilters) => {
    setFilters(next);
    setPage(1);
  };
  const act = async (item: ItemRow, action: ItemAction, note = "") => {
    if (action === "flag" && flagDraft?.itemId !== item.id) {
      setFlagDraft({ itemId: item.id, note: "" });
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (action === "call") {
        if (item.aiCallId !== null) setCall(await api.aiCallDetail(classId, item.aiCallId));
        return;
      }
      const fn = { flag: api.flagItem, unflag: api.unflagItem, retire: api.retireItem, restore: api.restoreItem }[action];
      const updated = (await fn(classId, item.id, note)) as ItemRow;
      setItems((rows) => rows.map((r) => (r.id === updated.id ? { ...r, ...updated, attempts: r.attempts, correctAttempts: r.correctAttempts } : r)));
      if (action === "flag") setFlagDraft(null);
      setRevision((n) => (filters.status ? n + 1 : n));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <GeneratedItemsView
      groups={groups}
      total={total}
      page={page}
      chips={filterChips(filters, units, (key) => changeFilters({ ...filters, [key]: "" }))}
      filters={filters}
      units={units}
      showFilters={showFilters}
      canFlag={hasPermission(me, "flagItems")}
      canRetire={hasPermission(me, "manageAiRules")}
      busy={busy}
      error={error}
      loading={loading}
      call={call}
      flagDraft={flagDraft}
      onFlagNote={(note) => setFlagDraft((d) => (d ? { ...d, note } : d))}
      onConfirmFlag={() => {
        const target = items.find((i) => i.id === flagDraft?.itemId);
        if (target && flagDraft) void act(target, "flag", flagDraft.note.trim());
      }}
      onCancelFlag={() => setFlagDraft(null)}
      onToggleFilters={() => setShowFilters((v) => !v)}
      onFilter={changeFilters}
      onPage={setPage}
      onAction={(item, action) => void act(item, action)}
      onCloseCall={() => setCall(null)}
    />
  );
}
