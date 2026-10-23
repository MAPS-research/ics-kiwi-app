import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import type { KiwiSyncStatus } from "../../types";

/* Kiwi connection: link state, last sync, import counts and Kiwi's chat mode on Lab pages (read-only; §14.6). */

export function kiwiConnectionLines(linked: boolean, status: KiwiSyncStatus | null): string[] {
  if (!linked) return [LABELS.kiwiNotLinked, "Open CSS Lab from the Kiwi course to link it; lecture reading and Kiwi lecture AI chats appear after linking."];
  if (!status) return ["Linked to Kiwi.", "Sync status is not available yet."];
  const lines = [
    status.connected ? "Linked to Kiwi and connected." : `Linked to Kiwi, but the bridge is not reachable${status.error ? `: ${status.error}` : "."}`,
    `Last sync: ${status.lastSynced ? formatDateTime(status.lastSynced) : "never"} · ${status.nativeEvents} Kiwi records imported`,
  ];
  if (status.excludedNotEnrolled) lines.push(`${status.excludedNotEnrolled} records of users no longer enrolled were not imported.`);
  if (status.nativeTutoringMode) lines.push(`Kiwi's own chat on Lab pages: ${status.nativeTutoringMode}${status.nativeTutoringModeSource === "class_override" ? " (course override)" : ""}.`);
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
        Names: the Lab prefers display names you import over Kiwi emails; hide emails in Privacy. The identity boundary with Kiwi is an open question for
        the Kiwi maintainers (documented in the v0.6.0 handoff).
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
