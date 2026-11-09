import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studentNavItems } from "./StudentApp";
import { practiceTabs, practiceTool } from "./practice/PracticePage";
import { readScratchDraft, ScratchDraftPage } from "./pages/ScratchDraftPage";

afterEach(() => vi.unstubAllGlobals());

describe("embedded Kiwi tool ownership", () => {
  it("keeps the same focused navigation for students and staff preview", () => {
    for (const base of ["/student", "/preview/student"]) {
      expect(studentNavItems(base, true).map((item) => item.href)).toEqual([
        `${base}/assignments`, `${base}/practice/settings`, `${base}/course`,
      ]);
    }
    expect(studentNavItems("/student", false).map((item) => item.href)).toContain("/student/code");
  });
  it("offers practice R only with a question and handles old chat/code bookmarks", () => {
    expect(practiceTabs(true, false).map(([id]) => id)).toEqual(["settings", "question"]);
    expect(practiceTabs(true, true).map(([id]) => id)).toEqual(["settings", "question", "code"]);
    expect(practiceTool("kiwi", true, true)).toBe("question");
    expect(practiceTool("kiwi", true, false)).toBe("settings");
    expect(practiceTool("code", true, false)).toBe("settings");
    expect(practiceTool("code", true, true)).toBe("code");
    expect(practiceTool("kiwi", false, false)).toBe("kiwi");
  });
  it("recovers only the current student's original draft without rewriting it or running R", () => {
    const getItem = vi.fn((key: string) => key === "kiwi-scratch-course-student" ? "mean(c(1, 2, 3))" : null);
    const setItem = vi.fn();
    const removeItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem, setItem, removeItem });
    const html = renderToStaticMarkup(createElement(ScratchDraftPage, { classId: "course", studentId: "student", kiwi: null }));
    expect(html).toContain("mean(c(1, 2, 3))");
    expect(html).toMatch(/readonly=""/i);
    expect(html).not.toContain("Run code");
    expect(html).toContain("does not transfer automatically");
    expect(readScratchDraft("course", "another-student")).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
});
