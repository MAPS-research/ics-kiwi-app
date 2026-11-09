import { useEffect, useMemo, useState, type JSX } from "react";
import { activateTracker, createTracker, flushTelemetry, getTelemetryContext, matchAiReply, releaseTracker, useTelemetryStatus } from "../../lib/telemetry";
import type { TelemetryContext, TelemetryStatus, Tracker } from "../../types";

/*
 * Student telemetry root (TELEMETRY; signatures frozen, §7.9 / §11.1 / §11.4). Mounted once by StudentApp:
 * ONE 30 s heartbeat interval per identity (route changes never restart it), the global listeners (page_view,
 * visibility, idle, paste) and the outbox flush triggers (online, hidden, pagehide with keepalive).
 */

export const HEARTBEAT_MS = 30_000;
export const ACTIVE_WINDOW_MS = 60_000;
export const MOUSEMOVE_THROTTLE_MS = 5_000;
export const BANNER_AFTER_MS = 30_000;
const INPUTS = ["pointerdown", "keydown", "wheel", "scroll", "touchstart", "mousemove"] as const;

type Listenable = Pick<EventTarget, "addEventListener" | "removeEventListener">;
export interface StudentTelemetryDeps {
  track: Tracker;
  getContext?: () => TelemetryContext | null;
  flush?: (options?: { keepalive?: boolean }) => Promise<void>;
  match?: (text: string) => { matches: boolean; chatTurnId: number | null };
  now?: () => number;
  target?: Listenable;                                        // window
  doc?: Listenable & { visibilityState?: string };            // document
  path?: () => string;                                        // location.pathname
}

/** Where a paste landed: an explicit `data-paste-target`, the R editor, a chat box, else an answer field. */
export function pasteTarget(element: unknown): "code" | "answer" | "chat" {
  const el = element as { closest?: (s: string) => { getAttribute?: (n: string) => string | null } | null } | null;
  if (!el || typeof el.closest !== "function") return "answer";
  const explicit = el.closest("[data-paste-target]")?.getAttribute?.("data-paste-target");
  if (explicit === "code" || explicit === "chat" || explicit === "answer") return explicit;
  if (el.closest(".work-code, [aria-label='R code editor']")) return "code";
  if (el.closest(".chat-panel, .kiwi-chat, [data-chat], .chat-input")) return "chat";
  return "answer";
}

const toolOf = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 4 && parts.includes("assignments") ? parts[parts.length - 1] : parts[parts.length - 1] ?? "";
};

