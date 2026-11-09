import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import type { KiwiSyncStatus } from "../../types";

/* Kiwi connection: link state, last sync, import counts and Kiwi's chat mode on Lab pages (read-only; §14.6). */

export function kiwiConnectionLines(linked: boolean, status: KiwiSyncStatus | null): string[] {
  if (!linked) return [LABELS.kiwiNotLinked, "Open CSS Lab from a Kiwi course to use its approved AI prompt. Standalone practice uses local templates."];
  if (!status) return ["Linked to Kiwi.", "Connection status is not available yet."];
  const lines = [
    "Kiwi app identity uses the host's public signing keys. AI uses an approved Kiwi prompt.",
    "The official App API does not provide a class roster or native activity feed. New activity here comes from the Lab.",
    `Historical import: ${status.lastSynced ? formatDateTime(status.lastSynced) : "none"} · ${status.nativeEvents} retained records. Import is disabled.`,
  ];
  if (status.excludedNotEnrolled) lines.push(`${status.excludedNotEnrolled} records of users no longer enrolled were not imported.`);
  if (status.nativeTutoringMode) lines.push(`Historical host chat setting (not a live SDK capability): ${status.nativeTutoringMode}${status.nativeTutoringModeSource === "class_override" ? " (course override)" : ""}.`);
  return lines;
}

export function KiwiConnectionPanel({ classId, linked }: { classId: string; linked: boolean }) {
  const [status, setStatus] = useState<KiwiSyncStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!linked) return;
    api.kiwiStatus(classId).then(setStatus).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [classId, linked]);
  return (
    <section className="panel work-panel focused-panel">
      <h2 className="panel-heading">Kiwi connection</h2>
      {kiwiConnectionLines(linked, status).map((line) => (
        <p key={line}>{line}</p>
      ))}
      {error && <p className="error-text">{error}</p>}
      <p className="muted">
        Kiwi students appear by App-local labels and opaque IDs. The Lab does not fetch names, emails or a class roster from Kiwi.
      </p>
      <div className="work-actions">
        <button className="outline-button" onClick={() => navigate(teacherPaths.lectureMaterials())}>
          {LABELS.linkedLectureMaterials}
        </button>
        <button className="outline-button" onClick={() => navigate(teacherPaths.dataHealth())}>
          {LABELS.dataHealth}
        </button>
      </div>
    </section>
  );
}
