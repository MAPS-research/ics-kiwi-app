import { useEffect, useRef, useState } from "react";
import { ArrowRight, LoaderCircle, Sparkles } from "lucide-react";
import { ResponseText } from "../../components/ResponseText";
import { api, ApiError } from "../../lib/api";
import {
  AI_TIMEOUT_MS,
  aiErrorMessage,
  chatThreadId,
  guardNotice,
  helpLevelNotice,
  legacyThreadId,
  reportUnreached,
  sourceLabel,
  withTimeout,
  type UnreachedContext,
} from "../../lib/questions";
import { registerAiReply } from "../../lib/telemetry";
import type { AskKiwiMode, ChatRequest, ChatResponse, ChatTurnView, GuardView, KiwiChatProps, Tracker } from "../../types";

/*
 * Ask Kiwi chat (AIRUN; props frozen, §7.9). The server resolves the policy, enforces the assignment help level and
 * chapter access, guards replies against graded answers, logs every request and writes the `ai_question` event — the
 * client only sends the question with its learning context. Requests that never reach the server are reported as
 * `ai_request_unreached` through the telemetry outbox. Without an AI key the server answers with the chapter's local
 * guidance (KEEP label "Local guidance").
 */

export interface ChatTurnRow {
  prompt: string; response: string; createdAt: string; local: boolean; source?: ChatResponse["source"]; guard: GuardView["status"];
  /** RV6-m14: why the course rules refused this question (it stays in the thread instead of disappearing) */
  refused?: string;
}

/** A refusal by the server (4xx, e.g. chapter not open, Ask Kiwi off, daily limit) — not a network failure. */
export function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

export function turnFromView(t: ChatTurnView): ChatTurnRow {
  return { prompt: t.prompt, response: t.response, createdAt: t.createdAt, local: t.source === "local", source: t.source, guard: t.guardStatus ?? "not_applicable" };
}

/** Send one chat request: registers the reply for paste detection, reports unreached requests, rethrows errors. */
export async function sendChat(classId: string, body: ChatRequest, track: Tracker, ctx: Omit<UnreachedContext, "action">): Promise<ChatResponse> {
  try {
    const reply = await withTimeout(api.chat(classId, body), AI_TIMEOUT_MS);
    registerAiReply(reply.response, typeof reply.chatTurnId === "number" ? reply.chatTurnId : null);
    return reply;
  } catch (error) {
    await reportUnreached(track, error, { action: "chat", ...ctx }).catch(() => false);
    throw error;
  }
}

export interface KiwiChatViewProps {
  inputId: string;
  turns: ChatTurnRow[];
  input: string;
  busy: boolean;
  error: string;
  notice: string | null;
  aiAvailable: boolean | null;
  disabled: boolean;
  onInput: (value: string) => void;
  onAsk: () => void;
}

/** SB-m12: students are told what they get, not how the server is configured. */
export const LOCAL_GUIDANCE_NOTE = "Kiwi AI is unavailable in this session. The Lab shows fixed local guidance from your chapter rules; it does not generate an AI answer.";

