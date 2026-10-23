import { afterEach, describe, expect, it, vi } from "vitest";
import {
  demoChoices, ensureDemoSession, exchangeDemoToken, parseDemoFragment, readDemoSession, selectedDemoStudent, storeDemoSession, stripDemoFragment,
} from "./demoSession";

afterEach(() => vi.unstubAllGlobals());
const future = (ms: number) => new Date(Date.now() + ms).toISOString();

describe("demo link fragments", () => {
  it("parses and strips #demo= tokens", () => {
    expect(parseDemoFragment("#demo=demo.abc.def")).toBe("demo.abc.def");
    expect(parseDemoFragment("#x=1&demo=demo.a%2Eb")).toBe("demo.a.b");
    expect(parseDemoFragment("#nothing")).toBeNull();
    expect(stripDemoFragment("#demo=t")).toBe("");
    expect(stripDemoFragment("#x=1&demo=t")).toBe("#x=1");
  });
});

describe("demo sessions", () => {
  it("maps the v0.5.1 selection and defaults to Ada", () => {
    expect(selectedDemoStudent()).toBe("demo-ada");
    localStorage.setItem("kiwi-lab-student", "bo");
    expect(selectedDemoStudent()).toBe("demo-bo");
    localStorage.setItem("kiwi-lab-student", "student-007");
    expect(selectedDemoStudent()).toBe("student-007");
  });
  it("reuses unexpired sessions and ignores ones about to expire", () => {
    storeDemoSession("c1", { token: "t", studentId: "demo-ada", studentName: "Ada Chen", expiresAt: future(3_600_000) });
    expect(readDemoSession("c1", "demo-ada")?.token).toBe("t");
    storeDemoSession("c1", { token: "t2", studentId: "demo-bo", studentName: "Bo Lin", expiresAt: future(10_000) });
    expect(readDemoSession("c1", "demo-bo")).toBeNull();
    expect(readDemoSession("c2", "demo-ada")).toBeNull();
  });
  it("mints sessions for built-in students only", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ token: "demo.x.y", studentId: "demo-bo", studentName: "Bo Lin", expiresAt: future(86_400_000) }), { status: 200 });
    });
    expect((await ensureDemoSession("c1", "demo-bo")).token).toBe("demo.x.y");
    expect(bodies).toEqual([{ studentId: "demo-bo" }]);
    await expect(ensureDemoSession("c1", "student-9")).rejects.toThrow("expired");
  });
  it("remembers students from demo links for the picker", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ token: "demo.l.k", studentId: "student-9", studentName: "Cai Wen", expiresAt: future(86_400_000) }), { status: 200 }),
    );
    const session = await exchangeDemoToken("c1", "demo.l.k");
    expect(session.studentId).toBe("student-9");
    expect(demoChoices("c1").map((c) => c.studentName)).toEqual(["Ada Chen", "Bo Lin", "Cai Wen"]);
    expect(selectedDemoStudent()).toBe("student-9");
  });
});
