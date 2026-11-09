import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api, ApiError, request, requestBlob, setDemoSessionHeader, setKiwiTokenProvider, setNameModeHeader, setPreviewHeader, setTeacherKeyHeader,
} from "./api";

type Call = { url: string; init: RequestInit };
function stubFetch(responses: Response[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  });
  return calls;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const headers = (call: Call) => call.init.headers as Record<string, string>;

afterEach(() => {
  vi.unstubAllGlobals();
  setKiwiTokenProvider(undefined);
  setTeacherKeyHeader(null);
  setDemoSessionHeader(null);
  setPreviewHeader(false);
  setNameModeHeader("names");
});

describe("request headers (§8)", () => {
  it("sends the context headers and classId", async () => {
    const calls = stubFetch([json({ ok: true })]);
    setTeacherKeyHeader("key-1");
    setDemoSessionHeader("demo.token");
    setPreviewHeader(true);
    setNameModeHeader("pseudonyms");
    await api.course("local-r-class");
    expect(calls[0].url).toBe("/api/course?classId=local-r-class");
    expect(headers(calls[0])).toMatchObject({ "X-Teacher-Key": "key-1", "X-Demo-Session": "demo.token", "X-Kiwi-Preview": "1", "X-Name-Mode": "pseudonyms" });
    expect(headers(calls[0])["Content-Type"]).toBeUndefined();
  });
  it("lets verifyTeacher and legacy keys override the context key", async () => {
    const calls = stubFetch([json({ ok: true, role: "instructor" }), json([])]);
    setTeacherKeyHeader("context");
    await api.verifyTeacher("c1", "typed-key");
    await api.policies("c1", "");
    expect(headers(calls[0])["X-Teacher-Key"]).toBe("typed-key");
    expect(calls[0].init.method).toBe("POST");
    expect(headers(calls[1])["X-Teacher-Key"]).toBe("context");
  });
  it("refreshes the Kiwi token once on 401", async () => {
    const calls = stubFetch([json({ error: "expired" }, 401), json({ classId: "c1" })]);
    const forced: boolean[] = [];
    let token = "stale";
    setKiwiTokenProvider(async (force) => {
      forced.push(Boolean(force));
      if (force) token = "fresh"; // the SDK caches the refreshed token
      return token;
    });
    await api.kiwiContext("c1");
    expect(forced).toEqual([false, true, false]);
    expect(headers(calls[1]).Authorization).toBe("Bearer fresh");
  });
  it("encodes path parameters and drops empty query values", async () => {
    const calls = stubFetch([json({}), json({})]);
    await api.conversationThread("c1", "lab:ada:t1");
    await api.assignmentStudents("c1", "w 1", "missing");
    expect(calls[0].url).toBe("/api/teacher/ai-conversations/threads/lab%3Aada%3At1?classId=c1");
    expect(calls[1].url).toBe("/api/teacher/assignments/w%201/students?classId=c1&state=missing");
  });
  it("sends JSON bodies with the right methods", async () => {
    const calls = stubFetch([json({}), new Response(null, { status: 204 }), json({})]);
    await api.updateRosterEntry("c1", "s1", { displayName: "Ada" });
    expect(await api.deleteAssignment("c1", "w1")).toBeUndefined();
    await api.eventBatch("c1", [], { keepalive: true });
    expect(calls[0].init.method).toBe("PATCH");
    expect(calls[0].init.body).toBe('{"displayName":"Ada"}');
    expect(headers(calls[0])["Content-Type"]).toBe("application/json");
    expect(calls[1].init.method).toBe("DELETE");
    expect(calls[2].init.keepalive).toBe(true);
    expect(calls[2].init.body).toBe('{"classId":"c1","events":[]}');
  });
});

describe("errors", () => {
  it("throws ApiError with the server code, message and details", async () => {
    stubFetch([json({ error: "Missing answers", code: "incomplete_submission", details: { missing: ["q2"] } }, 400)]);
    const error = await api.submitWork("c1", "w1", { studentId: "s", answers: {}, requestId: "r" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: "incomplete_submission", message: "Missing answers", details: { missing: ["q2"] } });
  });
  it("maps non-JSON failures and network errors", async () => {
    stubFetch([new Response("<html>bad gateway</html>", { status: 502 })]);
    await expect(request("/x")).rejects.toMatchObject({ status: 502, code: "ai_provider_error", message: "Request failed (502)" });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(request("/x")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });
  it("reports unreadable success bodies instead of returning {}", async () => {
    stubFetch([new Response("not json", { status: 200 })]);
    await expect(request("/x")).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("downloads", () => {
  it("returns the blob and the Content-Disposition filename", async () => {
    stubFetch([new Response("a,b", { status: 200, headers: { "Content-Disposition": 'attachment; filename="grades-c1.csv"' } })]);
    const file = await api.gradesCsv("c1", { policy: "latest" });
    expect(file.filename).toBe("grades-c1.csv");
    expect(await file.blob.text()).toBe("a,b");
  });
  it("falls back to the path name and encodes export paths", async () => {
    const calls = stubFetch([new Response("zip", { status: 200 })]);
    const file = await api.downloadExport("c1", "student/ada chen.zip", { purpose: "integrity review" });
    expect(calls[0].url).toBe("/api/teacher/exports/student/ada%20chen.zip?classId=c1&purpose=integrity+review");
    expect(file.filename).toBe("ada chen.zip");
    await expect(requestBlob("/teacher/missing")).rejects.toThrow();
  });
});
