import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TemplateOption } from "./CoursePackagePanel";

/*
 * B-m04: the template radio on Course settings › Course package never touches its label. `.block { display: block }`
 * (people.css) used to win over the radio label's layout, so the check below runs the CSS cascade of the app's own
 * stylesheets (in the load order of src/main.tsx) for the elements the panel renders.
 */
// WHY: vitest replaces CSS modules (also `?raw`) with empty strings, so the stylesheets are read from disk.
// ALT: `test.css: true` in vite.config.ts — avoided, it would process CSS for every test file.
const fs = (await import("node:fs" as string)) as { readFileSync(path: URL, encoding: "utf8"): string };
const ORDER = ["../../styles.css", "../../styles/assess.css", "../../styles/grade.css", "../../styles/airules.css", "../../styles/airun.css",
  "../../styles/telemetry.css", "../../styles/insights.css", "../../styles/people.css"];
const sheets: Record<string, string> = Object.fromEntries(ORDER.map((path) => [path, fs.readFileSync(new URL(path, import.meta.url), "utf8")]));

interface Rule { selector: string; decls: Record<string, string>; order: number }

/** Every style rule (top level and inside @media) as selector → declarations, in source order. */
function rules(css: string, start: number): Rule[] {
  const out: Rule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const pattern = /([^{}@]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const decls: Record<string, string> = {};
    for (const part of match[2].split(";")) {
      const colon = part.indexOf(":");
      if (colon > 0) decls[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
    }
    for (const selector of match[1].split(",")) out.push({ selector: selector.trim(), decls, order: start + out.length });
  }
  return out;
}

/** Whether a compound selector without combinators (`label.radio-label.block`) matches the element; else null. */
function specificity(selector: string, tag: string, classes: ReadonlySet<string>): number | null {
  if (!/^[a-z]*(\.[A-Za-z0-9_-]+)+$|^[a-z]+$/.test(selector)) return null;   // combinators, pseudo-classes: not this element alone
  const [name, ...parts] = selector.split(".");
  if (name && name !== tag) return null;
  if (!parts.every((c) => classes.has(c))) return null;
  return parts.length * 10 + (name ? 1 : 0);
}

/** The cascaded value of `property` for an element that matches no combinator rules (the panel's direct markup). */
function cascaded(tag: string, classNames: string, property: string): string | undefined {
  const classes = new Set(classNames.split(/\s+/));
  const all = ORDER.flatMap((path, i) => rules(sheets[path] ?? "", i * 100_000));
  let best: { spec: number; order: number; value: string } | undefined;
  for (const rule of all) {
    const value = rule.decls[property];
    if (value === undefined) continue;
    const spec = specificity(rule.selector, tag, classes);
    if (spec === null) continue;
    if (!best || spec > best.spec || (spec === best.spec && rule.order > best.order)) best = { spec, order: rule.order, value };
  }
  return best?.value;
}

describe("B-m04: template radio spacing on the Course package panel", () => {
  it("reads the app stylesheets", () => {
    for (const path of ORDER) expect(sheets[path], path).toBeTruthy();
    expect(cascaded("small", "muted block", "display")).toBe("block");   // the cascade check itself works
  });
  it("keeps a gap between the radio and its text, even with .block on the label", () => {
    const html = renderToStaticMarkup(
      <TemplateOption template={{ key: "t1", title: "SOCS-SH 190", chapters: 17, description: "Spring 2026 course." }} checked={false} onSelect={() => {}} />,
    );
    const label = /<label class="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(label.split(" ")).toContain("radio-label");
    expect(cascaded("label", label, "display")).toMatch(/^(inline-)?flex$/);
    expect(cascaded("label", label, "gap")).toMatch(/^\d+px$/);
    expect(Number.parseInt(cascaded("label", label, "gap") ?? "0", 10)).toBeGreaterThanOrEqual(6);
    // the text sits in one flex item next to the radio, so title, chapter count and description stay together
    expect(html).toMatch(/<input type="radio"[^>]*\/><span class="radio-label-text"><strong>SOCS-SH 190<\/strong> · 17 chapters<small class="muted block">Spring 2026 course\.<\/small><\/span>/);
  });
  it("leaves the other .block users and the roster radios as they were", () => {
    expect(cascaded("small", "muted block", "display")).toBe("block");
    expect(cascaded("code", "block", "display")).toBe("block");
    expect(cascaded("label", "radio-label", "display")).toBe("inline-flex");
  });
});
