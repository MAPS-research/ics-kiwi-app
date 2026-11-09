import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigate } from "../../lib/navigation";
import { clearAiReplies, registerAiReply, setTelemetryContext } from "../../lib/telemetry";
import { HEARTBEAT_MS, pasteTarget, startStudentTelemetry, TelemetryStatusBannerView } from "./TelemetryRoot";

type Call = [string, Record<string, unknown>, string | undefined];

function setup() {
  const calls: Call[] = [];
  const track = vi.fn(async (type: string, payload: Record<string, unknown>, questionId?: string) => {
    calls.push([type, payload, questionId]);
  });
  const flush = vi.fn(async () => undefined);
  const stop = startStudentTelemetry({ track, flush });
  const of = (type: string) => calls.filter((c) => c[0] === type).map((c) => c[1]);
  return { calls, track, flush, stop, of };
}
const input = (kind = "keydown") => dispatchEvent(new Event(kind));

beforeEach(() => {
  vi.useFakeTimers();
  clearAiReplies();
  setTelemetryContext(null);
  (document as unknown as { visibilityState: string }).visibilityState = "visible";
  history.replaceState(null, "", "/student/assignments");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useStudentTelemetry root (TELEMETRY-29, TELEMETRY-04, TELEMETRY-07)", () => {
  it("starts ONE 30 s interval that survives route changes; heartbeats carry the latest context; page_view per route", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const { of, stop } = setup();
    expect(intervals).toHaveBeenCalledTimes(1);
    expect(of("page_view")).toEqual([{ route: "/student/assignments", fromRoute: "", tool: "assignments" }]);

    const routes = [
      ["/student/assignments/w1/answer", { surface: "assignment" as const, unitId: "r-basics", assignmentId: "w1", questionId: "q1", tool: "answer" }],
      ["/student/practice/question", { surface: "free-practice" as const, unitId: "data-wrangling", itemId: "gi-1", tool: "question" }],
      ["/student/code", { surface: "workspace" as const, unitId: "", tool: "code" }],
    ] as const;
    for (const [route, ctx] of routes) {
      navigate(route);
      setTelemetryContext(ctx);
      input();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    }
    expect(intervals).toHaveBeenCalledTimes(1);
    const views = of("page_view");
    expect(views.map((v) => v.route)).toEqual(["/student/assignments", ...routes.map(([r]) => r)]);
    expect(views[2].fromRoute).toBe("/student/assignments/w1/answer");
    const beats = of("study_heartbeat");
    expect(beats).toHaveLength(3);
    expect(beats[0]).toMatchObject({ seconds: 30, route: "/student/assignments/w1/answer", unitId: "r-basics", assignmentId: "w1", questionId: "q1" });
    expect(beats[1]).toMatchObject({ route: "/student/practice/question", unitId: "data-wrangling", itemId: "gi-1" });
    expect(beats[2]).toMatchObject({ route: "/student/code", tool: "code" });
    expect(beats[0].signals).toEqual(["keydown"]);
    stop();
  });

  it("no heartbeat while hidden or without input in the last 60 s; idle and visibility events; flush triggers", async () => {
    const { of, flush, stop } = setup();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(of("study_heartbeat")).toHaveLength(1); // input at start counts as recent
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(of("idle")).toEqual([expect.objectContaining({ state: "idle" })]);
    expect(of("study_heartbeat")).toHaveLength(1);
    input("pointerdown");
    expect(of("idle")[1]).toMatchObject({ state: "active" });
    (document as unknown as { visibilityState: string }).visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(of("visibility")).toEqual([expect.objectContaining({ state: "hidden" })]);
    expect(flush).toHaveBeenCalledWith();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(of("study_heartbeat")).toHaveLength(1);
    dispatchEvent(new Event("pagehide"));
    expect(flush).toHaveBeenLastCalledWith({ keepalive: true });
    dispatchEvent(new Event("online"));
    expect(flush).toHaveBeenCalledTimes(3);
    stop();
  });

  it("paste of ≥ 40 chars of a registered AI reply emits paste {matchesAiReply, chatTurnId} without the text", () => {
    const reply = "Use mean(scores, na.rm = TRUE) so that missing values are ignored when you average the scores.";
    registerAiReply(reply, 9);
    const { of, stop } = setup();
    const paste = (text: string, target: unknown = null) => {
      const event = new Event("paste");
      Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
      Object.defineProperty(event, "target", { value: target });
      document.dispatchEvent(event);
    };
    paste(reply.slice(0, 60));
    const own = "print('my own words that are definitely long enough')";
    paste(own);
    const events = of("paste");
    expect(events[0]).toEqual({ target: "answer", length: 60, matchesAiReply: true, chatTurnId: 9 });
    expect(events[1]).toEqual({ target: "answer", length: own.length, matchesAiReply: false });
    expect(JSON.stringify(events)).not.toContain("na.rm");
    stop();
  });

  it("stop() clears the interval and every listener", async () => {
    const { track, stop } = setup();
    stop();
    track.mockClear();
    navigate("/student/code");
    dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(track).not.toHaveBeenCalled();
  });

  it("classifies the paste target", () => {
    const el = (map: Record<string, unknown>) => ({ closest: (s: string) => map[s] ?? null });
    expect(pasteTarget(null)).toBe("answer");
    expect(pasteTarget(el({ "[data-paste-target]": { getAttribute: () => "chat" } }))).toBe("chat");
    expect(pasteTarget(el({ ".work-code, [aria-label='R code editor']": {} }))).toBe("code");
    expect(pasteTarget(el({ ".chat-panel, .kiwi-chat, [data-chat], .chat-input": {} }))).toBe("chat");
  });
});

describe("TelemetryStatusBanner view (§11.1)", () => {
  const render = (status: { pending: number; failingSince: number | null; blocked: boolean }, now: number) =>
    renderToStaticMarkup(createElement(TelemetryStatusBannerView, { status, now }));
  it("shows 'Saving activity… (n pending)' only after 30 s of failures, and the 403 banner when blocked", () => {
    expect(render({ pending: 3, failingSince: null, blocked: false }, 0)).toBe("");
    expect(render({ pending: 3, failingSince: 1000, blocked: false }, 20_000)).toBe("");
    expect(render({ pending: 3, failingSince: 1000, blocked: false }, 31_000)).toContain("Saving activity… (3 pending)");
    expect(render({ pending: 3, failingSince: 1000, blocked: false }, 31_000)).toContain("Keep this tab open until this message goes away.");   // RV6-m13
    expect(render({ pending: 3, failingSince: 1000, blocked: true }, 1000)).toContain("Your activity can&#x27;t be saved for this course.");
  });
});
