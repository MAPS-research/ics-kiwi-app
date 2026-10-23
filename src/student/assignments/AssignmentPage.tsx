import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Timer } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useHostChatPolicy } from "../../lib/kiwi";
import { assignmentKindLabel, LABELS, pluralize, STUDENT_LABELS } from "../../lib/labels";
import { getBrowserSession, navigate, studentHref } from "../../lib/navigation";
import { studentPaths, type StudentTool } from "../../lib/routes";
import { setTelemetryContext } from "../../lib/telemetry";
import { KiwiChat } from "../tools/KiwiChat";
import { RWorkbench } from "../tools/RWorkbench";
import { AnswerPanel, formatStudentDate, penaltyText, SubmissionHistory } from "./AnswerPanel";
import { SimilarPanel } from "./SimilarPanel";
import { TimeLimitBar } from "./TimeLimitBar";
import { createDraftSync, draftNotice, mergeDrafts, pruneStale, readLocalDraft, savedLabel, writeLocalDraft, type DraftSync, type LocalDraft } from "./draftSync";
import type { StudentPageProps } from "../StudentApp";
import type {
  Course,
  FileMeta,
  HostChatPolicy,
  InClassCheckResult,
  RunResultView,
  StudentAssignment,
  StudentSubmission,
  ToolPolicy,
  Tracker,
  WorkQuestion,
} from "../../types";

/*
 * Student assignment page (ASSESS) — /student/assignments/:assignmentId/:tool (answer | code | kiwi | similar), `?q=<id>`.
 * Header: due / past due / closed, attempts, timed homework (Start attempt → Time left). Tabs follow the assignment's
 * tool policy [F02, NM42]; answers save to the server (drafts) with a local fallback [DA07]; released grades show
 * per-question comments [NM16]; the Kiwi host chat gets the graded-homework note or is hidden [AU-D2-11].
 */

export const GRADED_HOMEWORK_NOTE = "Graded homework — do not give final answers or complete solution code.";
export const NOT_AVAILABLE = "Not available for this assignment";
export const TOOL_LABELS: Readonly<Record<StudentTool, string>> = {
  answer: "Answer & submit", code: "R workspace", kiwi: "Ask Kiwi", similar: STUDENT_LABELS.trySimilarQuestion,
};
const TOOL_ORDER: readonly StudentTool[] = ["answer", "code", "kiwi", "similar"];

/** Host chat policy for the assignment (null until the server sends a tool policy). */
export function hostPolicyFor(work: Pick<StudentAssignment, "kind" | "title" | "toolPolicy"> | null): HostChatPolicy | null {
  if (!work?.toolPolicy) return null;
  const available = work.toolPolicy.askKiwi !== "off";
  if (work.kind === "homework") return { available, contextNote: GRADED_HOMEWORK_NOTE };
  return { available, contextNote: `In-class exercise: ${work.title}. Lab AI tutor help level: ${work.toolPolicy.askKiwi.replace(/_/g, " ")}.` };
}

/** Tabs rendered for the tool policy [F02, AU-D1-03]. */
export function allowedTools(policy: ToolPolicy): StudentTool[] {
  return TOOL_ORDER.filter((tool) => tool === "answer" || (tool === "code" && policy.rWorkspace) || (tool === "kiwi" && policy.askKiwi !== "off")
    || (tool === "similar" && policy.similarPractice));
}

/** Run is disabled for Predict output questions unless the teacher allows it (`allowRunPredict`) [F02]. */
export function runAllowed(question: Pick<WorkQuestion, "type">, policy: ToolPolicy): boolean {
  return question.type !== "predict" || policy.allowRunPredict;
}

export { formatStudentDate };

/** S-M01: a revision of homework the student already submitted (the original keeps its grade). */
export function originalNote(title: string): string {
  return `You submitted the original version (${title}). Its grade stays there.`;
}

/** R-m01: the line before the link to the published revision that replaces this assignment ("" without one). */
export function revisionNote(work: Pick<StudentAssignment, "state" | "revisedAs">): string {
  if (!work.revisedAs) return "";
  return work.state === "closed" || work.state === "archived"
    ? "This homework was closed when its new version was published:"
    : "A new version of this homework is available:";
}

