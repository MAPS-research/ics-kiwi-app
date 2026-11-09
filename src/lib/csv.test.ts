import { describe, expect, it } from "vitest";
import { csvCell, needsNeutralization, toCsv } from "./csv";

describe("formula neutralization (KEEP, extended in §13.6)", () => {
  it.each([
    ["=SUM(A1:A2)", true],
    ["+1", true],
    ["-1+2", true],
    ["@cmd", true],
    ["\t=1", true],
    ["\rabc", true],
    ["  =HYPERLINK(\"x\")", true],
    [" \t+1", true],
    ["＝1+1", true],
    ["＋1", true],
    ["－1", true],
    ["＠x", true],
    ["　=1", true],
    ["plain text", false],
    ["a=b", false],
    ["", false],
    ["   ", false],
    ["Ada Chen", false],
  ])("%j → %s", (text, expected) => {
    expect(needsNeutralization(text)).toBe(expected);
  });
  it("prefixes risky text and doubles quotes", () => {
    expect(csvCell("=1+1")).toBe('"\'=1+1"');
    expect(csvCell("  -2")).toBe('"\'  -2"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });
  it("keeps numbers numeric", () => {
    expect(csvCell(-3)).toBe('"-3"');
    expect(csvCell(Number.NaN)).toBe('""');
    expect(csvCell("-3", { numeric: true })).toBe('"-3"');
    expect(csvCell("-3")).toBe('"\'-3"');
    expect(csvCell("-3 apples", { numeric: true })).toBe('"\'-3 apples"');
  });
});

describe("toCsv", () => {
  it("writes a UTF-8 BOM and CRLF rows", () => {
    const text = toCsv([["Student", "Score"], ["Ada", 18], ["=evil", "-2"]], { numericColumns: [1] });
    expect(text.startsWith("﻿")).toBe(true);
    expect(text.slice(1).split("\r\n")).toEqual(['"Student","Score"', '"Ada","18"', '"\'=evil","-2"']);
  });
  it("can omit the BOM", () => {
    expect(toCsv([["a"]], { bom: false })).toBe('"a"');
  });
});
