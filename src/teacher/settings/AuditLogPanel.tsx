import { useEffect, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { Pager } from "../../components/Pager";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import type { AuditEntry } from "../../types";

/* Audit log [PEOPLE-09, §14.5]: Changes (staff mutations with before/after) and Data access (profiles, exports, analytics). */

export type AuditKind = "actions" | "access";
export const AUDIT_PAGE_SIZE = 50;

export function AuditTable({ entries, kind }: { entries: AuditEntry[]; kind: AuditKind }) {
  if (!entries.length) return <EmptyState>{kind === "actions" ? "No changes recorded yet." : "No data access recorded yet."}</EmptyState>;
  return (
    <div className="table-scroll">
      <table className="data-table audit-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>{kind === "actions" ? "Action" : "Category"}</th>
            <th>{kind === "actions" ? "Target" : "Endpoint"}</th>
            <th>{kind === "actions" ? "Change" : "Details"}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={`${e.kind}-${e.id}`}>
              <td>{formatDateTime(e.createdAt)}</td>
              <td>
                {e.actorLabel}
                <small className="muted block">{e.actorRole}</small>
              </td>
              <td>{e.action}</td>
              <td className="mono">{kind === "actions" ? `${e.targetType}${e.targetId ? ` · ${e.targetId}` : ""}` : e.targetId}</td>
              <td>{e.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditLogPanel({ classId }: { classId: string }) {
  const [kind, setKind] = useState<AuditKind>("actions");
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [data, setData] = useState<{ entries: AuditEntry[]; total: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api
      .audit(classId, { kind, page: String(page), pageSize: String(AUDIT_PAGE_SIZE), action })
      .then((r) => {
        if (active) setData(r);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [classId, kind, page, action]);
  return (
    <section className="panel work-panel">
      <h2 className="panel-heading">Audit log</h2>
      <div className="table-toolbar">
        <div className="table-view-tabs" role="tablist" aria-label="Audit log views">
          {(["actions", "access"] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              className={kind === k ? "type-button selected" : "type-button"}
              onClick={() => {
                setKind(k);
                setPage(1);
                setAction("");
              }}
            >
              {k === "actions" ? "Changes" : "Data access"}
            </button>
          ))}
        </div>
        <label className="work-label">
          {kind === "actions" ? "Action" : "Category"}
          <input aria-label="Filter by action" value={action} placeholder={kind === "actions" ? "roster_update" : "export"} onChange={(e) => (setAction(e.target.value.trim()), setPage(1))} />
        </label>
      </div>
      {error && <p className="error-text">{error}</p>}
      {data && <AuditTable entries={data.entries} kind={kind} />}
      <Pager page={page} total={data?.total ?? 0} size={AUDIT_PAGE_SIZE} onPage={setPage} />
    </section>
  );
}
