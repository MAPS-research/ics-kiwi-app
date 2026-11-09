import { useEffect, useState } from "react";
import { ExportMenu } from "../../components/ExportMenu";
import { Pager } from "../../components/Pager";
import { ResponseText } from "../../components/ResponseText";
import { StatusBadge, type BadgeTone } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { LABELS, pluralize } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { AiCallPanel } from "./AiCallPanel";
import { provenanceDetail } from "./timelineModel";
import type { CodebookCode, ConversationThread, Permission, ThreadSummary } from "../../types";

/*
 * AI conversations › Coding mode [DA03, AU-T-07, TH07, TH08, DA11] (§13.5): thread list with filters, the full thread
 * with per-turn provenance, guard status and flag source, "Show original reply" / "Show instructions sent", Clear flag,
 * Kiwi thumbs/flag feedback, codes from the course codebook and "Next uncoded thread".
 */

const GUARD_TONES: Readonly<Record<string, BadgeTone>> = { clean: "success", retried_clean: "info", redacted: "warning", blocked: "danger", not_applicable: "neutral" };
const GUARD_TEXT: Readonly<Record<string, string>> = {
  clean: "Guard: clean", retried_clean: "Guard: retried, clean", redacted: "Guard: final answer redacted", blocked: "Guard: blocked", not_applicable: "",
};
export function guardText(status: string): string {
  return GUARD_TEXT[status] ?? `Guard: ${status.replace(/_/g, " ")}`;
}
/** Kiwi thumbs (value > 0 up, < 0 down) and flag replies on native turns [DA11]. */
export function feedbackText(f: { value: number | null; reply: string | null }): string {
  const thumb = f.value === null ? "" : f.value > 0 ? "Thumbs up" : f.value < 0 ? "Thumbs down" : "Neutral";
  return [thumb, f.reply ? `Flag: “${f.reply}”` : ""].filter(Boolean).join(" · ");
}

