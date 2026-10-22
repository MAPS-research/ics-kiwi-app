import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, hasKiwiIdentity } from "./lib/api";
import type { Course, KiwiSyncStatus } from "./types";

export function KiwiActivityConnection({ classId, teacherKey, onState }: {
  classId: string; teacherKey: string; onState: (state: KiwiSyncStatus) => void;
}) {
  const [state, setState] = useState<KiwiSyncStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const update = (s: KiwiSyncStatus) => { if (active) { setState(s); onState(s); } };
    const sync = async () => {
      if (!active) return;
      setBusy(true);
      try {
        const s = await api.syncKiwi(classId);
        update(s);
        if (active) { setError(""); timer = setTimeout(() => void sync(), s.hasMore || s.busy ? 1200 : 30000); }
      } catch (e) {
        if (active) { setError(e instanceof Error ? e.message : String(e)); timer = setTimeout(() => void sync(), 30000); }
      } finally { if (active) setBusy(false); }
    };
    void api.kiwiStatus(classId, teacherKey).then(s => {
      update(s);
      if (hasKiwiIdentity() && s.connected) void sync();
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; clearTimeout(timer); };
  }, [classId, teacherKey, refresh, onState]);
  return <section className="kiwi-connection panel" aria-label="Kiwi activity connection">
    <div><strong>{state?.connected ? "Kiwi + CSS Lab activity" : "CSS Lab activity"}</strong>
      <p className="muted">{state?.connected
        ? `${state.lastSynced ? `Kiwi refreshed ${new Date(state.lastSynced).toLocaleString("en-US")}.` : "Kiwi activity has not been imported yet."} ${state.nativeEvents} native Kiwi events.${state.hasMore ? " Importing earlier course history…" : ""}`
        : "Open CSS Lab from your Kiwi course to include scratchpad runs, lecture reading, and AI conversations."}</p>
      {state?.connected && <small>Sources stay identifiable. Activity refreshes while this page is open.</small>}
      {state?.metadataTruncated && <p className="error-text">This course exceeds the material or enrollment import limit. Activity history is paginated; contact your administrator to extend metadata support.</p>}
      {(error || state?.error) && <p className="error-text" role="alert">{error || state?.error}</p>}
    </div>
    {hasKiwiIdentity() && <button className="outline-button" disabled={busy} onClick={() => setRefresh(n => n + 1)}><RefreshCw size={15} className={busy ? "spin" : ""} />{busy ? "Refreshing Kiwi…" : "Refresh Kiwi activity"}</button>}
  </section>;
}

export function KiwiMaterials({ classId, teacherKey, course }: { classId: string; teacherKey: string; course: Course }) {
  const [state, setState] = useState<KiwiSyncStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const onState = useCallback((s: KiwiSyncStatus) => setState(s), []);
  return <>
    <KiwiActivityConnection classId={classId} teacherKey={teacherKey} onState={onState} />
    <section className="panel work-panel"><h2>Kiwi lecture materials</h2>
      <p className="muted">Link a lecture to a course chapter. Its recorded reading events and AI threads then appear under that chapter. Page numbers and original Kiwi records remain available in each session.</p>
      {error && <p role="alert" className="error-text">{error}</p>}
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Kiwi material</th><th>Course chapter</th><th>Evidence</th></tr></thead><tbody>
        {state?.materials.map(m => <tr key={m.id}><td>{m.title}</td><td><select aria-label={`Chapter for ${m.title}`} value={m.unitId} disabled={Boolean(busy)} onChange={e => {
          setBusy(m.id); setError("");
          void api.mapKiwiMaterial(classId, teacherKey, m.id, e.target.value).then(setState).catch(err => setError(err.message)).finally(() => setBusy(""));
        }}><option value="">Not linked to a chapter</option>{course.units.map(u => <option key={u.id} value={u.id}>{u.title}</option>)}</select></td><td><a href={`/teacher/analytics/table?group=sessions&source=kiwi&materialId=${encodeURIComponent(m.id)}`}>View sessions</a></td></tr>)}
      </tbody></table></div>
      {state && !state.materials.length && <p className="empty-state">No Kiwi lecture materials have been imported for this course yet.</p>}
    </section>
  </>;
}
