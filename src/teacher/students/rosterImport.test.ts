import { describe, expect, it } from "vitest";
import { detectMapping, mappingProblem, parseCsv, parseRosterFile, toImportRows } from "./rosterImport";

describe("parseCsv (RFC 4180)", () => {
  it("handles quotes, escaped quotes, commas and newlines inside quoted cells", () => {
    const text = 'id,name\r\ns1,"Chen, Ada"\ns2,"Bo ""Bobby"" Lin"\ns3,"Line\nBreak"\n';
    expect(parseCsv(text)).toEqual([
      ["id", "name"],
      ["s1", "Chen, Ada"],
      ["s2", 'Bo "Bobby" Lin'],
      ["s3", "Line\nBreak"],
    ]);
  });
  it("strips a UTF-8 BOM, skips blank lines and detects tab or semicolon delimiters", () => {
    expect(parseCsv("﻿id\tname\ns1\tAda\n\n")).toEqual([["id", "name"], ["s1", "Ada"]]);
    expect(parseCsv("id;name\ns1;Ada")).toEqual([["id", "name"], ["s1", "Ada"]]);
  });
});

describe("header detection and mapping", () => {
  it("maps common header names to roster fields", () => {
    const parsed = parseRosterFile("Student ID,Full name,E-mail,Section,Condition,Notes\ns1,Ada Chen,ada@example.edu,Sec A,A,likes R\n");
    expect(parsed.hasHeader).toBe(true);
    expect(parsed.mapping).toEqual({ studentId: 0, name: 1, email: 2, section: 3, condition: 4 });
    expect(parsed.rows).toHaveLength(1);
  });
  it("treats a file without a header as id, name", () => {
    const parsed = parseRosterFile("s1,Ada Chen\ns2,Bo Lin\n");
    expect(parsed.hasHeader).toBe(false);
    expect(parsed.mapping).toEqual({ studentId: 0, name: 1, email: null, section: null, condition: null });
    expect(parsed.rows).toHaveLength(2);
  });
  it("detects an email-only header layout", () => {
    expect(detectMapping(["Name", "Email address"]).mapping).toEqual({ studentId: null, name: 0, email: 1, section: null, condition: null });
  });
});

describe("toImportRows", () => {
  it("never merges extra columns into names (AU-D1-M06)", () => {
    const parsed = parseRosterFile("id,name,notes,extra\ns1,Ada Chen,something,else\n");
    const rows = toImportRows(parsed.rows, parsed.mapping);
    expect(rows).toEqual([{ studentId: "s1", name: "Ada Chen" }]);
  });
  it("trims values and drops empty fields and empty lines", () => {
    const rows = toImportRows([[" s1 ", " Ada ", "", " Sec A "], ["", "", "", ""]], { studentId: 0, name: 1, email: 2, section: 3, condition: null });
    expect(rows).toEqual([{ studentId: "s1", name: "Ada", section: "Sec A" }]);
  });
  it("reports a mapping that cannot identify students", () => {
    expect(mappingProblem({ studentId: null, name: 0, email: null, section: null, condition: null }, "studentId")).toMatch(/student ID/);
    expect(mappingProblem({ studentId: null, name: 0, email: 1, section: null, condition: null }, "email")).toBe("");
    expect(mappingProblem({ studentId: null, name: 0, email: null, section: null, condition: null }, "email")).toMatch(/email/);
  });
});
