import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import type { KiwiStaffSeen, Me, StaffMember, StaffRole } from "../../types";

/*
 * Staff & roles [F15, PEOPLE-03/18, §14.4]: Kiwi course staff who opened the Lab (effective Lab role and its source,
 * `Change Lab role ▾` creates/updates/revokes an override; disabled for your own row) and, for standalone courses, named
 * staff keys shown once.
 */

export const ROLE_LABELS: Readonly<Record<StaffRole, string>> = {
  instructor: "Instructor", ta: "Teaching assistant", viewer: "Viewer", researcher: "Researcher",
};
/** Role picker order (decision D3 adds Researcher; Kiwi never maps anyone to it automatically). */
export const ROLE_OPTIONS: readonly StaffRole[] = ["instructor", "ta", "viewer", "researcher"];
export const STAFF_ROLES_HELP =
  "Instructors can do everything; teaching assistants grade, read AI tutor rules and export activity; viewers read Insights and get de-identified exports; " +
  "researchers see Insights, read-only chapters, AI tutor rules and groups with pseudonyms only (never names or emails) and export de-identified data of consenting students.";
export function roleText(role: StaffRole | null): string {
  return role ? ROLE_LABELS[role] : "No Lab role";
}
export function kiwiRoleText(kiwiRole: string): string {
  const map: Record<string, string> = { ta: "Assistant (TA)", professor: "Instructor", admin: "Kiwi admin", instructor: "Instructor", "co-instructor": "Co-instructor" };
  return map[kiwiRole] ?? (kiwiRole || "Course staff");
}
export function sourceText(source: KiwiStaffSeen["roleSource"]): string {
  return source === "override" ? "Override" : "From Kiwi";
}

