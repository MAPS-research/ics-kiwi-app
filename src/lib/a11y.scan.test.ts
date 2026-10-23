import { describe, expect, it } from "vitest";
import { scoreInputLabel } from "../teacher/grading/gradingKeys";
import { allowTypeLabel } from "./labels";

/*
 * INTEGRATION-02 [LY06, LY01]: static accessible-name scan over the TSX sources (read with Vite's `?raw` glob).
 * - no control is named "on" and no aria-label is built from a submission id;
 * - every <input>/<textarea>/<select> (spec: every teacher checkbox; INTEGRATION applies it to all form controls) has an
 *   aria-label / aria-labelledby, an id referenced by a <label htmlFor> in the same file, or a wrapping <label> with text
 *   (HTML implicit labelling, which gives the same accessible name);
 * - the owners' label builders produce the names the browser review checks (GRADE-07, AIRULES-09).
 */
const sources = import.meta.glob(["../**/*.tsx", "!../**/*.test.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

interface Tag { name: string; start: number; text: string; line: number }

/** Opening JSX tags `<name …>` (attribute expressions may contain `>` inside braces). */
function openingTags(source: string, name: string): Tag[] {
  const out: Tag[] = [];
  let i = source.indexOf(`<${name}`);
  while (i >= 0) {
    const after = source[i + name.length + 1] ?? "";
    if (/[A-Za-z0-9]/.test(after)) {
      i = source.indexOf(`<${name}`, i + 1);
      continue;
    }
    let depth = 0;
    let k = i + name.length + 1;
    for (; k < source.length; k++) {
      const c = source[k];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ name, start: i, text: source.slice(i, k + 1), line: source.slice(0, i).split("\n").length });
    i = source.indexOf(`<${name}`, k);
  }
  return out;
}

/** Text of the `<label>` that is still open at `index`, or null when the control is not inside a label. */
function wrappingLabel(source: string, index: number): string | null {
  const open = source.lastIndexOf("<label", index);
  if (open < 0 || source.lastIndexOf("</label>", index) > open) return null;
  const close = source.indexOf("</label>", index);
  return close < 0 ? null : source.slice(open, close);
}

/** A wrapping label names the control when it has visible text or a JSX expression besides the control itself. */
function labelHasText(label: string, control: string): boolean {
  const rest = label.replace(control, "").replace(/^<label[^>]*>/, "").replace(/<[^>]*>/g, " ");
  return /[A-Za-z]|\{[^}]+\}/.test(rest);
}

function controlProblems(source: string): string[] {
  const problems: string[] = [];
  const htmlFor = new Set([...source.matchAll(/htmlFor=\{?["'`]?([^"'`}\s>]+)/g)].map((m) => m[1]));
  for (const tag of ["input", "textarea", "select"].flatMap((name) => openingTags(source, name))) {
    if (/type=["']hidden["']/.test(tag.text)) continue;
    if (/\baria-label(ledby)?=/.test(tag.text)) continue;
    const id = /\bid=\{?["'`]?([^"'`}\s>]+)/.exec(tag.text)?.[1];
    if (id && htmlFor.has(id)) continue;
    const label = wrappingLabel(source, tag.start);
    if (label !== null && labelHasText(label, tag.text)) continue;
    problems.push(`line ${tag.line}: <${tag.name}> has no accessible name`);
  }
  return problems;
}

describe("accessible names (INTEGRATION-02)", () => {
  it("scans the TSX sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(60);
  });
  it("detects unnamed controls and accepts the three naming patterns", () => {
    expect(controlProblems('<input type="checkbox" checked={x} />')).toHaveLength(1);
    expect(controlProblems('<label><input type="checkbox" /></label>')).toHaveLength(1);
    expect(controlProblems('<label><input type="checkbox" /> Allow Multiple choice</label>')).toEqual([]);
    expect(controlProblems('<label><input type="radio" /> {LABELS.accessOpen}</label>')).toEqual([]);
    expect(controlProblems('<label htmlFor="due">Due</label><input id="due" type="date" />')).toEqual([]);
    expect(controlProblems('<input aria-label={scoreInputLabel(who)} onChange={(e) => set(e.target.value > 1)} />')).toEqual([]);
  });
  it.each(Object.entries(sources))("%s names every control and never by id", (_path, source) => {
    expect(source).not.toMatch(/aria-label=["']on["']/);
    for (const m of source.matchAll(/aria-label=\{([^}]*)\}/g)) expect(m[1], m[0]).not.toMatch(/submission\w*(\.id|Id)\b/i);
    expect(controlProblems(source)).toEqual([]);
  });
  it("label builders give the names the browser review checks (GRADE-07, AIRULES-09)", () => {
    expect(scoreInputLabel({ studentLabel: "Ada Chen", attempt: 1, questionIndex: 2 })).toBe("Score for Ada Chen, attempt 1, question 2");
    expect(allowTypeLabel("choice")).toBe("Allow Multiple choice");
    expect(allowTypeLabel("explain")).toBe("Allow Explain in words");
  });
});
