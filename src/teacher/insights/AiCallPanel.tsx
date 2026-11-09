import { useState } from "react";
import { api } from "../../lib/api";
import { LABELS } from "../../lib/labels";
import type { AiCallDetail } from "../../types";

/*
 * "Show original reply (staff only)" / "Show instructions sent" [TH08, DA05] — reads GET /api/teacher/ai/calls/{id}
 * (AIRUN) on demand; nothing is fetched until a teacher asks.
 */

export type AiCallView = "reply" | "instructions";

/** One-line summary of the call (status, policy, model, tokens). */
export function aiCallSummary(detail: AiCallDetail): string {
  const tokens = detail.inputTokens !== null || detail.outputTokens !== null ? ` · ${detail.inputTokens ?? "?"} → ${detail.outputTokens ?? "?"} tokens` : "";
  return `${detail.status} · ${detail.policyLabel || "Default rules"} · ${detail.model || "no model"}${tokens}`;
}

export function AiCallDetailView({ detail, view }: { detail: AiCallDetail; view: AiCallView }) {
  return (
    <div className="ai-call-detail">
      <p className="muted">{aiCallSummary(detail)}</p>
      {view === "reply" ? (
        <>
          <h4>{LABELS.showOriginalReply.replace("Show ", "")}</h4>
          <pre className="ai-call-text">{detail.rawOutput || "(empty)"}</pre>
          {detail.outputTruncated && <p className="muted">The stored reply was truncated.</p>}
          {detail.guard.matches.length > 0 && (
            <ul className="guard-matches">
              {detail.guard.matches.map((m, i) => (
                <li key={i}>
                  {m.rule}: “{m.excerpt}”
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <h4>Instructions sent</h4>
          <pre className="ai-call-text">{detail.developerText || "(not recorded)"}</pre>
        </>
      )}
    </div>
  );
}

export function AiCallPanel({ classId, aiCallId }: { classId: string; aiCallId: number }) {
  const [detail, setDetail] = useState<AiCallDetail | null>(null);
  const [view, setView] = useState<AiCallView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const open = (next: AiCallView) => {
    if (view === next) {
      setView(null);
      return;
    }
    setView(next);
    if (detail || loading) return;
    setLoading(true);
    setError("");
    api
      .aiCallDetail(classId, aiCallId)
      .then(setDetail)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  return (
    <div className="ai-call-panel">
      <button type="button" className="text-button" aria-expanded={view === "reply"} onClick={() => open("reply")}>
        {LABELS.showOriginalReply}
      </button>
      <button type="button" className="text-button" aria-expanded={view === "instructions"} onClick={() => open("instructions")}>
        {LABELS.showInstructionsSent}
      </button>
      {view && loading && <p role="status" className="muted">Loading…</p>}
      {view && error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {view && detail && <AiCallDetailView detail={detail} view={view} />}
    </div>
  );
}
