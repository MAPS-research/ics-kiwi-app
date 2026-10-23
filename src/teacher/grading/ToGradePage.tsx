import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { FilterChips, type FilterChip } from "../../components/FilterChips";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { Pager } from "../../components/Pager";
import { api, ApiError, type Q } from "../../lib/api";
import { LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { withQuery } from "../../lib/routes";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { GradingQueue, SubmissionDetail, WorkOption, WorkQuestion } from "../../types";
import { applicableMembers, ByQuestionView, groupKey, type GroupValue, type QuestionGroup } from "./ByQuestionView";
import { GradingCardView } from "./GradingCard";
import {
  cardStatus, draftFromDetail, draftToInput, gradingTabCounts, keepUnsavedDrafts, nextUngradedId, pageOf, parseShow, SHOW_OPTIONS, toGradeTitle, type CardDraft,
  type ShowFilter,
} from "./gradingKeys";

/*
 * To grade (n) — grading workbench (GRADE; F04, TH05, NM12, NM13). Query (§3.2):
 * ?assignmentId=&show=latest|all|graded|late|flagged|draft&view=student|question&questionId=&studentId=&submissionId=&groupId=
 * Save & next (button or Ctrl/⌘+Enter) saves and moves to the next ungraded card of the queue order.
 */

const PAGE_SIZE = 10;
type View = "student" | "question";

export interface QueueFiltersProps {
  show: ShowFilter;
  view: View;
  assignmentId: string;
  assignments: readonly { id: string; title: string }[];
  questions: readonly { id: string; prompt: string }[];
  questionId: string;
  search: string;
  chips: readonly FilterChip[];
  onChange: (patch: Partial<{ show: ShowFilter; view: View; assignmentId: string; questionId: string }>) => void;
  onSearch: (value: string) => void;
}

/** Filter row of the queue: Assignment · Show · By student | By question · Question · search (pure view). */
export function QueueFiltersView({ show, view, assignmentId, assignments, questions, questionId, search, chips, onChange, onSearch }: QueueFiltersProps) {
  return (
    <div className="grading-filters">
      <FilterChips chips={chips} />
      <div className="table-toolbar">
        <label>
          Assignment
          <select value={assignmentId} onChange={(e) => onChange({ assignmentId: e.target.value, questionId: "" })}>
            <option value="">All assignments</option>
            {assignments.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Show
          <select value={show} onChange={(e) => onChange({ show: parseShow(e.target.value) })}>
            {SHOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {show === "draft" && <option value="draft">Drafts</option>}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="Grading view">
          <button type="button" className="outline-button" aria-pressed={view === "student"} onClick={() => onChange({ view: "student" })}>
            By student
          </button>
          <button type="button" className="outline-button" aria-pressed={view === "question"} onClick={() => onChange({ view: "question" })}>
            By question
          </button>
        </div>
        {view === "question" && (
          <label>
            Question
            <select value={questionId} onChange={(e) => onChange({ questionId: e.target.value })} disabled={!questions.length}>
              {!questions.length && <option value="">Choose an assignment first</option>}
              {questions.map((q, i) => (
                <option key={q.id} value={q.id}>
                  Q{i + 1} · {q.prompt.slice(0, 60)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Student
          <input type="search" placeholder="Name or ID" value={search} onChange={(e) => onSearch(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

/**
 * Saves one question score on each submission of a group (S-B01). Released grades are never written: they are left out
 * before the call, and one released meanwhile answers 409 `grade_released` (counted as kept, not as a failure).
 */
export async function applyToGroup(ids: readonly string[], save: (id: string) => Promise<unknown>): Promise<{ done: number; kept: number; failures: string[] }> {
  let done = 0;
  let kept = 0;
  const failures: string[] = [];
  for (const id of ids) {
    try {
      await save(id);
      done += 1;
    } catch (e) {
      if (e instanceof ApiError && e.code === "grade_released") kept += 1;
      else failures.push(message(e));
    }
  }
  return { done, kept, failures };
}

/** S-m06: what unreleasing does, named for the student. */
export function unreleaseConfirmText(detail: Pick<SubmissionDetail, "studentLabel" | "submission">): string {
  return `${detail.studentLabel} no longer sees this grade (attempt ${detail.submission.attempt}) until you release it again. The history keeps the release.`;
}

/** "Applied 7 points to 1 of 1 submission. 1 released grade was not changed." */
export function groupApplyStatus(score: number, done: number, total: number, keptReleased: number, failures: readonly string[]): string {
  const parts = [`Applied ${score} ${score === 1 ? "point" : "points"} to ${done} of ${total} ${total === 1 ? "submission" : "submissions"}.`];
  if (keptReleased) parts.push(`${keptReleased === 1 ? "1 released grade was" : `${keptReleased} released grades were`} not changed.`);
  if (failures.length) parts.push(failures[0]);
  return parts.join(" ");
}

function message(e: unknown): string {
  if (e instanceof ApiError && e.code === "stale_version") return "This grade changed since you opened it. The card now shows the latest version.";
  return e instanceof Error ? e.message : String(e);
}

export function ToGradePage({ route }: TeacherPageProps) {
  const { classId, me } = useTeacher();
  const query = new URL(route, "http://lab.local").searchParams;
  const show = parseShow(query.get("show"));
  const view: View = query.get("view") === "question" ? "question" : "student";
  const assignmentId = query.get("assignmentId") || "";
  const questionId = query.get("questionId") || "";
  const studentId = query.get("studentId") || "";
  const submissionId = query.get("submissionId") || "";
  const groupId = query.get("groupId") || "";
  const includePreview = query.get("includePreview") === "1";
  const canRelease = me.permissions.includes("releaseGrades");
  const canUnrelease = me.role === "instructor";

  const [search, setSearch] = useState(query.get("search") || "");
  const [appliedSearch, setAppliedSearch] = useState(search);
  const [page, setPage] = useState(1);
  const [queue, setQueue] = useState<GradingQueue | null>(null);
  const [focused, setFocused] = useState<SubmissionDetail | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CardDraft>>({});
  const [cardState, setCardState] = useState<Record<string, { error?: string; status?: string }>>({});
  const [options, setOptions] = useState<WorkOption[]>([]);
  const [questions, setQuestions] = useState<WorkQuestion[]>([]);
  const [groupValues, setGroupValues] = useState<Record<string, GroupValue>>({});
  const [groupStatus, setGroupStatus] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmUnrelease, setConfirmUnrelease] = useState<SubmissionDetail | null>(null);   // S-m06
  const loadId = useRef(0);
  const baseDrafts = useRef<Record<string, CardDraft>>({});   // SB-M05: the server version each card's draft was built from
  const resetDrafts = useRef(new Set<string>());
  const handled = useRef(new Set<string>());
  const pendingFocus = useRef<string | null>(null);

  const setQuery = useCallback(
    (patch: Record<string, string>) => {
      const next = { assignmentId, show, view, questionId, studentId, groupId, submissionId, includePreview: includePreview ? "1" : "", ...patch };
      setPage(1);
      navigate(withQuery("/teacher/grading", { ...next, view: next.view === "student" ? "" : next.view }), true);
    },
    [assignmentId, show, view, questionId, studentId, groupId, submissionId, includePreview],
  );

  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    api
      .workOptions<WorkOption>(classId)
      .then((list) => active && setOptions(list.filter((w) => w.kind === "homework")))
      .catch((e: unknown) => active && setError(message(e)));
    return () => {
      active = false;
    };
  }, [classId]);

  useEffect(() => {
    if (view !== "question" || !assignmentId) {
      setQuestions([]);
      return;
    }
    let active = true;
    api
      .workDetailLegacy(classId, assignmentId)
      .then((work) => {
        if (!active) return;
        setQuestions(work.questions);
        if (!questionId && work.questions[0]) setQuery({ questionId: work.questions[0].id });
      })
      .catch((e: unknown) => active && setError(message(e)));
    return () => {
      active = false;
    };
  }, [classId, view, assignmentId, questionId, setQuery]);

  const refresh = useCallback(async () => {
    const request = ++loadId.current;
    if (view === "question" && (!assignmentId || !questionId)) {
      setQueue(null);
      return;
    }
    const q: Q = { show, view, page: String(page) };
    for (const [key, value] of Object.entries({ assignmentId, questionId: view === "question" ? questionId : "", studentId, groupId, search: appliedSearch }))
      if (value) q[key] = value;
    if (includePreview) q.includePreview = "1";
    const result = await api.gradingQueue(classId, q);
    const single = submissionId ? await api.submissionDetail(classId, submissionId) : null;
    if (request !== loadId.current) return;
    const target = pendingFocus.current;
    if (target && !result.cards.some((c) => c.submission.id === target)) {
      const p = pageOf(result.order, target, PAGE_SIZE);
      if (p && p !== page) {
        setPage(p);
        return;
      }
    }
    setQueue(result);
    setFocused(single);
    const fresh: Record<string, CardDraft> = {};
    for (const card of [...result.cards, ...(single ? [single] : [])]) fresh[card.submission.id] = draftFromDetail(card);
    const base = baseDrafts.current;
    const reset = resetDrafts.current;
    // SB-M05: saving one card reloads the queue; scores typed into the other cards are kept
    setDrafts((prev) => keepUnsavedDrafts(prev, base, fresh, reset));
    baseDrafts.current = { ...base, ...fresh };
    resetDrafts.current = new Set();
  }, [classId, show, view, page, assignmentId, questionId, studentId, groupId, submissionId, appliedSearch, includePreview]);

  useEffect(() => {
    void refresh().catch((e: unknown) => setError(message(e)));
    return () => {
      loadId.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target || !queue || typeof document === "undefined") return;
    const node = document.querySelector(`[data-card="${target.replace(/["\\]/g, "")}"]`);
    if (!node) return;
    pendingFocus.current = null;
    node.scrollIntoView({ block: "start", behavior: "smooth" });
    node.querySelector<HTMLInputElement>("input, textarea")?.focus({ preventScroll: true });
  }, [queue]);

  const save = async (detail: SubmissionDetail, action: "save" | "release", next: boolean) => {
    const id = detail.submission.id;
    const draft = drafts[id] ?? draftFromDetail(detail);
    setBusy(id);
    setCardState((s) => ({ ...s, [id]: {} }));
    try {
      const saved = await api.saveGrade(classId, id, draftToInput(draft, detail, action));
      handled.current.add(id);
      resetDrafts.current.add(id);
      const state = cardStatus(saved);
      setCardState((s) => ({ ...s, [id]: { status: `${state.label} saved for ${saved.studentLabel}, attempt ${saved.submission.attempt}.` } }));
      if (focused && focused.submission.id === id) setFocused(saved);
      if (next && queue) pendingFocus.current = nextUngradedId(queue.order, id, handled.current);
      await refresh();
    } catch (e) {
      setCardState((s) => ({ ...s, [id]: { error: message(e) } }));
      if (e instanceof ApiError && e.code === "stale_version") {
        resetDrafts.current.add(id);   // "The card now shows the latest version."
        await refresh().catch(() => undefined);
      }
    } finally {
      setBusy("");
    }
  };

  const unrelease = async (detail: SubmissionDetail) => {
    const id = detail.submission.id;
    setBusy(id);
    try {
      await api.unreleaseGrade(classId, id);
      resetDrafts.current.add(id);
      await refresh();
    } catch (e) {
      setCardState((s) => ({ ...s, [id]: { error: message(e) } }));
    } finally {
      setBusy("");
    }
  };

  // S-m05: a status line belongs to the question it was written for
  useEffect(() => {
    setGroupStatus("");
    setGroupValues({});
  }, [assignmentId, questionId]);

  const applyGroup = async (group: QuestionGroup, value: { score: number; comment: string }) => {
    setBusy(groupKey(group));
    setGroupStatus("");
    const targets = applicableMembers(group);
    const { done, kept, failures } = await applyToGroup(targets, (sid) =>
      api.saveGrade(classId, sid, { items: { [questionId]: value }, action: "save", keepReleased: true }));
    setGroupStatus(groupApplyStatus(value.score, done, targets.length, group.submissionIds.length - targets.length + kept, failures));
    setBusy("");
    await refresh().catch((e: unknown) => setError(message(e)));
  };

  const assignmentTitle = options.find((o) => o.id === assignmentId)?.title ?? assignmentId;
  const chips: FilterChip[] = [];
  if (studentId) chips.push({ key: "student", label: "Student", value: queue?.cards[0]?.studentLabel ?? studentId, onRemove: () => setQuery({ studentId: "" }) });
  if (groupId) chips.push({ key: "group", label: "Group", value: groupId, onRemove: () => setQuery({ groupId: "" }) });
  if (submissionId) chips.push({ key: "submission", label: "Showing", value: "one submission", onRemove: () => setQuery({ submissionId: "" }) });
  if (assignmentId) chips.push({ key: "assignment", label: "Assignment", value: assignmentTitle, onRemove: () => setQuery({ assignmentId: "", questionId: "" }) });
  const cards = focused ? [focused] : queue?.cards ?? [];
  const questionIndex = Math.max(questions.findIndex((q) => q.id === questionId), 0) + 1;
  const question = questions.find((q) => q.id === questionId);

  const renderCard = (detail: SubmissionDetail) => {
    const id = detail.submission.id;
    return (
      <div key={id} data-card={id}>
        <GradingCardView
          detail={detail}
          draft={drafts[id] ?? draftFromDetail(detail)}
          canRelease={canRelease}
          canUnrelease={canUnrelease}
          busy={busy === id}
          error={cardState[id]?.error}
          status={cardState[id]?.status}
          onChange={(draft) => setDrafts((d) => ({ ...d, [id]: draft }))}
          onSave={(action, next) => void save(detail, action, next)}
          onUnrelease={() => setConfirmUnrelease(detail)}
        />
      </div>
    );
  };

  return (
    <div className="teacher-work grading-page">
      <PageHeader
        title={toGradeTitle(queue?.counts.toGrade)}
        meta={queue ? `${queue.counts.toRelease} ${LABELS.readyToRelease.toLowerCase()} · ${queue.counts.flagged} flagged` : undefined}
        actions={
          <button type="button" className="outline-button" onClick={() => void refresh().catch((e: unknown) => setError(message(e)))}>
            <RefreshCw size={15} aria-hidden="true" /> Refresh
          </button>
        }
        tabs={<SectionTabs section="grading" counts={gradingTabCounts(queue?.counts.toGrade)} />}
      />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <section className="panel work-panel">
        <QueueFiltersView
          show={show}
          view={view}
          assignmentId={assignmentId}
          assignments={options}
          questions={questions}
          questionId={questionId}
          search={search}
          chips={chips}
          onChange={(patch) => setQuery(patch as Record<string, string>)}
          onSearch={(value) => {
            setSearch(value);
            setPage(1);
          }}
        />
        <label className="grading-preview-toggle">
          <input type="checkbox" checked={includePreview} onChange={(e) => setQuery({ includePreview: e.target.checked ? "1" : "" })} />
          Show preview submissions
        </label>
        {view === "question" ? (
          question ? (
            <ByQuestionView
              question={question}
              questionIndex={questionIndex}
              groups={queue?.groups ?? []}
              values={groupValues}
              busy={Boolean(busy)}
              status={groupStatus}
              onChange={(key, value) => setGroupValues((v) => ({ ...v, [key]: value }))}
              onApply={(group, value) => void applyGroup(group, value)}
            />
          ) : (
            <EmptyState>Choose a homework assignment to grade one question across all students.</EmptyState>
          )
        ) : (
          <>
            {!queue && <p role="status" className="empty-state">Loading submissions…</p>}
            {cards.map(renderCard)}
            {queue && !cards.length && (
              <EmptyState>{show === "latest" ? "Nothing left to grade for these filters." : "No submissions match these filters."}</EmptyState>
            )}
            {!focused && queue && <Pager page={page} total={queue.total} size={PAGE_SIZE} onPage={setPage} />}
          </>
        )}
      </section>
      <ConfirmDialog
        open={confirmUnrelease !== null}
        title="Unrelease this grade?"
        confirmLabel="Unrelease"
        busy={Boolean(busy)}
        onCancel={() => setConfirmUnrelease(null)}
        onConfirm={() => {
          const detail = confirmUnrelease;
          setConfirmUnrelease(null);
          if (detail) void unrelease(detail);
        }}
      >
        {confirmUnrelease ? unreleaseConfirmText(confirmUnrelease) : null}
      </ConfirmDialog>
    </div>
  );
}