/** Header lines under the title: "Due Fri 10/24, 11:59 PM" → "Past due" + late rule, or "Closed — …" [F01]. */
export function dueLines(work: Pick<StudentAssignment, "state" | "dueAt" | "latePolicy" | "closeAt">, timeZone?: string): { headline: string; detail: string | null } {
  const due = work.dueAt ? formatStudentDate(work.dueAt, timeZone) : "";
  // B-m03: a closed homework says so in the header (never "Past due" with a late window)
  if (work.state === "closed") return { headline: due ? `Closed · was due ${due}` : "Closed", detail: "Closed — submissions are no longer accepted." };
  if (work.state === "past_due") {
    const late = work.latePolicy;
    // RV6-M01/M09: the late window and the penalty are stated before the student submits
    const penalty = penaltyText(late.penaltyPctPerDay);
    const marked = penalty ? `(marked late; ${penalty})` : "(marked late)";
    const detail = late.mode === "accept_until" && late.untilAt
      ? `Late submissions accepted until ${formatStudentDate(late.untilAt, timeZone)} ${marked}.`
      : `Late submissions accepted ${marked}.`;
    return { headline: "Past due", detail };
  }
  if (work.state === "draft") return { headline: due ? `Due ${due}` : "Draft (preview)", detail: "Draft — only you can see it in Preview as student." };
  return { headline: due ? `Due ${due}` : "No due date", detail: work.closeAt ? `Closes ${formatStudentDate(work.closeAt, timeZone)}.` : null };
}

/**
 * eventId of an in-class check (review 2, CORRECTNESS-07): a click that repeats a check whose response was lost (same
 * question, same answer) reuses its eventId, so the server returns the stored result instead of using another attempt.
 */
export interface PendingCheck { questionId: string; answer: string; eventId: string }
export function checkEventId(pending: PendingCheck | null, questionId: string, answer: string, make: () => string): string {
  return pending && pending.questionId === questionId && pending.answer === answer ? pending.eventId : make();
}

/** Network failures and gateway errors may hide a check the server recorded; a 4xx answer means it was not recorded. */
export function responseMayBeLost(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
}

/** "Attempt 2 of 3" (homework); none once the homework is closed (B-m03: no next attempt exists). */
export function attemptLabel(work: Pick<StudentAssignment, "kind" | "maxAttempts" | "state">, myAttempts: number): string {
  if (work.kind !== "homework" || work.state === "closed" || work.state === "archived") return "";
  if (work.maxAttempts !== null && myAttempts >= work.maxAttempts) return `All ${pluralize(work.maxAttempts, "attempt")} used`;
  return work.maxAttempts !== null ? `Attempt ${myAttempts + 1} of ${work.maxAttempts}` : `Attempt ${myAttempts + 1}`;
}

/** Why answering is blocked ("" when it is not). */
export function blockedReason(work: Pick<StudentAssignment, "state" | "kind" | "maxAttempts" | "timeLimit" | "currentAttempt">, myAttempts: number): string {
  if (work.state === "closed" || work.state === "archived") return "Closed — submissions are no longer accepted.";
  if (work.state === "scheduled") return LABELS.opensLater;
  if (work.kind === "homework" && work.maxAttempts !== null && myAttempts >= work.maxAttempts) return "You have used every attempt.";
  if (work.kind === "homework" && work.timeLimit && !work.currentAttempt) return "Start the attempt to answer.";
  return "";
}

/** B-m03: 409 answers that mean "this page is out of date" — the submit is refused, the draft is kept. */
export const SUBMIT_REFUSED_CODES: ReadonlySet<string> = new Set(["assignment_closed", "late_not_accepted", "not_open_yet", "max_attempts_reached"]);
export const DRAFT_KEPT = "Your answers are still saved as a draft.";

/** The alert shown next to Submit for a refused submission ("" for any other error, which keeps the page's error line). */
export function submitRefusal(error: unknown): string {
  if (!(error instanceof ApiError) || error.status !== 409 || !SUBMIT_REFUSED_CODES.has(error.code)) return "";
  return `${error.message.trim()} ${DRAFT_KEPT}`;
}

/**
 * B-m03: the assignment's state from a fresh `GET /api/work/:id`, merged into the page without touching its questions or
 * version (an edited homework keeps the draft-merge path of a full load).
 */
