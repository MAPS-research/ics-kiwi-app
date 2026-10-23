import { afterEach, describe, expect, it, vi } from "vitest";
import { isTeacherReturnPath, rememberPreviewReturn, takePreviewReturn } from "./previewReturn";

/* RV6-m01: Exit preview returns to the teacher page that opened Preview as student. */

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("preview return path", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("returns to the remembered editor once, then to the fallback", () => {
    const store = memory();
    rememberPreviewReturn("/teacher/assignments/w1/edit", store);
    expect(takePreviewReturn("/teacher", store)).toBe("/teacher/assignments/w1/edit");
    expect(takePreviewReturn("/teacher", store)).toBe("/teacher");
  });
  it("accepts teacher paths only", () => {
    expect(isTeacherReturnPath("/teacher/assignments?status=draft")).toBe(true);
    expect(isTeacherReturnPath("/teacher")).toBe(true);
    for (const bad of ["https://evil.example/teacher", "//evil.example", "/student/assignments", "/teacherx", "/teacher/a b", null]) expect(isTeacherReturnPath(bad)).toBe(false);
    const store = memory();
    rememberPreviewReturn("https://evil.example", store);
    expect(takePreviewReturn("/teacher", store)).toBe("/teacher");
    store.setItem("kiwi-preview-return", "javascript:alert(1)");
    expect(takePreviewReturn("/teacher", store)).toBe("/teacher");
  });
  it("uses the tab's sessionStorage by default", () => {
    vi.stubGlobal("sessionStorage", memory());
    rememberPreviewReturn("/teacher/assignments/w2/edit");
    expect(takePreviewReturn("/teacher")).toBe("/teacher/assignments/w2/edit");
    vi.stubGlobal("sessionStorage", undefined);
    rememberPreviewReturn("/teacher/assignments");
    expect(takePreviewReturn("/teacher")).toBe("/teacher");
  });
  it("falls back when storage throws or is missing", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, removeItem: () => undefined, setItem: () => { throw new Error("blocked"); } };
    expect(() => rememberPreviewReturn("/teacher/x", broken)).not.toThrow();
    expect(takePreviewReturn("/teacher", broken)).toBe("/teacher");
    expect(takePreviewReturn("/teacher", null)).toBe("/teacher");
  });
});
