import { describe, expect, it } from "vitest";
import { errorExcerpt, errorHint, lastStdoutLine, structureOutput } from "./rOutput";

describe("structured R output (AU-D2-M7, TELEMETRY-05)", () => {
  it("separates stdout, warnings, messages and the error, keeping display order", () => {
    const out = structureOutput([
      { type: "stdout", text: "[1] 82.66667" },
      { type: "warning", text: "NAs introduced by coercion" },
      { type: "message", text: "Loading data\n" },
      { type: "stdout", text: "[1] NA" },
      { type: "error", text: "object 'x' not found" },
    ]);
    expect(out.stdout).toBe("[1] 82.66667\n[1] NA");
    expect(out.warnings).toEqual(["NAs introduced by coercion"]);
    expect(out.messages).toEqual(["Loading data"]);
    expect(out.error).toBe("object 'x' not found");
    expect(out.output).toBe("[1] 82.66667\nWarning message:\nNAs introduced by coercion\nLoading data\n[1] NA\nError: object 'x' not found");
  });

  it("the last stdout line ignores trailing warnings and blank lines", () => {
    const out = structureOutput([{ type: "stdout", text: "[1] 1\n[1] 5\n" }, { type: "warning", text: "late warning" }]);
    expect(lastStdoutLine(out.stdout)).toBe("[1] 5");
    expect(lastStdoutLine("")).toBe("");
  });
});

describe("error hints with chapter overrides (AU-D1-M11)", () => {
  it("uses built-in rules with stable rule ids", () => {
    expect(errorHint("object 'scores' not found")).toMatchObject({ ruleId: "object_not_found" });
    expect(errorHint('could not find function "left_join"').ruleId).toBe("function_not_found");
    expect(errorHint("there is no package called 'dplyr'").ruleId).toBe("package_missing");
    expect(errorHint("something odd").ruleId).toBe("generic");
  });
  it("chapter overrides win, matched case-insensitively", () => {
    const rules = [{ match: "LEFT_JOIN", hint: "Load dplyr first: library(dplyr)." }];
    expect(errorHint('could not find function "left_join"', rules)).toEqual({ ruleId: "chapter:0", hint: "Load dplyr first: library(dplyr)." });
    expect(errorHint("object 'x' not found", rules).ruleId).toBe("object_not_found");
  });
  it("excerpts the first error line", () => {
    expect(errorExcerpt("\nError in f(): boom\n  at line 2")).toBe("Error in f(): boom");
    expect(errorExcerpt("x".repeat(500))).toHaveLength(200);
  });
});