export function KiwiStaffTable({ rows, me, busy, onChange }: { rows: KiwiStaffSeen[]; me: Pick<Me, "userId">; busy: boolean; onChange: (row: KiwiStaffSeen, role: StaffRole | "kiwi") => void }) {
  if (!rows.length) return <EmptyState>No Kiwi course staff have opened CSS Lab yet. They appear here after their first visit.</EmptyState>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Kiwi user</th>
            <th>Kiwi role</th>
            <th>Lab role</th>
            <th>Source</th>
            <th>Last seen</th>
            <th>Change Lab role</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const own = row.kiwiUserId === me.userId;
            return (
              <tr key={row.kiwiUserId}>
                <td>{row.username || row.kiwiUserId}</td>
                <td>{kiwiRoleText(row.kiwiRole)}</td>
                <td>{roleText(row.effectiveRole)}</td>
                <td>
                  <StatusBadge tone={row.roleSource === "override" ? "info" : "neutral"}>{sourceText(row.roleSource)}</StatusBadge>
                </td>
                <td>{formatDateTime(row.lastSeenAt)}</td>
                <td>
                  <select
                    aria-label={`Change Lab role for ${row.username || row.kiwiUserId}`}
                    disabled={busy || own}
                    title={own ? "You cannot change your own Lab role" : undefined}
                    value={row.roleSource === "override" && row.effectiveRole ? row.effectiveRole : "kiwi"}
                    onChange={(e) => onChange(row, e.target.value as StaffRole | "kiwi")}
                  >
                    <option value="kiwi">Use Kiwi role</option>
                    {ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** SB-m14: "Make Shen a teaching assistant?" */
export function roleChangeTitle(name: string, to: string): string {
  return `Change ${name} to ${to.toLowerCase()}?`;
}

export function StaffKeyTable({ staff, me, busy, onRole, onRevoke }: { staff: StaffMember[]; me: Pick<Me, "staffId">; busy: boolean; onRole: (s: StaffMember, role: StaffRole) => void; onRevoke: (s: StaffMember) => void }) {
  const keyed = staff.filter((s) => s.keyPrefix);
  if (!keyed.length) return <EmptyState>No staff keys yet. The local instructor key (KIWI_TEACHER_KEY) stays the instructor sign-in.</EmptyState>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Key prefix</th>
            <th>Created</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {keyed.map((s) => (
            <tr key={s.id}>
              <td>{s.displayName}</td>
              <td>
                <select aria-label={`Role for ${s.displayName}`} value={s.role} disabled={busy || Boolean(s.revokedAt) || s.id === me.staffId} onChange={(e) => onRole(s, e.target.value as StaffRole)}>
                  {ROLE_OPTIONS.map((role) => (
                    <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                  ))}
                </select>
              </td>
              <td className="mono">{s.keyPrefix}…</td>
              <td>{formatDateTime(s.createdAt)}</td>
              <td>{s.revokedAt ? <StatusBadge tone="neutral">Revoked {formatDateTime(s.revokedAt)}</StatusBadge> : <StatusBadge tone="success">Active</StatusBadge>}</td>
              <td>
                {!s.revokedAt && s.id !== me.staffId && (
                  <button className="text-button" disabled={busy} onClick={() => onRevoke(s)} aria-label={`Revoke ${s.displayName}`}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StaffRolesPanel({ classId, me, linked }: { classId: string; me: Me; linked: boolean }) {
  const [data, setData] = useState<{ staff: StaffMember[]; kiwiStaff: KiwiStaffSeen[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [draft, setDraft] = useState<{ displayName: string; role: StaffRole }>({ displayName: "", role: "ta" });
  const [revoking, setRevoking] = useState<StaffMember | null>(null);
  // SB-m14: a role change (it changes what that person can do at once) is confirmed first
  const [roleChange, setRoleChange] = useState<{ name: string; from: string; to: string; apply: () => void } | null>(null);
  const load = useCallback(() => {
    api.staff(classId).then(setData).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [classId]);
  useEffect(load, [load]);
  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    setError("");
    try {
      setMessage(await work());
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const changeKiwiRole = (row: KiwiStaffSeen, role: StaffRole | "kiwi") =>
    void act(async () => {
      if (role === "kiwi") {
        if (row.overrideStaffId) await api.revokeStaff(classId, row.overrideStaffId);
        return `${row.username} now uses the Kiwi role.`;
      }
      if (row.overrideStaffId) await api.updateStaff(classId, row.overrideStaffId, { role });
      else await api.createStaff(classId, { displayName: row.username || row.kiwiUserId, role, kiwiUserId: row.kiwiUserId });
      return `${row.username} is now ${roleText(role).toLowerCase()} in CSS Lab.`;
    });
  return (
    <section className="panel work-panel focused-panel">
      <h2 className="panel-heading">Staff & roles</h2>
      <p className="muted">
        {STAFF_ROLES_HELP} Grading history and the audit log show who acted.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="work-message" role="status">
          {message}
        </p>
      )}
      {linked ? (
        <>
          <h3>Kiwi course staff</h3>
          <KiwiStaffTable rows={data?.kiwiStaff ?? []} me={me} busy={busy}
            onChange={(row, role) => setRoleChange({ name: row.username || row.kiwiUserId, from: roleText(row.effectiveRole),
              to: role === "kiwi" ? "the Kiwi role" : roleText(role), apply: () => changeKiwiRole(row, role) })} />
        </>
      ) : (
        <>
          <h3>Staff keys</h3>
          <StaffKeyTable
            staff={data?.staff ?? []}
            me={me}
            busy={busy}
            onRole={(s, role) =>
              setRoleChange({ name: s.displayName, from: roleText(s.role), to: roleText(role), apply: () =>
                void act(async () => {
                  await api.updateStaff(classId, s.id, { role });
                  return `${s.displayName} is now ${roleText(role).toLowerCase()}.`;
                }) })
            }
            onRevoke={setRevoking}
          />
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const created = await api.createStaff(classId, draft);
                if (created.key) setNewKey({ name: created.staff.displayName, key: created.key });
                setDraft({ displayName: "", role: draft.role });
                return `Added ${created.staff.displayName}.`;
              });
            }}
          >
            <label className="work-label">
              Name
              <input value={draft.displayName} maxLength={80} required onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
            </label>
            <label className="work-label">
              Role
              <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as StaffRole })}>
                <option value="ta">Teaching assistant</option>
                <option value="viewer">Viewer</option>
                <option value="researcher">Researcher</option>
                <option value="instructor">Instructor</option>
              </select>
            </label>
            <button className="primary-button" disabled={busy || !draft.displayName.trim()}>
              <Plus size={15} /> Add staff member
            </button>
          </form>
          {newKey && (
            <div className="key-notice" role="status">
              <KeyRound size={16} /> Key for {newKey.name}: <code>{newKey.key}</code>
              <p className="muted">Copy it now — it is shown only once. They sign in with it on the teacher sign-in page.</p>
              <button className="text-button" onClick={() => setNewKey(null)}>
                I copied it
              </button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={Boolean(revoking)}
        title={revoking ? `Revoke ${revoking.displayName}?` : "Revoke"}
        confirmLabel="Revoke key"
        danger
        busy={busy}
        onCancel={() => setRevoking(null)}
        onConfirm={() =>
          revoking &&
          void act(async () => {
            await api.revokeStaff(classId, revoking.id);
            setRevoking(null);
            return `Revoked ${revoking.displayName}. The key stops working immediately.`;
          })
        }
      >
        Their past grading and audit entries keep their name.
      </ConfirmDialog>
      <ConfirmDialog
        open={roleChange !== null}
        title={roleChange ? roleChangeTitle(roleChange.name, roleChange.to) : "Change role"}
        confirmLabel="Change role"
        busy={busy}
        onCancel={() => setRoleChange(null)}
        onConfirm={() => {
          const change = roleChange;
          setRoleChange(null);
          change?.apply();
        }}
      >
        {roleChange ? `${roleChange.name} changes from ${roleChange.from.toLowerCase()} to ${roleChange.to.toLowerCase()}. What they can see and do changes immediately.` : null}
      </ConfirmDialog>
    </section>
  );
}
