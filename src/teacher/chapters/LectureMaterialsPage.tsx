import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { api, hasKiwiIdentity } from "../../lib/api";
import { LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { useKiwiSync } from "../kiwi/useKiwiSync";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { Course, KiwiSyncStatus } from "../../types";

/*
 * Linked lecture materials [NM45] (TELEMETRY; moved from v0.5.1 KiwiIntegration.tsx KiwiMaterials). Status comes from the
 * shell's single KiwiSyncProvider loop; mapping calls PUT /api/teacher/kiwi/material, which records material_unit_map
 * history and never rewrites event payloads [AU-D1-M09].
 */

export function KiwiConnectionSummary({ status, error, busy, onRefresh }: { status: KiwiSyncStatus | null; error: string; busy: boolean; onRefresh?: () => void }) {
  return (
    <section className="kiwi-connection panel" aria-label="Kiwi connection">
      <div>
        <strong>{status?.connected ? "Kiwi connection" : LABELS.kiwiNotLinked}</strong>
        <p className="muted">
          {`Native Kiwi activity import is retired. ${status?.nativeEvents ?? 0} historical records are retained. Only Lab activity is collected in this version.`}
        </p>
        {status?.metadataTruncated && (
          <p className="error-text">
            This course exceeds the material or enrollment import limit. Activity history is paginated; contact your administrator to extend metadata support.
          </p>
        )}
        {(error || status?.error) && (
          <p className="error-text" role="alert">
            {error || status?.error}
          </p>
        )}
      </div>
      {onRefresh && status?.nativeSyncAvailable !== false && (
        <button className="outline-button" disabled={busy} onClick={onRefresh}>
          <RefreshCw size={15} className={busy ? "spin" : ""} />
          Refresh Kiwi activity
        </button>
      )}
    </section>
  );
}

export function LectureMaterialsView({
  course,
  status,
  busyId,
  readOnly,
  onMap,
}: {
  course: Course;
  status: KiwiSyncStatus | null;
  busyId: string;
  readOnly: boolean;
  onMap: (materialId: string, unitId: string) => void;
}) {
  return (
    <section className="panel work-panel">
      <p className="muted">
        Link a lecture to a course chapter. Its recorded reading events and Kiwi lecture AI threads then appear under that chapter. Linking never
        changes the recorded activity: page numbers and the original Kiwi records stay as they were, and every change of link is kept in a history.
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Kiwi material</th>
              <th>Course chapter</th>
              <th>Activity</th>
            </tr>
          </thead>
          <tbody>
            {status?.materials.map((m) => {
              const href = teacherPaths.activity({ group: "reading", where: "kiwi", materialId: m.id });
              return (
                <tr key={m.id}>
                  <td>{m.title}</td>
                  <td>
                    <select aria-label={`Chapter for ${m.title}`} value={m.unitId} disabled={readOnly || Boolean(busyId)} onChange={(e) => onMap(m.id, e.target.value)}>
                      <option value="">Not linked to a chapter</option>
                      {course.units.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.title}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <a
                      href={href}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(href);
                      }}
                    >
                      View {LABELS.lectureReading.toLowerCase()}
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {status && !status.materials.length && <EmptyState>No Kiwi lecture materials have been imported for this course yet.</EmptyState>}
    </section>
  );
}

export function LectureMaterialsPage(_props: TeacherPageProps) {
  const { classId, course, me } = useTeacher();
  const sync = useKiwiSync();
  const [local, setLocal] = useState<KiwiSyncStatus | null>(null);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  // WHY: a mapping response is newer than the provider's last status until the provider loads a fresh one.
  useEffect(() => setLocal(null), [sync.status]);
  const status = local ?? sync.status;
  const map = (materialId: string, unitId: string) => {
    setBusyId(materialId);
    setError("");
    api
      .mapKiwiMaterial(classId, materialId, unitId)
      .then(setLocal)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusyId(""));
  };
  if (!course) return null;
  return (
    <>
      <PageHeader title={LABELS.linkedLectureMaterials} count={status?.materials.length} tabs={<SectionTabs section="chapters" />} />
      <KiwiConnectionSummary status={status} error={error || sync.error} busy={false} onRefresh={hasKiwiIdentity() ? sync.refresh : undefined} />
      <LectureMaterialsView course={course} status={status} busyId={busyId} readOnly={!me.permissions.includes("manageCourse")} onMap={map} />
    </>
  );
}
