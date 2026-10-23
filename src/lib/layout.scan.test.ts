import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader } from "../components/PageHeader";

/*
 * FOUNDATION-02 [LY01]: teacher pages use <PageHeader> — no eyebrow class and no "CSS Lab activity" Kiwi banner in
 * src/teacher/**; PageHeader renders one h1 and no subtitle.
 */
const teacherSources = import.meta.glob("../teacher/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("teacher layout scan", () => {
  it("scans the teacher sources", () => {
    expect(Object.keys(teacherSources).length).toBeGreaterThan(20);
  });
  it.each(Object.entries(teacherSources))("%s has no eyebrow and no Kiwi activity banner", (_path, source) => {
    expect(source).not.toMatch(/className=["'{`][^"'}`]*\beyebrow\b/);
    expect(source).not.toContain("Open CSS Lab from your Kiwi course");
    expect(source).not.toContain("CSS Lab activity");
    expect(source).not.toContain("accent-dot");
  });
  it("renders PageHeader as one h1 without a subtitle", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, { title: "Gradebook", count: "60", actions: createElement("button", null, "Export") }),
    );
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).not.toMatch(/<p[ >]/);
    expect(html).not.toContain("subtitle");
    expect(html).not.toContain("eyebrow");
  });
});
