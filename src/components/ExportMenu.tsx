import { useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { api } from "../lib/api";
import { downloadBlob } from "../lib/csv";
import { LABELS } from "../lib/labels";
import { useOptionalTeacher } from "../teacher/shell/TeacherContext";
import { Popover } from "./Popover";

/*
 * "Export ▾" menu [NM19]. Each item names a path under /api/teacher/exports/ (e.g. "grades.csv", "activity.csv",
 * "student/<id>.zip") and the page's filters; downloads go through api.downloadExport so auth headers are sent.
 */
export type ExportQueryValue = string | number | boolean | readonly string[] | null | undefined;
export interface ExportMenuItem { label: string; path: string; query?: Record<string, ExportQueryValue> }

/** Normalizes page filters: lists become comma-separated ids, booleans 1/0, empty values are dropped. */
export function exportQuery(query: Record<string, ExportQueryValue> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const list = (value as readonly string[]).map((v) => v.trim()).filter(Boolean);
      if (list.length) out[key] = list.join(",");
    } else if (typeof value === "boolean") out[key] = value ? "1" : "0";
    else if (String(value) !== "") out[key] = String(value);
  }
  return out;
}

export function ExportMenu({ items, classId, label = LABELS.exportMenu }: { items: readonly ExportMenuItem[]; classId?: string; label?: string }) {
  const teacher = useOptionalTeacher();
  const course = classId ?? teacher?.classId ?? "";
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const download = async (item: ExportMenuItem) => {
    setBusy(item.label);
    setError("");
    try {
      const file = await api.downloadExport(course, item.path, exportQuery(item.query));
      downloadBlob(file.blob, file.filename);
    } catch (e) {
      setError(`${item.label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="export-menu">
      <Popover
        role="menu"
        label={
          <>
            <Download size={15} /> {busy ? "Preparing…" : label} <ChevronDown size={14} />
          </>
        }
      >
        {(close) => (
          <ul className="menu-list">
            {items.map((item) => (
              <li key={`${item.path}:${item.label}`}>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  disabled={Boolean(busy) || !course}
                  onClick={() => {
                    close();
                    void download(item);
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Popover>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
