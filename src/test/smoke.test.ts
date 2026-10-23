import { describe, expect, it } from "vitest";

/*
 * FOUNDATION-16: importing navigation, the API client and every page module in node must not throw
 * (no storage, location or DOM access at import time). New pages are picked up automatically.
 */
const teacherPages = import.meta.glob("../teacher/**/*Page.tsx");
const studentPages = import.meta.glob("../student/**/*Page.tsx");
const shells = import.meta.glob([
  "../App.tsx", "../teacher/TeacherApp.tsx", "../student/StudentApp.tsx", "../teacher/shell/*.tsx", "../teacher/kiwi/*.{ts,tsx}",
  "!**/*.test.{ts,tsx}",
]);

describe("module smoke test", () => {
  it("imports navigation and the API client without side effects", async () => {
    const navigation = await import("../lib/navigation");
    const api = await import("../lib/api");
    expect(typeof navigation.getBrowserSession).toBe("function");
    expect(typeof api.api.me).toBe("function");
    expect(sessionStorage.length).toBe(0);
  });
  it("finds the page modules of the route table", () => {
    expect(Object.keys(teacherPages).length).toBeGreaterThanOrEqual(26);
    expect(Object.keys(studentPages).length).toBeGreaterThanOrEqual(6);
  });
  it.each([...Object.keys(teacherPages), ...Object.keys(studentPages), ...Object.keys(shells)])("imports %s", async (path) => {
    const loader = teacherPages[path] ?? studentPages[path] ?? shells[path];
    const mod = (await loader()) as Record<string, unknown>;
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
  it("exports a component for every route-table page", async () => {
    const { TEACHER_ROUTES } = await import("../lib/routes");
    const { TEACHER_PAGES } = await import("../teacher/TeacherApp");
    for (const route of TEACHER_ROUTES) {
      expect(typeof TEACHER_PAGES[route.id], route.id).toBe("function");
      expect(Object.keys(teacherPages)).toContain(`../${route.page}.tsx`);
    }
  });
  it("keeps the browser session lazy", async () => {
    const { getBrowserSession } = await import("../lib/navigation");
    const id = getBrowserSession();
    expect(id).toMatch(/^session-/);
    expect(getBrowserSession()).toBe(id);
    expect(sessionStorage.getItem("kiwi-lab-session")).toBe(id);
  });
});
