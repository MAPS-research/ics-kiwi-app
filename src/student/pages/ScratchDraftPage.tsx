import { useState } from "react";
import type { KiwiClient } from "../../types";

/** Keep the original key: upgrading must never erase an earlier scratch draft. */
export function readScratchDraft(classId: string, studentId: string): string | null {
  try { return localStorage.getItem(`kiwi-scratch-${classId}-${studentId}`); }
  catch { return null; }
}

/** Recovery for old bookmarks. General code execution now belongs to Kiwi's Scratchpad. */
export function ScratchDraftPage({ classId, studentId, kiwi }: { classId: string; studentId: string; kiwi: KiwiClient | null }) {
  const [draft] = useState(() => readScratchDraft(classId, studentId));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const openScratchpad = async () => {
    setBusy(true);
    setError("");
    try {
      if (!kiwi) throw new Error("Use the Scratchpad tab in Kiwi to continue.");
      const result = await kiwi.navigate({ path: "/code" });
      if (!result.ok) throw new Error(result.error?.message || "Use the Scratchpad tab in Kiwi to continue.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="student-content">
      <div className="page-intro"><div>
        <h1>Earlier R draft</h1>
        <p className="muted">Use Kiwi’s Scratchpad for free experiments. Each Lab question still has its own R editor for answers and submissions.</p>
      </div></div>
      <section className="panel work-panel focused-panel">
        {draft !== null ? <>
          <p>Your earlier draft is preserved here. Copy the code before opening Scratchpad; it does not transfer automatically.</p>
          <label className="work-label">Saved R code<textarea className="answer-input" rows={12} readOnly value={draft} /></label>
        </> : <p>No earlier R draft is saved for this account in this browser.</p>}
        <p className="muted">R is available in Scratchpad when your course has R enabled.</p>
        <button className="outline-button" disabled={busy} onClick={() => void openScratchpad()}>{busy ? "Opening…" : "Open Kiwi Scratchpad"}</button>
        {error && <p role="alert" className="error-text">{error}</p>}
      </section>
    </div>
  );
}
