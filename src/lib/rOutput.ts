/*
 * Structured R output (TELEMETRY; §11.3 code_run fields, [AU-D2-M7, AU-D1-M11]). Pure helpers: webR capture entries →
 * stdout / warnings / messages / error streams, the last stdout line used for output checks, and R error hints with
 * per-chapter overrides (`UnitRuntime.errorHints`).
 */

export type RStream = "stdout" | "stderr" | "message" | "warning" | "error";
export interface REntry {
  type: RStream | string;
  text: string;
}
export interface StructuredOutput {
  stdout: string;
  stderr: string;
  messages: string[];
  warnings: string[];
  error: string;
  /** Everything in display order, as the console shows it. */
  output: string;
}

const clean = (text: string): string => text.replace(/\s+$/u, "");

export function structureOutput(entries: readonly REntry[]): StructuredOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const messages: string[] = [];
  const warnings: string[] = [];
  const shown: string[] = [];
  let error = "";
  for (const entry of entries) {
    const text = clean(String(entry.text ?? ""));
    switch (entry.type) {
      case "stdout":
        stdout.push(text);
        shown.push(text);
        break;
      case "stderr":
        stderr.push(text);
        shown.push(text);
        break;
      case "message":
        messages.push(text);
        shown.push(text);
        break;
      case "warning":
        warnings.push(text);
        shown.push(`Warning message:\n${text}`);
        break;
      case "error":
        error = text;
        shown.push(`Error: ${text}`);
        break;
      default:
        shown.push(text);
    }
  }
  return {
    stdout: stdout.join("\n").trim(),
    stderr: stderr.join("\n").trim(),
    messages,
    warnings,
    error,
    output: shown.join("\n").trim(),
  };
}

/** Last non-empty stdout line: output checks compare this, so a trailing warning or message never flips a result. */
export function lastStdoutLine(stdout: string): string {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

export interface ErrorHintRule {
  id: string;
  test: (text: string) => boolean;
  hint: string;
}

const has = (...parts: string[]) => (text: string) => parts.every((p) => text.includes(p));

export const ERROR_HINT_RULES: readonly ErrorHintRule[] = [
  { id: "object_not_found", test: has("object", "not found"), hint: "Check that the variable is defined, and verify its spelling and capitalization." },
  { id: "function_not_found", test: has("could not find function"), hint: "Check the function name, and load its package with library() first." },
  { id: "package_missing", test: has("there is no package called"), hint: "Install the package from Data files and R packages, then call library() again." },
  { id: "unexpected_symbol", test: has("unexpected"), hint: "Check parentheses, commas, and matching quotation marks near the error." },
  { id: "subscript_out_of_bounds", test: has("subscript out of bounds"), hint: "Check whether the index exceeds the vector or data frame length. R indices start at 1." },
  { id: "non_numeric", test: has("non-numeric"), hint: "Check whether the values are numeric; inspect their types with str()." },
  { id: "file_not_found", test: (t) => t.includes("cannot open") || t.includes("no such file"), hint: "Check the file name; course data files are in your working directory." },
];
export const GENERIC_HINT = {
  ruleId: "generic",
  hint: "Start with the first error line, then inspect intermediate values with print() or str(). Update the code and run again.",
};

/** Hint for an R error: chapter overrides (case-insensitive `match` substring) win over the built-in rules. */
export function errorHint(error: string, overrides: readonly { match: string; hint: string }[] = []): { ruleId: string; hint: string } {
  const text = (error || "").toLowerCase();
  const custom = overrides.findIndex((rule) => rule.match && rule.hint && text.includes(rule.match.toLowerCase()));
  if (custom >= 0) return { ruleId: `chapter:${custom}`, hint: overrides[custom].hint };
  const rule = ERROR_HINT_RULES.find((r) => r.test(text));
  return rule ? { ruleId: rule.id, hint: rule.hint } : GENERIC_HINT;
}

/** First line of an error, capped, for `hint_shown.errorExcerpt`. */
export function errorExcerpt(error: string, limit = 200): string {
  const first = (error || "").split(/\r?\n/).find((line) => line.trim()) ?? "";
  return first.trim().slice(0, limit);
}
