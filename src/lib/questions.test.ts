import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  aiErrorMessage,
  chapterOptions,
  chatThreadId,
  checkFeedback,
  checkItem,
  difficultyOptions,
  firstUsableChapter,
  generateItem,
  guardNotice,
  helpLevelNotice,
  legacyThreadId,
  lockedFrom,
  normalizeAnswer,
  practiceStatus,
  reportUnreached,
  RequestTimeout,
  resetVerificationMemory,
  settingsChanges,
  skippedPayload,
  unreachedReason,
  verifyAfterFirstCheck,
  withTimeout,
} from "./questions";
import type { Course, GeneratedItemPublic, Unit } from "../types";

/* AIRUN client helpers: API wrappers, display normalization, chapter/difficulty options, notices, unreached reports. */

const unit = (id: string, title: string, effectiveAccess: Unit["effectiveAccess"]): Unit => ({
  id, title, goal: "", status: "current", access: "default", effectiveAccess, week: null, startsOn: null,
  runtime: { packages: [], datasetFileIds: [], timeoutSeconds: 12, errorHints: [] },
});
const course: Pick<Course, "units"> = {
  units: [unit("ch1", "01 · Intro", "open"), unit("ch2", "02 · R basics", "review"), unit("ch3", "03 · Wrangling", "open"),
    unit("ch4", "04 · Text", "locked"), unit("ch5", "05 · Hidden", "hidden")],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => resetVerificationMemory());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("display normalization", () => {
  it("normalizes like the v0.5.1 display helper", () => {
    expect(normalizeAnswer("  [1] 'Social Data'  ")).toBe("socialdata");
    expect(normalizeAnswer("[1] 4")).toBe("4");
  });
});

describe("chapter and difficulty options", () => {
  it("omits hidden chapters and marks locked ones as Opens later", () => {
    const practice = chapterOptions(course, "practice");
    expect(practice.map((o) => o.value)).toEqual(["ch1", "ch2", "ch3", "ch4"]);
    expect(practice.find((o) => o.value === "ch4")).toEqual({ value: "ch4", label: "04 · Text (Opens later)", disabled: true });
    expect(practice.find((o) => o.value === "ch2")).toMatchObject({ label: "02 · R basics (Review — Ask Kiwi only)", disabled: true });
    expect(chapterOptions(course, "chat").find((o) => o.value === "ch2")).toMatchObject({ label: "02 · R basics (Review)", disabled: false });
    expect(firstUsableChapter(course, "practice", "ch4")).toBe("ch1");
    expect(firstUsableChapter(course, "chat", "ch2")).toBe("ch2");
  });

  it("labels locked difficulty levels (AIRUN-25)", () => {
    const options = difficultyOptions({ minDifficulty: 1, maxDifficulty: 5, difficultyRubric: { "3": "Combine two steps" } }, 2);
    expect(options.map((o) => o.label)).toEqual([
      "1 · One-step recall", "2 · Apply one function", "3 · Combine two steps (locked)",
      "4 · Debug or adapt code (locked)", "5 · Multi-step task combining chapter skills (locked)",
    ]);
    expect(options.filter((o) => o.disabled).map((o) => o.value)).toEqual([3, 4, 5]);
    expect(difficultyOptions({ minDifficulty: 2, maxDifficulty: 3 }, null).every((o) => !o.disabled)).toBe(true);
    expect(lockedFrom(new ApiError(403, "difficulty_locked", "locked", { level: 3, needed: 3, have: 2 }))).toBe(2);
    expect(lockedFrom(new ApiError(403, "chapter_closed", "closed"))).toBeNull();
  });
});