export function KiwiChatView({ inputId, turns, input, busy, error, notice, aiAvailable, disabled, onInput, onAsk }: KiwiChatViewProps) {
  return (
    <section className="panel work-panel airun-chat">
      <div className="panel-heading">
        <div>
          <h2>Ask Kiwi</h2>
        </div>
        <Sparkles size={20} aria-hidden="true" />
      </div>
      {notice && (
        <p className="airun-notice" role="note">
          {notice}
        </p>
      )}
      <p className="muted">
        {aiAvailable === false
          ? LOCAL_GUIDANCE_NOTE
          : "Kiwi follows your teacher's chapter rules. Ask a follow-up in this thread; graded homework gets hints, not answers."}
      </p>
      {turns.length === 0 && !error && <div className="empty-state">Ask about a concept or explain where your code gets stuck.</div>}
      <div className="chat-turns">
        {turns.map((t, i) => {
          const guard = guardNotice(t.guard);
          return (
            <article className="chat-turn" key={i}>
              <p className="student-message">
                <strong>You</strong> {t.prompt}
              </p>
              {t.refused ? (
                <p className="airun-warning" role="note">Not answered: {t.refused}</p>
              ) : (
                <>
                  <span className="ai-source">{sourceLabel(t.source ?? (t.local ? "local" : "lab-ai"))}</span>
                  {guard && <p className="airun-guard-notice">{guard}</p>}
                  <ResponseText text={t.response} />
                </>
              )}
            </article>
          );
        })}
      </div>
      <label className="field-label" htmlFor={inputId}>
        Your question
      </label>
      {/* RT-04: the composer spans the panel (without a class it kept the browser's default ~20-column width) */}
      <textarea
        id={inputId}
        className="kiwi-chat-input"
        rows={4}
        maxLength={3000}
        value={input}
        disabled={disabled}
        onChange={(e) => onInput(e.target.value)}
        placeholder="Why does mean() return NA, and what should I inspect first?"
      />
      <div className="work-actions">
        <button className="primary-button" disabled={disabled || busy || !input.trim() || aiAvailable === null} onClick={onAsk}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />} {busy ? "Thinking…" : "Ask Kiwi"}
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// `question` (the prompt shown next to the chat) is part of the frozen props; the server loads question context itself.
export function KiwiChat({ classId, studentId, unitId, surface, code, track, assignmentId, questionId, itemId, lastRun, answerDraft }: KiwiChatProps) {
  const scope = { unitId, assignmentId, questionId, itemId };
  const threadId = chatThreadId(surface, scope);
  const oldThread = legacyThreadId(scope);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [turns, setTurns] = useState<ChatTurnRow[]>([]);
  const [aiAvailable, setAvailable] = useState<boolean | null>(null);
  const [askKiwi, setAskKiwi] = useState<AskKiwiMode | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    setTurns([]);
    setError("");
    const histories = Promise.all([
      api.chatHistory(classId, studentId, threadId),
      oldThread !== threadId ? api.chatHistory(classId, studentId, oldThread).catch(() => [] as ChatTurnView[]) : Promise.resolve([] as ChatTurnView[]),
    ]);
    Promise.all([histories, api.policy(classId, unitId)])
      .then(([[current, legacy], policy]) => {
        if (!active) return;
        setTurns([...legacy, ...current].map(turnFromView));
        setAvailable(Boolean(policy.aiAvailable));
      })
      .catch((e: unknown) => {
        if (active) setError(aiErrorMessage(e));
      });
    if (assignmentId) {
      api
        .workDetail(classId, assignmentId)
        .then((work) => {
          if (active) setAskKiwi(work.toolPolicy?.askKiwi ?? null);
        })
        .catch(() => {
          if (active) setAskKiwi(null); // WHY: the notice is informational; the server still enforces the help level
        });
    } else setAskKiwi(null);
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [classId, studentId, unitId, threadId, oldThread, assignmentId]);
  const ask = async () => {
    if (busy || !input.trim() || aiAvailable === null) return;
    const prompt = input.trim();
    setBusy(true);
    setError("");
    const body: ChatRequest = {
      studentId, unitId, threadId, prompt, surface,
      ...(assignmentId ? { assignmentId } : {}), ...(questionId ? { questionId } : {}), ...(itemId ? { itemId } : {}),
      ...(code ? { code: code.slice(0, 12000) } : {}),
      ...(lastRun ? { runOutput: lastRun.output.slice(0, 4000), ...(lastRun.error ? { error: lastRun.error.slice(0, 2000) } : {}) } : {}),
      ...(answerDraft ? { answerDraft: answerDraft.slice(0, 4000) } : {}),
    };
    try {
      const reply = await sendChat(classId, body, track, { surface, unitId, assignmentId, questionId, itemId });
      if (mounted.current) {
        setTurns((t) => [...t, { prompt, response: reply.response, createdAt: new Date().toISOString(), local: reply.source === "local", source: reply.source, guard: reply.guard?.status ?? "not_applicable" }]);
        setInput("");
      }
    } catch (e) {
      if (!mounted.current) return;
      if (isRefusal(e))
        setTurns((t) => [...t, { prompt, response: "", createdAt: new Date().toISOString(), local: false, guard: "not_applicable", refused: aiErrorMessage(e) }]);
      else setError(aiErrorMessage(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <KiwiChatView
      inputId={`kiwi-input-${threadId}`}
      turns={turns}
      input={input}
      busy={busy}
      error={error}
      notice={assignmentId ? helpLevelNotice(askKiwi) : null}
      aiAvailable={aiAvailable}
      disabled={askKiwi === "off"}
      onInput={setInput}
      onAsk={() => void ask()}
    />
  );
}