export function withFreshState(work: StudentAssignment, fresh: StudentAssignment): StudentAssignment {
  if (fresh.id !== work.id) return work;
  return { ...work, state: fresh.state, dueAt: fresh.dueAt, closeAt: fresh.closeAt, latePolicy: fresh.latePolicy, maxAttempts: fresh.maxAttempts,
    currentAttempt: fresh.currentAttempt, revisedAs: fresh.revisedAs, submittedOriginal: fresh.submittedOriginal };
}

/** Calls `recheck` when the student comes back to the tab (window focus, page visible), at most once per `minIntervalMs`. */
export function onReturnToPage(win: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  doc: Pick<EventTarget, "addEventListener" | "removeEventListener"> & { visibilityState: DocumentVisibilityState },
  recheck: () => void, minIntervalMs: number, now: () => number = Date.now): () => void {
  let last = Number.NEGATIVE_INFINITY;
  const handler = () => {
    if (doc.visibilityState === "hidden") return;
    const at = now();
    if (at - last < minIntervalMs) return;
    last = at;
    recheck();
  };
  win.addEventListener("focus", handler);
  doc.addEventListener("visibilitychange", handler);
  return () => {
    win.removeEventListener("focus", handler);
    doc.removeEventListener("visibilitychange", handler);
  };
}
export const RECHECK_INTERVAL_MS = 15_000;

export function timeLimitIntro(minutes: number): string {
  return `This homework has a ${minutes}-minute time limit. The timer starts when you click ${LABELS.startAttempt}.`;
}

export interface AssignmentPageViewProps {
  work: StudentAssignment;
  course: Course;
  tool: StudentTool;
  question: WorkQuestion;
  answers: Record<string, string>;
  feedback: InClassCheckResult | null;
  hints: string[];
  submissions: StudentSubmission[];
  busy: boolean;
  notice: string;
  savedText: string;
  /** B-m03: why the server refused the last submit (shown as an alert next to Submit; Submit stays disabled) */
  refusal?: string;
  toolContent?: ReactNode;
  onOpen: (tool: StudentTool, questionId?: string) => void;
  onAnswer: (value: string) => void;
  onCheck: () => void;
  onSubmit: () => void;
  onStart: () => void;
  onExpire: () => void;
  onDownload: (file: FileMeta) => void;
}

const REFUSED_BLOCK = "Submitting is not possible on this page any more.";

/** R-m01: "This homework was closed when its new version was published: <link>" (nothing without a revision). */
function RevisionLink({ work }: { work: Pick<StudentAssignment, "state" | "revisedAs"> }) {
  const target = work.revisedAs;
  if (!target) return null;
  return (
    <>
      {revisionNote(work)}{" "}
      <a href={studentHref(studentPaths.assignment(target.id))}
        onClick={(e) => {
          e.preventDefault();
          navigate(studentPaths.assignment(target.id));
        }}>
        {target.title}
      </a>
    </>
  );
}