describe("threads", () => {
  it("prefixes threads per surface and keeps the v0.5.1 id for history", () => {
    expect(chatThreadId("ask-kiwi", { unitId: "r-basics" })).toBe("thread-standalone-r-basics");
    expect(chatThreadId("assignment", { unitId: "r", assignmentId: "work-1", questionId: "q1" })).toBe("thread-assignment-work-1-q1");
    expect(chatThreadId("free-practice", { unitId: "r", itemId: "gi-1" })).toBe("thread-practice-gi-1");
    expect(chatThreadId("similar", { unitId: "r", itemId: "gi-2" })).toBe("thread-similar-gi-2");
    expect(legacyThreadId({ unitId: "r-basics" })).toBe("thread-practice-r-basics");
    expect(legacyThreadId({ unitId: "r", assignmentId: "work-1", questionId: "q1" })).toBe("thread-work-1-q1");
  });
});

describe("notices and messages", () => {
  it("names the assignment help level and guard rewrites", () => {
    expect(helpLevelNotice("hints_only")).toBe("Ask Kiwi gives hints only for this assignment");
    expect(helpLevelNotice("off")).toBe("Ask Kiwi is turned off for this assignment");
    expect(helpLevelNotice(null)).toBeNull();
    expect(guardNotice("redacted")).toMatch(/hid part of this reply/);
    expect(guardNotice("retried_clean")).toMatch(/rewrote this reply/);
    expect(guardNotice("clean")).toBeNull();
  });

  it("builds check feedback including withheld explanations", () => {
    // RT-01: the explanation stays separate from the verdict (rendered as Markdown by the view)
    expect(checkFeedback({ correct: true, attemptIndex: 1, explanation: "Because `x > 2`.", explanationWithheld: false, canReveal: false }))
      .toEqual({ tone: "correct", text: "Correct.", explanation: "Because `x > 2`.", note: null });
    expect(checkFeedback({ correct: true, attemptIndex: 1, explanationWithheld: true, canReveal: false }))
      .toEqual({ tone: "correct", text: "Correct.", explanation: null, note: "The explanation is shown after the homework closes." });
    expect(checkFeedback({ correct: null, attemptIndex: 1, explanation: "  ", explanationWithheld: false, canReveal: false }))
      .toEqual({ tone: "neutral", text: "Answer recorded.", explanation: null, note: null });
    expect(checkFeedback({ correct: false, attemptIndex: 2, explanation: "Look at `filter()`.", explanationWithheld: true, canReveal: true }))
      .toEqual({ tone: "incorrect", text: "Try again. Inspect the code or ask Kiwi for a hint.", explanation: "Look at `filter()`.", note: null });
  });

  it("uses the server message and explains network failures", () => {
    expect(aiErrorMessage(new ApiError(403, "chapter_closed", "This chapter isn't open yet."))).toBe("This chapter isn't open yet.");
    expect(aiErrorMessage(new ApiError(0, "network_error", "x"))).toMatch(/Could not reach CSS Lab/);
    expect(aiErrorMessage(new RequestTimeout(75000))).toMatch(/took too long/);
  });
});

describe("unreached requests (AIRUN-26)", () => {
  it("classifies network, timeout and proxy errors; server answers are not unreached", () => {
    expect(unreachedReason(new ApiError(0, "network_error", "down"))).toEqual({ reason: "network", httpStatus: null });
    expect(unreachedReason(new RequestTimeout(10))).toEqual({ reason: "timeout", httpStatus: null });
    expect(unreachedReason(new ApiError(502, "ai_provider_error", "Request failed (502)"))).toEqual({ reason: "http_error", httpStatus: 502 });
    expect(unreachedReason(new ApiError(502, "ai_provider_error", "The AI service could not complete the request."))).toBeNull();
    expect(unreachedReason(new ApiError(429, "rate_limited", "Too many"))).toBeNull();
  });

  it("enqueues ai_request_unreached through the tracker when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const track = vi.fn(() => Promise.resolve());
    const error = await generateItem("c1", { studentId: "s1", unitId: "r-basics", type: "fill", difficulty: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(await reportUnreached(track, error, { action: "question", surface: "free-practice", unitId: "r-basics" })).toBe(true);
    expect(track).toHaveBeenCalledWith("ai_request_unreached",
      { action: "question", surface: "free-practice", reason: "network", httpStatus: null, unitId: "r-basics", assignmentId: undefined,
        questionId: undefined, itemId: undefined }, undefined);
    expect(await reportUnreached(track, new ApiError(403, "forbidden", "no"), { action: "chat", surface: "ask-kiwi", unitId: "u" })).toBe(false);
  });

  it("times out slow requests", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => undefined), 1000);
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeout);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });
});

