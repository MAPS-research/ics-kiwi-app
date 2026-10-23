import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import {
  AI_TIMEOUT_MS, RequestTimeout, checkItem, generateItem, generateSimilar, lockedFrom, practiceStatus, reportUnreached,
  resetVerificationMemory, revealItem, verifyAfterFirstCheck, webRRunner, withTimeout,
} from "./questions";

/*
 * Coverage for the AIRUN client helpers (§12.8): the typed API wrappers and their client timeout, the
 * `difficulty_locked` reader, the once-per-item verification run (runner failures, retries, `already_verified`) and the
 * default webR runner (rEngine is mocked so no worker starts).
 */

const engine = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  result: { ok: true, output: "[1] 4", entries: [{ type: "stdout", text: "[1] 4" }], error: undefined as string | undefined },
}));
vi.mock("./rEngine", () => ({
  runR: async (code: string, options: unknown) => {
    engine.calls.push([code, options]);
    return engine.result;
  },
}));

beforeEach(() => {
  resetVerificationMemory();
  engine.calls.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const item = { id: "gi-1", code: "mean(c(2, 6))", needsVerification: true };

describe("API wrappers", () => {
  it("send free-practice generation with its surface and pass the other calls through", async () => {
    const generated = vi.spyOn(api, "generateItem").mockResolvedValue({ id: "gi-1" } as never);
    const similar = vi.spyOn(api, "generateSimilar").mockResolvedValue({ id: "gi-2" } as never);
    const check = vi.spyOn(api, "checkItem").mockResolvedValue({ correct: true } as never);
    const reveal = vi.spyOn(api, "revealItem").mockResolvedValue({ answer: "4", explanation: "" });
    const status = vi.spyOn(api, "practiceStatus").mockResolvedValue({ unitId: "u1" } as never);
    await generateItem("c1", { studentId: "s1", unitId: "u1", type: "fill", difficulty: 2 });
    expect(generated).toHaveBeenCalledWith("c1", { studentId: "s1", unitId: "u1", type: "fill", difficulty: 2, surface: "free-practice" });
    await generateSimilar("c1", { studentId: "s1", assignmentId: "w1", questionId: "q1", difficulty: 3 });
    expect(similar).toHaveBeenCalledWith("c1", { studentId: "s1", assignmentId: "w1", questionId: "q1", difficulty: 3 });
    await checkItem("c1", "gi-1", { answer: "4", timeOnItemMs: 1200 });
    expect(check).toHaveBeenCalledWith("c1", "gi-1", { answer: "4", timeOnItemMs: 1200 });
    expect(await revealItem("c1", "gi-1")).toEqual({ answer: "4", explanation: "" });
    expect(reveal).toHaveBeenCalledWith("c1", "gi-1");
    await practiceStatus("c1", "u1");
    expect(status).toHaveBeenCalledWith("c1", "u1");
  });

  it("gives up on generation after the client timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "generateItem").mockReturnValue(new Promise(() => undefined));
    const pending = generateItem("c1", { studentId: "s1", unitId: "u1", type: "fill", difficulty: 2 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(AI_TIMEOUT_MS);
    const error = await pending;
    expect(error).toBeInstanceOf(RequestTimeout);
    expect((error as Error).message).toBe("No answer within 75 s");
  });

  it("withTimeout passes results and rejections through and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(3), 1000)).resolves.toBe(3);
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("lockedFrom", () => {
  it("reads the unlocked maximum from a difficulty_locked error", () => {
    expect(lockedFrom(new ApiError(409, "difficulty_locked", "Locked", { level: 4, needed: 3, have: 1 }))).toBe(3);
    expect(lockedFrom(new ApiError(409, "difficulty_locked", "Locked", { level: "x" }))).toBeNull();
    expect(lockedFrom(new ApiError(409, "difficulty_locked", "Locked"))).toBeNull();
    expect(lockedFrom(new ApiError(429, "rate_limited", "Slow down"))).toBeNull();
    expect(lockedFrom(new Error("other"))).toBeNull();
  });
});

describe("verifyAfterFirstCheck", () => {
  it("runs the item's code once and posts the stdout", async () => {
    const verify = vi.spyOn(api, "verifyItem").mockResolvedValue({ recorded: true });
    const runner = vi.fn(async () => ({ ok: true, output: "all output", stdout: "[1] 4" }));
    expect(await verifyAfterFirstCheck("c1", item, runner)).toBe(true);
    expect(await verifyAfterFirstCheck("c1", item, runner)).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith("c1", "gi-1", { runOutput: "[1] 4", ok: true });
  });

  it("skips items without code or without verification", async () => {
    const runner = vi.fn(async () => ({ ok: true, output: "" }));
    expect(await verifyAfterFirstCheck("c1", { ...item, needsVerification: false }, runner)).toBe(false);
    expect(await verifyAfterFirstCheck("c1", { ...item, code: "" }, runner)).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it("sends nothing when webR cannot start, and tries again next time", async () => {
    const verify = vi.spyOn(api, "verifyItem").mockResolvedValue({ recorded: true });
    const failing = vi.fn(async () => {
      throw new Error("webR unavailable");
    });
    expect(await verifyAfterFirstCheck("c1", item, failing)).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    expect(await verifyAfterFirstCheck("c1", item, async () => ({ ok: false, output: "", error: "Error: boom" }))).toBe(true);
    expect(verify).toHaveBeenCalledWith("c1", "gi-1", { runOutput: "Error: boom", ok: false });
  });

  it("treats already_verified as done and rethrows other failures (allowing one retry)", async () => {
    const runner = async () => ({ ok: true, output: "x".repeat(50000) });
    const verify = vi.spyOn(api, "verifyItem").mockRejectedValueOnce(new ApiError(409, "already_verified", "Already verified"));
    expect(await verifyAfterFirstCheck("c1", item, runner)).toBe(true);
    expect((verify.mock.calls[0][2] as { runOutput: string }).runOutput).toHaveLength(40000);
    resetVerificationMemory();
    verify.mockRejectedValueOnce(new ApiError(0, "network_error", "offline"));
    await expect(verifyAfterFirstCheck("c1", item, runner)).rejects.toMatchObject({ code: "network_error" });
    verify.mockResolvedValueOnce({ recorded: true });
    expect(await verifyAfterFirstCheck("c1", item, runner)).toBe(true);
  });
});

describe("webRRunner", () => {
  it("runs in its own environment without graphics and joins stdout entries", async () => {
    engine.result = { ok: true, output: "[1] 4\nWarning", entries: [{ type: "stdout", text: "[1] 4" }, { type: "warning", text: "w" }], error: undefined };
    const result = await webRRunner("mean(c(2, 6))");
    expect(result).toEqual({ ok: true, output: "[1] 4\nWarning", stdout: "[1] 4", error: undefined });
    const [code, options] = engine.calls[0];
    expect(code).toBe("mean(c(2, 6))");
    expect(options).toMatchObject({ graphics: false, envKey: expect.stringMatching(/^verify:\d+$/) });
  });
  it("reports errors and leaves stdout empty when nothing was printed", async () => {
    engine.result = { ok: false, output: "Error: boom", entries: [{ type: "error", text: "boom" }], error: "boom" };
    expect(await webRRunner("stop('boom')")).toEqual({ ok: false, output: "Error: boom", stdout: undefined, error: "boom" });
  });
});

describe("reportUnreached", () => {
  it("tracks requests that never reached the Lab and ignores Lab answers", async () => {
    const track = vi.fn(async () => undefined);
    const ctx = { action: "chat" as const, surface: "ask-kiwi" as const, unitId: "u1", itemId: "gi-1" };
    expect(await reportUnreached(track, new ApiError(400, "invalid_request", "Bad"), ctx)).toBe(false);
    expect(await reportUnreached(track, new TypeError("Failed to fetch"), ctx)).toBe(true);
    expect(track).toHaveBeenCalledWith("ai_request_unreached", expect.objectContaining({ reason: "network", itemId: "gi-1" }), "gi-1");
  });
});