export function ThreadList({ threads, current, onOpen }: { threads: readonly ThreadSummary[]; current: string; onOpen: (key: string) => void }) {
  if (!threads.length) return <p className="muted">No conversations match these filters.</p>;
  return (
    <ul className="thread-list">
      {threads.map((t) => (
        <li key={t.threadKey}>
          <button type="button" className={`thread-item${t.threadKey === current ? " selected" : ""}`} aria-current={t.threadKey === current ? "true" : undefined} onClick={() => onOpen(t.threadKey)}>
            <strong>{t.studentName}</strong>
            <span className="muted">
              {t.where === "kiwi" ? LABELS.kiwiLectureAi : LABELS.labAiTutor} · {pluralize(t.turns, "turn")} · {formatDateTime(t.lastAt)}
            </span>
            {t.assignmentLabel && <span className="muted">{t.assignmentLabel}</span>}
            <span className="thread-badges">
              {t.flagged && <StatusBadge tone="danger">Flagged</StatusBadge>}
              {t.codes.map((c) => (
                <StatusBadge key={c} tone="info">
                  {c}
                </StatusBadge>
              ))}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface ThreadViewProps {
  classId: string;
  thread: ConversationThread;
  codebook: readonly CodebookCode[];
  permissions: readonly Permission[];
  onAddCode: (codeId: string, target: { chatTurnId?: number; nativeEventId?: number }) => void;
  onRemoveCode: (id: number) => void;
  onClearFlag: (chatTurnId: number) => void;
}

export function ThreadView({ classId, thread, codebook, permissions, onAddCode, onRemoveCode, onClearFlag }: ThreadViewProps) {
  const active = codebook.filter((c) => !c.archived);
  const label = (id: string) => codebook.find((c) => c.id === id)?.label ?? id;
  const canFlag = permissions.includes("flagItems");
  const s = thread.summary;
  return (
    <article className="thread-view" aria-label={`Conversation with ${s.studentName}`}>
      <header className="row-between">
        <div>
          <h2>{s.studentName}</h2>
          <p className="muted">
            {s.where === "kiwi" ? LABELS.kiwiLectureAi : LABELS.labAiTutor} · {s.assignmentLabel || "No assignment"} · {pluralize(s.turns, "turn")}
          </p>
        </div>
        <div className="work-actions">
          <ExportMenu classId={classId} items={[{ label: "This thread (CSV)", path: "ai-conversations.csv", query: { threadKey: s.threadKey } }]} />
          {/* INTEGRATION wiring (§18 step 2: AI conversations → profile/timeline); no profile for a researcher (D3). */}
          {permissions.includes("viewStudents") && (
            <a
              className="text-button"
              href={teacherPaths.studentProfile(s.studentId)}
              onClick={(e) => {
                e.preventDefault();
                navigate(teacherPaths.studentProfile(s.studentId));
              }}
            >
              {LABELS.openProfile}
            </a>
          )}
          <a
            className="text-button"
            href={teacherPaths.studentTimeline(s.studentId)}
            onClick={(e) => {
              e.preventDefault();
              navigate(teacherPaths.studentTimeline(s.studentId));
            }}
          >
            {LABELS.fullActivityTimeline}
          </a>
        </div>
      </header>
      <ol className="thread-turns">
        {thread.turns.map((t) => {
          const key = t.chatTurnId ? `t${t.chatTurnId}` : `n${t.nativeEventId}`;
          return (
            <li key={key} className="thread-turn">
              <p className="thread-turn-meta muted">
                {formatDateTime(t.at)} · {provenanceDetail(t.provenance)}
                {t.legacyClientRecord && (
                  <>
                    {" "}
                    <StatusBadge tone="neutral">Legacy client record</StatusBadge>
                  </>
                )}
              </p>
              <p className="thread-prompt">
                <strong>Student:</strong> {t.prompt}
              </p>
              <div className="thread-response">
                <ResponseText text={t.response || "(no reply recorded)"} />
              </div>
              <div className="thread-turn-status">
                {guardText(t.guard) && <StatusBadge tone={GUARD_TONES[t.guard] ?? "neutral"}>{guardText(t.guard)}</StatusBadge>}
                {t.flagged && (
                  <StatusBadge tone="danger">
                    Flagged{t.flagSource ? ` by ${t.flagSource === "guard" ? "the guard" : "staff"}` : ""}
                  </StatusBadge>
                )}
                {t.flagged && canFlag && t.chatTurnId && (
                  <button type="button" className="text-button" onClick={() => onClearFlag(t.chatTurnId as number)}>
                    {LABELS.clearFlag}
                  </button>
                )}
                {t.flagUpdatedBy && <span className="muted">Last flag change: {t.flagUpdatedBy}</span>}
              </div>
              {t.feedback.length > 0 && (
                <ul className="native-feedback" aria-label="Kiwi feedback">
                  {t.feedback.map((f, i) => (
                    <li key={i}>
                      {feedbackText(f)} <span className="muted">{formatDateTime(f.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {t.aiCallId !== null && <AiCallPanel classId={classId} aiCallId={t.aiCallId} />}
              <div className="turn-codes">
                {t.codes.map((c) => (
                  <span key={c.id} className="code-chip">
                    {label(c.codeId)}
                    <button type="button" className="icon-button" aria-label={`Remove code ${label(c.codeId)}`} onClick={() => onRemoveCode(c.id)}>
                      ✕
                    </button>
                  </span>
                ))}
                {active.length > 0 && (
                  <select
                    aria-label={`Add a code to the turn at ${formatDateTime(t.at)}`}
                    value=""
                    onChange={(e) => {
                      if (e.target.value) onAddCode(e.target.value, t.chatTurnId ? { chatTurnId: t.chatTurnId } : { nativeEventId: t.nativeEventId ?? undefined });
                    }}
                  >
                    <option value="">+ Code</option>
                    {active.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </article>
  );
}

export function CodebookPanel({ codebook, onCreate, onArchive }: { codebook: readonly CodebookCode[]; onCreate: (c: { label: string; description: string; color: CodebookCode["color"] }) => void; onArchive: (c: CodebookCode) => void }) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<CodebookCode["color"]>("neutral");
  return (
    <details className="codebook-panel">
      <summary>Codebook ({codebook.filter((c) => !c.archived).length})</summary>
      <ul>
        {codebook.map((c) => (
          <li key={c.id} className={c.archived ? "muted" : undefined}>
            <StatusBadge tone={c.color}>{c.label}</StatusBadge>
            {/* SB-m14: the description and the Archive button no longer run into the label */}
            {c.description && <span className="codebook-description"> — {c.description}</span>}
            {!c.archived && (
              <button type="button" className="text-button codebook-archive" onClick={() => onArchive(c)} aria-label={`Archive code ${c.label}`}>
                Archive
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="codebook-form">
        <input aria-label="New code label" placeholder="Code label" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
        <input aria-label="New code description" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <select aria-label="New code color" value={color} onChange={(e) => setColor(e.target.value as CodebookCode["color"])}>
          {(["neutral", "info", "success", "warning", "danger"] as const).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="outline-button"
          disabled={!label.trim()}
          onClick={() => {
            onCreate({ label: label.trim(), description, color });
            setLabel("");
            setDescription("");
          }}
        >
          Add code
        </button>
      </div>
    </details>
  );
}

export interface CodingFilters { [key: string]: string }

/** Container: thread list + thread detail; reloads only on explicit actions (no 30 s reset [AU-D4-18]). */
export function CodingMode({ classId, filters, current, permissions, onOpen }: { classId: string; filters: CodingFilters; current: string; permissions: readonly Permission[]; onOpen: (key: string) => void }) {
  const [threads, setThreads] = useState<{ threads: ThreadSummary[]; total: number; page: number; pageSize: number } | null>(null);
  const [thread, setThread] = useState<ConversationThread | null>(null);
  const [codebook, setCodebook] = useState<CodebookCode[]>([]);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const key = JSON.stringify(filters);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  useEffect(() => {
    let active = true;
    api
      .conversationThreads(classId, { ...(JSON.parse(key) as CodingFilters), page: String(page) })
      .then((t) => active && setThreads(t))
      .catch((e) => active && fail(e));
    return () => {
      active = false;
    };
  }, [classId, key, page, revision]);
  useEffect(() => {
    let active = true;
    api.codebook(classId).then((c) => active && setCodebook(c)).catch((e) => active && fail(e));
    return () => {
      active = false;
    };
  }, [classId, revision]);
  useEffect(() => {
    if (!current) {
      setThread(null);
      return;
    }
    let active = true;
    api
      .conversationThread(classId, current)
      .then((t) => active && setThread(t))
      .catch((e) => active && fail(e));
    return () => {
      active = false;
    };
  }, [classId, current, revision]);
  const refresh = () => setRevision((r) => r + 1);
  const next = () =>
    api
      .nextUncodedThread(classId, { ...filters, current })
      .then((r) => (r.threadKey ? onOpen(r.threadKey) : setError("Every thread in this view has a code.")))
      .catch(fail);
  return (
    <div className="coding-mode">
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="coding-columns">
        <aside className="panel coding-list" aria-label="Conversation threads">
          <div className="row-between">
            <strong>{threads ? pluralize(threads.total, "thread") : "Loading…"}</strong>
            <button type="button" className="outline-button" onClick={() => void next()}>
              Next uncoded thread
            </button>
          </div>
          {threads && <ThreadList threads={threads.threads} current={current} onOpen={onOpen} />}
          {threads && threads.total > threads.pageSize && <Pager page={threads.page} total={threads.total} size={threads.pageSize} onPage={setPage} />}
          <CodebookPanel
            codebook={codebook}
            onCreate={(c) => api.createCode(classId, c).then(refresh).catch(fail)}
            onArchive={(c) => api.updateCode(classId, c.id, { archived: true }).then(refresh).catch(fail)}
          />
        </aside>
        <section className="panel coding-thread">
          {thread ? (
            <ThreadView
              classId={classId}
              thread={thread}
              codebook={codebook}
              permissions={permissions}
              onAddCode={(codeId, target) => api.addConversationCode(classId, { threadKey: thread.summary.threadKey, codeId, ...target }).then(refresh).catch(fail)}
              onRemoveCode={(id) => api.removeConversationCode(classId, id).then(refresh).catch(fail)}
              onClearFlag={(chatTurnId) => api.unflagTurn(classId, chatTurnId, "Reviewed in AI conversations: not a final answer").then(refresh).catch(fail)}
            />
          ) : (
            <p className="muted">Choose a thread to read it in full.</p>
          )}
        </section>
      </div>
    </div>
  );
}
