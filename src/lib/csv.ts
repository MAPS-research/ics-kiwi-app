/*
 * Teaching CSV export helpers (KEEP: formula neutralization + UTF-8 BOM, extended per §13.6). Frozen after FOUNDATION.
 * Research files are written by the server without neutralization; these helpers are for teacher-facing CSVs only.
 */

const FULL_WIDTH_SIGNS: Readonly<Record<string, string>> = { "＝": "=", "＋": "+", "－": "-", "＠": "@" };
const NUMERIC = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;

/**
 * True when a spreadsheet could read the text as a formula: the first non-whitespace character (after leading
 * spaces/tabs, with full-width ＝＋－＠ normalized) is = + - @, or the leading whitespace contains a tab or CR.
 */
export function needsNeutralization(text: string): boolean {
  const lead = /^[\s　]*/.exec(text)?.[0] ?? "";
  if (/[\t\r]/.test(lead)) return true;
  const first = text.charAt(lead.length);
  if (!first) return false;
  return "=+-@".includes(FULL_WIDTH_SIGNS[first] ?? first);
}

/** One RFC 4180 cell, always quoted. Numbers (or numeric text in a numeric column) are never prefixed. */
export function csvCell(value: unknown, opts: { numeric?: boolean } = {}): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (typeof value === "number") text = Number.isFinite(value) ? String(value) : "";
  else text = String(value);
  const isNumber = typeof value === "number" || (opts.numeric === true && NUMERIC.test(text.trim()));
  if (!isNumber && needsNeutralization(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** CSV text with a UTF-8 BOM and CRLF line endings. `numericColumns` are column indexes whose numeric text stays numeric. */
export function toCsv(rows: readonly (readonly unknown[])[], opts: { bom?: boolean; numericColumns?: readonly number[] } = {}): string {
  const numeric = new Set(opts.numericColumns ?? []);
  const body = rows.map((row) => row.map((cell, i) => csvCell(cell, { numeric: numeric.has(i) })).join(",")).join("\r\n");
  return (opts.bom === false ? "" : "﻿") + body;
}

export function csvBlob(text: string): Blob {
  return new Blob([text], { type: "text/csv;charset=utf-8" });
}

/** Saves a Blob through a temporary object URL (authenticated downloads use api.requestBlob first). */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function")
    throw new Error("Downloads are only available in a browser.");
  const href = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // WHY: revoke on the next tick so the click has started reading the blob first.
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }
}