/** Starts the heartbeat and global listeners; returns the stop function (used by the hook and by tests). */
export function startStudentTelemetry(deps: StudentTelemetryDeps): () => void {
  const now = deps.now ?? Date.now;
  const target: Listenable = deps.target ?? (globalThis as unknown as Listenable);
  const doc = deps.doc ?? (globalThis as unknown as { document: Listenable & { visibilityState?: string } }).document;
  const path = deps.path ?? (() => location.pathname);
  const getContext = deps.getContext ?? getTelemetryContext;
  const flush = deps.flush ?? flushTelemetry;
  const match = deps.match ?? matchAiReply;
  const { track } = deps;
  const seen = new Map<string, number>();
  let lastInput = now();
  let idle = false;
  let lastRoute = path();
  const visible = () => (doc?.visibilityState ?? "visible") === "visible";

  const onInput = (kind: string) => () => {
    const at = now();
    if (kind === "mousemove" && at - (seen.get(kind) ?? -Infinity) < MOUSEMOVE_THROTTLE_MS) return;
    seen.set(kind, at);
    if (idle) {
      idle = false;
      void track("idle", { state: "active", idleMs: at - lastInput });
    }
    lastInput = at;
  };
  const inputHandlers = INPUTS.map((kind) => [kind, onInput(kind)] as const);
  for (const [kind, handler] of inputHandlers) target.addEventListener(kind, handler, { passive: true, capture: true } as AddEventListenerOptions);

  const pageView = (from: string) => {
    const route = path();
    const ctx = getContext();
    void track("page_view", { route, fromRoute: from, tool: ctx?.tool ?? toolOf(route), ...(ctx?.questionId ? { questionId: ctx.questionId } : {}) });
  };
  pageView("");
  const onRoute = () => {
    const route = path();
    if (route === lastRoute) return;
    const from = lastRoute;
    lastRoute = route;
    pageView(from);
  };
  target.addEventListener("popstate", onRoute);

  const tick = () => {
    const at = now();
    if (!idle && at - lastInput >= ACTIVE_WINDOW_MS) {
      idle = true;
      void track("idle", { state: "idle", idleMs: at - lastInput });
    }
    if (!visible() || at - lastInput >= ACTIVE_WINDOW_MS) return;
    const ctx = getContext();
    const signals = [...seen.entries()].filter(([, t]) => at - t < ACTIVE_WINDOW_MS).map(([k]) => k).sort();
    void track("study_heartbeat", {
      seconds: HEARTBEAT_MS / 1000,
      route: path(),
      ...(ctx
        ? { unitId: ctx.unitId, assignmentId: ctx.assignmentId, questionId: ctx.questionId, itemId: ctx.itemId, tool: ctx.tool }
        : {}),
      signals,
    });
  };
  const timer = setInterval(tick, HEARTBEAT_MS);

  const onVisibility = () => {
    const state = visible() ? "visible" : "hidden";
    void track("visibility", { state, idleMs: now() - lastInput });
    if (state === "hidden") void flush();
  };
  doc?.addEventListener("visibilitychange", onVisibility);
  const onPaste = (event: Event) => {
    const data = (event as ClipboardEvent).clipboardData;
    const text = data?.getData?.("text/plain") ?? "";
    if (!text) return;
    const result = match(text); // hashes only; the pasted text itself is never stored or sent
    void track("paste", {
      target: pasteTarget(event.target),
      length: text.length,
      matchesAiReply: result.matches,
      ...(result.matches && result.chatTurnId !== null ? { chatTurnId: result.chatTurnId } : {}),
    });
  };
  doc?.addEventListener("paste", onPaste, true);
  const onOnline = () => void flush();
  const onPageHide = () => void flush({ keepalive: true });
  target.addEventListener("online", onOnline);
  target.addEventListener("pagehide", onPageHide);

  return () => {
    clearInterval(timer);
    for (const [kind, handler] of inputHandlers) target.removeEventListener(kind, handler, { capture: true } as EventListenerOptions);
    target.removeEventListener("popstate", onRoute);
    target.removeEventListener("online", onOnline);
    target.removeEventListener("pagehide", onPageHide);
    doc?.removeEventListener("visibilitychange", onVisibility);
    doc?.removeEventListener("paste", onPaste, true);
  };
}

export function useStudentTelemetry(ctx: { classId: string; studentId: string; studentName: string; preview: boolean }): Tracker {
  const { classId, studentId, studentName, preview } = ctx;
  const track = useMemo(() => createTracker({ classId, studentId, studentName, preview }), [classId, studentId, studentName, preview]);
  useEffect(() => {
    if (!classId || !studentId) return;
    activateTracker({ classId, studentId, studentName });
    const stop = startStudentTelemetry({ track });
    return () => {
      stop();
      releaseTracker({ classId, studentId });   // INTEGRATION: no delivery under the next identity's headers
    };
  }, [classId, studentId, studentName, track]);
  return track;
}

/** Pure banner view: blocked → "can't be saved"; pending after 30 s of failures → "Saving activity… (n pending)". */
export function TelemetryStatusBannerView({ status, now }: { status: TelemetryStatus; now: number }): JSX.Element | null {
  if (status.blocked)
    return (
      <div className="global-status telemetry-status" role="alert">
        <p className="error-text">Your activity can't be saved for this course.</p>
      </div>
    );
  if (status.failingSince === null || now - status.failingSince < BANNER_AFTER_MS || status.pending < 1) return null;
  // RV6-m13: a visible banner that stays at the top of the page and says what to do
  return (
    <div className="global-status telemetry-status telemetry-saving" role="status">
      <p>
        <strong>Saving activity… ({status.pending} pending)</strong> Keep this tab open until this message goes away.
      </p>
    </div>
  );
}

export function TelemetryStatusBanner(): JSX.Element | null {
  const status = useTelemetryStatus();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status.failingSince === null || status.blocked) return;
    const wait = Math.max(0, status.failingSince + BANNER_AFTER_MS - Date.now());
    const timer = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(timer);
  }, [status.failingSince, status.blocked]);
  return <TelemetryStatusBannerView status={status} now={Math.max(now, status.failingSince ?? 0)} />;
}