export function AssignmentPageView(props: AssignmentPageViewProps) {
  const { work, course, tool, question, answers, busy } = props;
  useHostChatPolicy(hostPolicyFor(work));
  const tools = allowedTools(work.toolPolicy);
  const homework = work.kind === "homework";
  const myAttempts = homework ? props.submissions.length : 0;
  const lines = dueLines(work);
  const attempts = attemptLabel(work, myAttempts);
  // B-m03: a refused submit disables Submit even before the refreshed state arrives
  const blocked = blockedReason(work, myAttempts) || (props.refusal ? REFUSED_BLOCK : "");
  const waitingForStart = homework && Boolean(work.timeLimit) && !work.currentAttempt;
  const answered = work.questions.filter((q) => answers[q.id]?.trim()).length;
  const chapter = course.units.find((u) => u.id === work.unitId)?.title || "Chapter";
  return (
    <>
      <div className="assess-student-head">
        <p className="muted">{chapter} · {assignmentKindLabel(work.kind)} · {pluralize(work.questions.length, "question")}</p>
        <p className="assess-due">
          <strong>{lines.headline}</strong>
          {attempts && <span> · {attempts}</span>}
        </p>
        {lines.detail && <p className="muted">{lines.detail}</p>}
        {homework && work.submittedOriginal && !myAttempts && (
          <p className="assess-original-note">{originalNote(work.submittedOriginal.title)}</p>
        )}
        {work.revisedAs && (
          <p className="assess-original-note">
            <RevisionLink work={work} />
          </p>
        )}
      </div>
      {props.notice && <p className="assess-notice" role="status">{props.notice}</p>}
      {work.currentAttempt && <TimeLimitBar endsAt={work.currentAttempt.endsAt} onExpire={props.onExpire} />}
      {waitingForStart && work.timeLimit ? (
        <section className="panel work-panel">
          <p><Timer size={16} aria-hidden="true" /> {timeLimitIntro(work.timeLimit.minutes)}</p>
          <div className="work-actions">
            <button type="button" className="primary-button" disabled={busy || Boolean(blocked && blocked !== "Start the attempt to answer.")} onClick={props.onStart}>
              {LABELS.startAttempt}
            </button>
            {blocked && blocked !== "Start the attempt to answer." && <span className="muted">{blocked}</span>}
          </div>
          <div className="submission-status">
            <h3>Submissions &amp; feedback</h3>
            <SubmissionHistory submissions={props.submissions} questions={work.questions} penaltyPctPerDay={work.latePolicy.penaltyPctPerDay} />
          </div>
        </section>
      ) : (
        <>
          <div className="question-context">
            <label>
              Question
              <select aria-label="Assignment question" value={question.id} disabled={busy} onChange={(e) => props.onOpen(tool, e.target.value)}>
                {work.questions.map((q, i) => (
                  <option key={q.id} value={q.id}>Question {i + 1} · {q.prompt.slice(0, 85)}</option>
                ))}
              </select>
            </label>
            <span>{answered} of {work.questions.length} answered</span>
          </div>
          {tools.length > 1 && (
            <nav className="page-tabs" aria-label="Assignment pages">
              {tools.map((id) => (
                <a href={studentHref(studentPaths.assignment(work.id, id, question.id))} key={id} aria-current={tool === id ? "page" : undefined}
                  onClick={(e) => { e.preventDefault(); props.onOpen(id, question.id); }}>
                  {TOOL_LABELS[id]}
                </a>
              ))}
            </nav>
          )}
          {tool === "answer" ? (
            <AnswerPanel work={work} question={question} answers={answers} feedback={props.feedback} hints={props.hints} answered={answered} busy={busy}
              submissions={props.submissions} savedLabel={props.savedText} submitBlocked={blocked} onAnswer={props.onAnswer} onCheck={props.onCheck}
              onSubmit={props.onSubmit} onOpenQuestion={(qid) => props.onOpen("answer", qid)} onDownload={props.onDownload}
              refusal={props.refusal} refusalLink={props.refusal && work.revisedAs ? <RevisionLink work={work} /> : null} />
          ) : !tools.includes(tool) ? (
            <section className="panel work-panel empty-state">
              <p>{NOT_AVAILABLE}</p>
              <button type="button" className="outline-button" onClick={() => props.onOpen("answer", question.id)}>{TOOL_LABELS.answer}</button>
            </section>
          ) : (
            props.toolContent ?? null
          )}
        </>
      )}
    </>
  );
}

const SUBMIT_KEY = (classId: string, studentId: string, workId: string) => `kiwi-pending-submit-${classId}-${studentId}-${workId}`;

function downloadBase64(name: string, type: string, data: string): void {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const link = document.createElement("a");
  const href = URL.createObjectURL(new Blob([bytes], { type }));
  link.href = href;
  link.download = name;
  link.click();
  URL.revokeObjectURL(href);
}

