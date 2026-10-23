import type { RosterImportRow } from "../../types";

/*
 * Roster import parsing [AU-D1-M06, PEOPLE-10]: RFC 4180 CSV (quotes, escaped quotes, embedded commas/newlines), BOM,
 * tab/semicolon detection, header → field mapping. Extra columns are ignored — never merged into names.
 */

export type RosterField = "studentId" | "name" | "email" | "section" | "condition";
export type RosterMapping = Record<RosterField, number | null>;
export const ROSTER_FIELDS: readonly { field: RosterField; label: string }[] = [
  { field: "studentId", label: "Student ID" },
  { field: "name", label: "Name" },
  { field: "email", label: "Email" },
  { field: "section", label: "Section" },
  { field: "condition", label: "Condition" },
];

const HEADER_ALIASES: Readonly<Record<RosterField, readonly string[]>> = {
  studentId: ["studentid", "student id", "id", "user id", "userid", "kiwi id", "kiwi user id", "student number", "netid", "uid"],
  name: ["name", "student name", "full name", "fullname", "display name", "student"],
  email: ["email", "e-mail", "email address", "e-mail address", "mail", "kiwi email"],
  section: ["section", "class section", "lab section"],
  condition: ["condition", "experimental condition", "arm", "group"],
};

function detectDelimiter(firstLine: string): string {
  const counts = [",", "\t", ";"].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ",";
}

/** Parses delimited text into rows of cells; blank lines are dropped. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const norm = (value: string) => value.trim().toLowerCase().replace(/[_.]+/g, " ").replace(/\s+/g, " ");

/** Maps header cells to roster fields; `hasHeader` is true when at least one known header name was found. */
export function detectMapping(header: readonly string[]): { mapping: RosterMapping; hasHeader: boolean } {
  const mapping: RosterMapping = { studentId: null, name: null, email: null, section: null, condition: null };
  header.forEach((cell, index) => {
    const name = norm(cell);
    for (const field of Object.keys(HEADER_ALIASES) as RosterField[]) {
      if (mapping[field] === null && HEADER_ALIASES[field].includes(name)) {
        mapping[field] = index;
        return;
      }
    }
  });
  const hasHeader = Object.values(mapping).some((v) => v !== null);
  return { mapping, hasHeader };
}

export interface ParsedRoster { header: string[]; rows: string[][]; mapping: RosterMapping; hasHeader: boolean }

/** A whole file: header detection, else the v0.5.1 layout "id, name". */
export function parseRosterFile(text: string): ParsedRoster {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], rows: [], mapping: { studentId: null, name: null, email: null, section: null, condition: null }, hasHeader: false };
  const detected = detectMapping(rows[0]);
  if (detected.hasHeader) return { header: rows[0], rows: rows.slice(1), mapping: detected.mapping, hasHeader: true };
  const width = rows[0].length;
  const header = Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  return { header, rows, mapping: { studentId: 0, name: width > 1 ? 1 : null, email: null, section: null, condition: null }, hasHeader: false };
}

/** Rows for POST /api/teacher/roster/import: only mapped columns, trimmed, empty values dropped. */
export function toImportRows(rows: readonly (readonly string[])[], mapping: RosterMapping): RosterImportRow[] {
  const out: RosterImportRow[] = [];
  for (const row of rows) {
    const entry: RosterImportRow = {};
    for (const { field } of ROSTER_FIELDS) {
      const index = mapping[field];
      if (index === null || index === undefined) continue;
      const value = (row[index] ?? "").trim();
      if (value) entry[field] = value;
    }
    if (Object.keys(entry).length) out.push(entry);
  }
  return out;
}

/** "" when the mapping can identify students for the chosen match mode. */
export function mappingProblem(mapping: RosterMapping, matchBy: "studentId" | "email"): string {
  if (matchBy === "studentId" && mapping.studentId === null) return "Choose the column that holds the student ID.";
  if (matchBy === "email" && mapping.email === null) return "Choose the column that holds the email address.";
  return "";
}