describe("API wrappers", () => {
  it("sends free-practice generation with the surface and checks through the server", async () => {
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/ai/question")) return Promise.resolve(json(200, { id: "gi-1", type: "fill" }));
      if (url.startsWith("/api/practice/items/gi-1/check")) return Promise.resolve(json(200, { correct: true, attemptIndex: 1, explanationWithheld: false, canReveal: false }));
      if (url.startsWith("/api/practice/status")) return Promise.resolve(json(200, { unlockedMaxDifficulty: 3, usedToday: 1 }));
      return Promise.reject(new Error(`unexpected ${url} ${String(init?.method)}`));
    });
    vi.stubGlobal("fetch", fetcher);
    await generateItem("c1", { studentId: "s1", unitId: "r-basics", type: "fill", difficulty: 2, focusNote: "joins" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/ai/question?classId=c1");
    expect(JSON.parse(String(init?.body))).toEqual({ studentId: "s1", unitId: "r-basics", type: "fill", difficulty: 2, focusNote: "joins", surface: "free-practice" });
    const result = await checkItem("c1", "gi-1", { answer: "4", timeOnItemMs: 1200 });
    expect(result.correct).toBe(true);
    expect(fetcher.mock.calls[1][0]).toBe("/api/practice/items/gi-1/check?classId=c1");
    expect((await practiceStatus("c1", "r-basics")).unlockedMaxDifficulty).toBe(3);
  });

  it("verifies a predict item once after the first check without exposing the answer", async () => {
    const fetcher = vi.fn(() => Promise.resolve(json(200, { recorded: true })));
    vi.stubGlobal("fetch", fetcher);
    const runner = vi.fn(() => Promise.resolve({ ok: true, output: "[1] 30", stdout: "[1] 30" }));
    const item: Pick<GeneratedItemPublic, "id" | "code" | "needsVerification"> = { id: "gi-9", code: "print(sum(c(10, 20)))", needsVerification: true };
    expect(await verifyAfterFirstCheck("c1", item, runner)).toBe(true);
    expect(await verifyAfterFirstCheck("c1", item, runner)).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/practice/items/gi-9/verify?classId=c1");
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ runOutput: "[1] 30", ok: true });
    expect(await verifyAfterFirstCheck("c1", { id: "gi-10", code: "x", needsVerification: false }, runner)).toBe(false);
    const broken = vi.fn(() => Promise.reject(new Error("webR failed to start")));
    expect(await verifyAfterFirstCheck("c1", { id: "gi-11", code: "x", needsVerification: true }, broken)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1); // nothing is reported when R could not run at all
  });
});

describe("practice settings events (AIRUN-13)", () => {
  it("reports one change per field without the focus-note text", () => {
    const before = { unitId: "a", type: "fill" as const, difficulty: 2 as const, focusNote: "" };
    expect(settingsChanges(before, { ...before, type: "choice", difficulty: 3, focusNote: "joins" })).toEqual([
      { field: "type", from: "fill", to: "choice" },
      { field: "difficulty", from: 2, to: 3 },
      { field: "focusNote", from: 0, to: 5 },
    ]);
    expect(settingsChanges(before, before)).toEqual([]);
  });

  it("reports a skipped item only when it was not answered correctly", () => {
    const item = { id: "gi-1", unitId: "r-basics" };
    expect(skippedPayload(item, null, 0)).toEqual({ itemId: "gi-1", attempted: false, unitId: "r-basics" });
    expect(skippedPayload(item, false, 2)).toEqual({ itemId: "gi-1", attempted: true, unitId: "r-basics" });
    expect(skippedPayload(item, true, 1)).toBeNull();
    expect(skippedPayload(null, null, 0)).toBeNull();
  });
});
