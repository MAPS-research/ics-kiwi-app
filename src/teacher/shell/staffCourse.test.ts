import { afterEach, describe, expect, it, vi } from "vitest";
import { courseLoadedByApp } from "../../App";
import { setTeacherKeyHeader } from "../../lib/api";
import { displayTimeZone, setDisplayTimeZone } from "../../lib/format";
import { loadStaffCourse, STAFF_COURSE_ERROR, staffIdentityKey } from "./TeacherContext";
import type { Me } from "../../types";

/*
 * R-B01: the teacher workspace loads the course with the staff identity (never the student view App boots with) and
 * loads it again when the staff identity changes.
 */

type Call = { url: string; init: RequestInit };
function stubFetch(body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}
const unit = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, goal: "g", status: "current", ...extra });

afterEach(() => {
  vi.unstubAllGlobals();
  setTeacherKeyHeader(null);
  setDisplayTimeZone(undefined);
});

describe("loadStaffCourse (R-B01)", () => {
  it("sends the staff key and keeps hidden chapters and notes", async () => {
    const calls = stubFetch({ title: "T", currentUnitId: "a", view: "staff", timeZone: "Asia/Shanghai",
      units: [unit("a", { notes: "R session 1a" }), unit("h", { access: "hidden", effectiveAccess: "hidden", notes: "archived" })] });
    setTeacherKeyHeader("staff-key");
    const course = await loadStaffCourse("c1");
    expect(calls[0].url).toBe("/api/course?classId=c1");
    expect((calls[0].init.headers as Record<string, string>)["X-Teacher-Key"]).toBe("staff-key");
    expect(course.view).toBe("staff");
    expect(course.units.map((u) => [u.id, u.access, u.notes])).toEqual([["a", "default", "R session 1a"], ["h", "hidden", "archived"]]);
    expect(displayTimeZone()).toBe("Asia/Shanghai");
  });
  it("refuses the student view, so no teacher page can save it", async () => {
    stubFetch({ title: "T", currentUnitId: "a", view: "student", units: [unit("a")] });
    await expect(loadStaffCourse("c1")).rejects.toThrow(STAFF_COURSE_ERROR);
  });
  it("accepts a v0.5.1 server that sends no view", async () => {
    stubFetch({ title: "T", currentUnitId: "a", units: [unit("a")] });
    expect((await loadStaffCourse("c1")).units).toHaveLength(1);
  });
});

describe("staffIdentityKey (R-B01)", () => {
  const me = (patch: Partial<Me> = {}): Me => ({
    kind: "teacher_key", classId: "c1", userId: "instructor", displayName: "I", role: "instructor", permissions: [], isStaff: true,
    roleSource: "key", exportsForcedPseudonymous: false, preview: false, verified: false, classLinked: false, staffId: null, ...patch,
  });
  it("is null until a staff identity with a Lab role is known", () => {
    expect(staffIdentityKey(null, "k")).toBeNull();
    expect(staffIdentityKey(me({ isStaff: false }), "k")).toBeNull();
    expect(staffIdentityKey(me({ role: null }), "k")).toBeNull();
  });
  it("changes with the key, the staff member and the role, so the staff course is loaded again", () => {
    const base = staffIdentityKey(me(), "k1");
    expect(base).not.toBeNull();
    expect(staffIdentityKey(me(), "k1")).toBe(base);
    expect(staffIdentityKey(me(), "k2")).not.toBe(base);
    expect(staffIdentityKey(me({ role: "ta", staffId: "staff-1" }), "k1")).not.toBe(base);
    expect(staffIdentityKey(me({ kind: "kiwi", userId: "u7" }), null)).not.toBe(staffIdentityKey(me({ kind: "kiwi", userId: "u8" }), null));
  });
});

describe("App boot (R-B01)", () => {
  it("leaves the teacher course to the teacher workspace and loads the other views itself", () => {
    expect(courseLoadedByApp("teacher")).toBe(false);
    for (const role of ["entry", "preview", "student"] as const) expect(courseLoadedByApp(role)).toBe(true);
  });
});