export function AssignmentPage({ classId, course, studentId, studentName, track, params, route }: StudentPageProps) {
  const workId = params.assignmentId || "";
  const tool = (TOOL_ORDER.includes(params.tool as StudentTool) ? params.tool : "answer") as StudentTool;
  const query = new URL(route, "http://lab.local").searchParams;
  const [work, setWork] = useState<StudentAssignment | null>(null);
  const [submissions, setSubmissions] = useState<StudentSubmission[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [hints, setHints] = useState<Record<string, string[]>>({});
  const [feedback, setFeedback] = useState<InClassCheckResult | null>(null);
  const [notice, setNotice] = useState("");
  const [save, setSave] = useState<{ savedAt: number | null; pending: number; failing: boolean }>({ savedAt: null, pending: 0, failing: false });
  const [code, setCode] = useState("");
  const [run, setRun] = useState<(RunResultView & { code: string }) | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refusal, setRefusal] = useState("");   // B-m03
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const mounted = useRef(true);
  const sync = useRef<DraftSync | null>(null);
  const local = useRef<LocalDraft>({});
  const viewedFeedback = useRef(new Set<string>());
  const pendingCheck = useRef<PendingCheck | null>(null);
  const current = work?.id === workId ? work : null;
  const question = current?.questions.find((q) => q.id === query.get("q")) || current?.questions[0];
  const localKey = `kiwi-work-${classId}-${studentId}-${workId}`;
  const codeKey = `kiwi-code-${classId}-${studentId}-${workId}-${question?.id}`;

  const taskTrack: Tracker = useCallback(
    (type, payload, qid) => track(type, { ...payload, assignmentId: workId, unitId: current?.unitId }, qid),
    [track, workId, current?.unitId],
  );

  const load = useCallback(async () => {
    const [detail, mine, draft] = await Promise.all([
      api.workDetail(classId, workId),
      api.mySubmissions(classId, studentId, workId).catch(() => [] as StudentSubmission[]),
      api.getDraft(classId, workId, studentId).catch(() => null),
    ]);
    if (!mounted.current) return;
    const ids = detail.questions.map((q) => q.id);
    local.current = readLocalDraft(localKey);
    const merged = mergeDrafts(draft, local.current);
    const pruned = pruneStale(merged.answers, ids);
    setWork(detail);
    setSubmissions(mine);
    setAnswers(pruned.answers);
    setHints(Object.fromEntries(detail.questions.map((q) => [q.id, q.hints ?? []])));
    setNotice(draftNotice(draft?.assignmentVersion ?? null, detail.version, pruned.removed, detail.state));
    sync.current?.dispose();
    sync.current = createDraftSync({
      save: (values, clientTs) => api.saveDraft(classId, workId, { studentId, answers: values, clientTs, assignmentVersion: detail.version }),
      onSaved: (_, at) => mounted.current && setSave({ savedAt: at, pending: sync.current ? Object.keys(sync.current.pending()).length : 0, failing: false }),
      onError: () => mounted.current && setSave((s) => ({ ...s, failing: true })),
      onPending: (pending) => mounted.current && setSave((s) => ({ ...s, pending })),
    });
    for (const qid of merged.unsynced) if (ids.includes(qid)) sync.current.update(qid, pruned.answers[qid] ?? "");
  }, [classId, workId, studentId, localKey]);

  useEffect(() => {
    mounted.current = true;
    load().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setLoaded(true));
    const flush = () => void sync.current?.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", flush);
      const pending = sync.current; // WHY: capture — a reload creates a new sync before this flush settles
      sync.current = null;
      void pending?.flush().finally(() => pending.dispose());
    };
  }, [load]);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(codeKey);
    } catch {
      stored = null; // WHY: blocked storage falls back to the starter code
    }
    setCode(stored ?? question?.starterCode ?? "");
    setRun(null);
    setFeedback(null);
  }, [codeKey, question?.starterCode]);
  useEffect(() => {
    if (!current || !question) return;
    setTelemetryContext({ surface: "assignment", unitId: current.unitId, assignmentId: current.id, questionId: question.id, tool });
    void track("question_viewed", { unitId: current.unitId, assignmentId: current.id, questionTitle: question.prompt }, question.id);
    return () => setTelemetryContext(null);
    // WHY: one view event per question; tool changes only update the telemetry context below.
  }, [current?.id, question?.id]);
  useEffect(() => {
    if (current && question) setTelemetryContext({ surface: "assignment", unitId: current.unitId, assignmentId: current.id, questionId: question.id, tool });
  }, [tool]);
  useEffect(() => {
    if (tool !== "answer") return;
    for (const s of submissions) {
      if (s.status !== "released" || viewedFeedback.current.has(s.id)) continue;
      viewedFeedback.current.add(s.id);
      void taskTrack("feedback_viewed", { submissionId: s.id });
    }
  }, [submissions, tool, taskTrack]);

  const open = (page: StudentTool = "answer", qid?: string) => navigate(studentPaths.assignment(workId, page, qid));
  const setAnswer = (value: string) => {
    if (!question) return;
    setAnswers((a) => ({ ...a, [question.id]: value }));
    local.current = { ...local.current, [question.id]: { value, ts: Date.now() } };
    if (!writeLocalDraft(localKey, local.current) && !sync.current) setError("This browser could not save your answer; keep a copy before leaving the page.");
    sync.current?.update(question.id, value);
    setFeedback(null);
  };
  const check = async () => {
    if (!current || !question || busy) return;
    setBusy(true);
    setError("");
    const asked = question.id;
    try {
      const answer = answers[question.id] || "";
      const output = run?.ok && run.code === code && answer === code ? run.stdout || run.output : undefined;
      // WHY: `studentName` keeps a v0.5.1 server's event writer working; v0.6 servers take names from the session.
      const eventId = checkEventId(pendingCheck.current, question.id, answer, () => `check-${crypto.randomUUID()}`);
      pendingCheck.current = { questionId: question.id, answer, eventId };
      const body = { studentId, studentName, sessionId: getBrowserSession(), questionId: question.id, answer, eventId, ...(output !== undefined ? { runOutput: output } : {}) };
      const result = await api.checkInClass(classId, current.id, body);
      pendingCheck.current = null;
      if (!mounted.current || question.id !== asked) return;
      setFeedback(result);
      const hint = result.nextHint;
      if (hint) setHints((h) => ({ ...h, [asked]: [...(h[asked] ?? []), hint] }));
      if (result.correct && result.explanation) void taskTrack("explanation_shown", { questionId: asked, context: "in-class check" }, asked);
    } catch (e) {
      if (!responseMayBeLost(e)) pendingCheck.current = null;   // the server answered: a new click is a new attempt
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const refreshAfterSubmit = async () => {
    const [detail, mine] = await Promise.all([api.workDetail(classId, workId), api.mySubmissions(classId, studentId, workId)]);
    if (!mounted.current) return;
    setWork(detail);
    setSubmissions(mine);
  };
  /** B-m03: the assignment's state and my attempts, without reloading questions or drafts. */
  const refreshState = useCallback(async () => {
    const [detail, mine] = await Promise.all([api.workDetail(classId, workId), api.mySubmissions(classId, studentId, workId)]);
    if (!mounted.current) return;
    setWork((w) => (w ? withFreshState(w, detail) : w));
    setSubmissions(mine);
    // a teacher who reopened the homework makes Submit available again
    if (!blockedReason(detail, mine.length)) setRefusal("");
  }, [classId, workId, studentId]);
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    return onReturnToPage(window, document, () => {
      // WHY: a failed background re-check leaves the page as it was; the next submit reports its own error
      refreshState().catch(() => undefined);
    }, RECHECK_INTERVAL_MS);
  }, [refreshState]);
  const submit = async (auto = false) => {
    if (!current || busy) return;
    setBusy(true);
    setError("");
    try {
      await sync.current?.flush();
      const ids = current.questions.map((q) => q.id);
      const values = pruneStale(answers, ids).answers;
      const pendingKey = SUBMIT_KEY(classId, studentId, current.id);
      const snapshot = JSON.stringify(values);
      type Pending = { snapshot: string; requestId: string };
      let pending: Pending | null = null;
      try {
        pending = JSON.parse(sessionStorage.getItem(pendingKey) || "null") as Pending | null;
      } catch {
        pending = null; // a broken entry starts a new request
      }
      if (!pending || pending.snapshot !== snapshot) pending = { snapshot, requestId: `submit-${crypto.randomUUID()}` };
      try {
        sessionStorage.setItem(pendingKey, JSON.stringify(pending));
      } catch {
        // WHY: without sessionStorage a retry just gets a new requestId; the server still numbers attempts transactionally
      }
      const body = { studentId, studentName, sessionId: getBrowserSession(), answers: values, requestId: pending.requestId, ...(auto ? { autoSubmit: true } : {}) };
      const result = await api.submitWork(classId, current.id, body);
      try {
        sessionStorage.removeItem(pendingKey);
      } catch {
        // ignore: see above
      }
      if (mounted.current) {
        const late = result.late ? " (marked late)" : "";
        const over = result.overTime ? " (over the time limit)" : "";
        setMessage(`${auto ? "Time is up — your answers were submitted" : "Submission received"}: attempt ${result.attempt}${late}${over}. ${STUDENT_LABELS.waitingForTeacher}.`);
      }
      await refreshAfterSubmit().catch(() => mounted.current && setError("Your submission was received. Reload the page to update the list."));
    } catch (e) {
      const refused = submitRefusal(e);
      if (refused) {
        // B-m03: the page was out of date — say so next to Submit, keep the draft, and show the current state
        if (mounted.current) setRefusal(refused);
        await refreshState().catch(() => mounted.current && setError("Reload the page to see this assignment's current state."));
      } else if (e instanceof ApiError && e.code === "incomplete_submission") setError("Answer every question before submitting.");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const start = async () => {
    if (!current || busy) return;
    setBusy(true);
    setError("");
    setMessage("");   // S-m07: "Time is up — …" belongs to the previous attempt
    try {
      const attempt = await api.startAttempt(classId, current.id, studentId);
      if (mounted.current) setWork((w) => (w ? { ...w, currentAttempt: attempt } : w));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const download = async (file: FileMeta) => {
    try {
      const data = await api.workFile(classId, workId, file.id);
      downloadBase64(data.name, data.type, data.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const unitRuntime = useMemo(() => course.units.find((u) => u.id === current?.unitId)?.runtime, [course.units, current?.unitId]);
  let toolContent: ReactNode = null;
  if (current && question && tool === "code") {
    toolContent = (
      <>
        <p className="context-caption">{question.prompt}</p>
        <RWorkbench key={question.id} code={code} onCode={(v) => { setCode(v); setRun(null); }} onResult={setRun}
          track={(type, payload, qid) => taskTrack(type, { ...payload, questionTitle: question.prompt }, qid)} questionId={question.id} storageKey={codeKey}
          context={{ unitId: current.unitId, surface: "assignment", assignmentId: current.id, envKey: `assignment:${current.id}:${question.id}` }}
          runtime={unitRuntime} files={current.files.filter((f) => f.mountInR)}
          allowRun={runAllowed(question, current.toolPolicy)} />
        <div className="work-actions">
          <button type="button" className="primary-button" onClick={() => {
            setAnswer(code);
            void taskTrack("work_answer_saved", { length: code.length }, question.id);
            open("answer", question.id);
          }}>
            Use code as answer <ArrowRight size={16} />
          </button>
        </div>
      </>
    );
  } else if (current && question && tool === "kiwi") {
    toolContent = (
      <KiwiChat key={question.id} classId={classId} studentId={studentId} unitId={current.unitId} surface="assignment" assignmentId={current.id}
        questionId={question.id} question={question.prompt} code={code} track={taskTrack}
        lastRun={run ? { ok: run.ok, output: run.output, error: run.error } : null} answerDraft={answers[question.id] || ""} />
    );
  } else if (current && question && tool === "similar") {
    toolContent = (
      <SimilarPanel key={question.id} classId={classId} studentId={studentId} unitId={current.unitId} assignmentId={current.id} question={question}
        track={taskTrack} disabledReason={current.toolPolicy.similarPractice ? undefined : NOT_AVAILABLE} />
    );
  }
  return (
    <div className="student-content">
      <div className="page-intro">
        <div>
          <h1>{current ? current.title : "Your assigned work"}</h1>
        </div>
        <button type="button" className="text-button" onClick={() => navigate(studentPaths.assignments())}>
          <ArrowLeft size={16} /> All assigned work
        </button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {message && <p className="work-message" role="status">{message}</p>}
      {current && question ? (
        <AssignmentPageView work={current} course={course} tool={tool} question={question} answers={answers} feedback={feedback}
          hints={hints[question.id] ?? []} submissions={submissions} busy={busy} notice={notice} savedText={savedLabel(save)} toolContent={toolContent}
          refusal={refusal}
          onOpen={open} onAnswer={setAnswer} onCheck={() => void check()} onSubmit={() => void submit()} onStart={() => void start()}
          onExpire={() => void submit(true)} onDownload={(file) => void download(file)} />
      ) : (
        <section className="panel work-panel empty-state">{loaded ? "This assignment is unavailable. Return to your assigned work." : "Loading assignment…"}</section>
      )}
    </div>
  );
}
