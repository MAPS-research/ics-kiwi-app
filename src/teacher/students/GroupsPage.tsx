import { useEffect, useMemo, useState } from "react";
import { Plus, Shuffle } from "lucide-react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { pluralize } from "../../lib/labels";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { Group, GroupKind, GroupMembershipChange, RosterEntry } from "../../types";

/*
 * Groups [F14, TH16, PEOPLE-02/16]: sections, experimental conditions and cohorts (ad-hoc targeting groups).
 * A student is in at most one section and one condition; cohorts may overlap. Random assignment uses the reproducible
 * sha256-sort-v1 algorithm with a seed; every change keeps membership history (condition at event time).
 */

export const GROUP_KINDS: readonly { kind: GroupKind; label: string; help: string }[] = [
  { kind: "section", label: "Sections", help: "Class sections; each student is in at most one." },
  { kind: "condition", label: "Experimental conditions", help: "Study conditions (A/B); each student is in at most one. AI rules can differ per condition." },
  { kind: "cohort", label: "Cohorts", help: "Ad-hoc groups for targeting work (for example from Needs attention); they may overlap." },
];
export function groupKindLabel(kind: GroupKind): string {
  return kind === "section" ? "Section" : kind === "condition" ? "Condition" : "Cohort";
}
export function groupsByKind(groups: readonly Group[]): Record<GroupKind, Group[]> {
  const out: Record<GroupKind, Group[]> = { section: [], condition: [], cohort: [] };
  for (const g of groups) out[g.kind].push(g);
  return out;
}
/** "" when the selection can be randomized. */
export function randomizeProblem(groups: readonly Group[], selectedIds: readonly string[], seed: string): string {
  const chosen = groups.filter((g) => selectedIds.includes(g.id));
  if (chosen.length < 2) return "Choose at least two groups.";
  if (new Set(chosen.map((g) => g.kind)).size > 1) return "Choose groups of one kind.";
  if (chosen.some((g) => g.kind === "cohort")) return "Random assignment works with sections or conditions.";
  if (!seed.trim() || seed.trim().length > 64) return "Enter a seed (1–64 characters) so the assignment can be reproduced.";
  return "";
}

export function GroupsView({
  groups, canManage, onMembers, onRename, onArchive,
}: {
  groups: Group[];
  canManage: boolean;
  onMembers: (g: Group) => void;
  onRename: (g: Group) => void;
  onArchive: (g: Group) => void;
}) {
  const byKind = groupsByKind(groups);
  return (
    <>
      {GROUP_KINDS.map(({ kind, label, help }) => (
        <section key={kind} className="panel work-panel">
          <h2 className="panel-heading">{label}</h2>
          <p className="muted">{help}</p>
          {byKind[kind].length ? (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Members</th>
                    <th>Description</th>
                    {canManage && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {byKind[kind].map((g) => (
                    <tr key={g.id}>
                      <td>
                        <strong>{g.name}</strong>
                      </td>
                      <td>{pluralize(g.members, "student")}</td>
                      <td>{g.description || "—"}</td>
                      {canManage && (
                        <td className="row-actions">
                          {/* K-m04: each group's buttons name the group */}
                          <button className="text-button" aria-label={`Members of ${g.name}`} onClick={() => onMembers(g)}>
                            Members
                          </button>
                          <button className="text-button" aria-label={`Rename ${g.name}`} onClick={() => onRename(g)}>
                            Rename
                          </button>
                          <button className="text-button" aria-label={`Archive ${g.name}`} onClick={() => onArchive(g)}>
                            Archive
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No {label.toLowerCase()} yet.</EmptyState>
          )}
        </section>
      ))}
    </>
  );
}

export function MembersEditor({ group, students, chosen, onToggle }: { group: Group; students: RosterEntry[]; chosen: ReadonlySet<string>; onToggle: (id: string) => void }) {
  return (
    <div className="members-editor">
      <p className="muted">
        {group.kind === "cohort"
          ? "Students may belong to several cohorts."
          : `A student moved here leaves their previous ${group.kind}. History is kept for analyses.`}
      </p>
      <ul className="checkbox-list">
        {students.map((s) => (
          <li key={s.studentId}>
            <label className="checkbox-label">
              <input type="checkbox" checked={chosen.has(s.studentId)} onChange={() => onToggle(s.studentId)} aria-label={`Include ${s.studentName} in ${group.name}`} />
              {s.studentName} <small className="muted">{s.groups.filter((g) => g.kind === group.kind && g.groupId !== group.id).map((g) => g.name).join(", ")}</small>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HistoryTable({ changes, labels }: { changes: GroupMembershipChange[]; labels: Record<string, string> }) {
  if (!changes.length) return <EmptyState>No membership changes recorded.</EmptyState>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Student</th>
            <th>Kind</th>
            <th>Group</th>
            <th>How</th>
            <th>From</th>
            <th>Until</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c, i) => (
            <tr key={`${c.studentId}-${c.groupId}-${c.validFrom}-${i}`}>
              <td>{labels[c.studentId] ?? c.studentName ?? c.studentId}</td>
              <td>{groupKindLabel(c.kind)}</td>
              <td>{c.groupName}</td>
              <td>
                {c.method}
                {c.seed ? ` (seed ${c.seed})` : ""}
              </td>
              <td>{formatDateTime(c.validFrom)}</td>
              <td>{c.validTo ? formatDateTime(c.validTo) : "current"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function allStudents(classId: string): Promise<RosterEntry[]> {
  const out: RosterEntry[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await api.roster(classId, { page: String(page), pageSize: "100", status: "active" });
    out.push(...r.students);
    if (out.length >= r.total || !r.students.length) break;
  }
  return out;
}

export function GroupsPage(_props: TeacherPageProps) {
  const { classId, me, nameMode } = useTeacher();
  const canManage = me.permissions.includes("manageStudents");
  // Decision D3: a researcher reads Groups without the roster (history rows carry pseudonymous labels).
  const canReadRoster = me.permissions.includes("viewStudents");
  const [groups, setGroups] = useState<Group[]>([]);
  const [students, setStudents] = useState<RosterEntry[]>([]);
  const [history, setHistory] = useState<GroupMembershipChange[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ name: string; kind: GroupKind; description: string }>({ name: "", kind: "section", description: "" });
  const [editing, setEditing] = useState<Group | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ group: Group; name: string } | null>(null);
  const [archiving, setArchiving] = useState<Group | null>(null);
  const [randomIds, setRandomIds] = useState<string[]>([]);
  const [seed, setSeed] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [randomResult, setRandomResult] = useState<{ assignments: { studentId: string; groupId: string }[]; seed: string; algorithm: string } | null>(null);
  const labels = useMemo(() => Object.fromEntries(students.map((s) => [s.studentId, s.studentName])), [students]);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  useEffect(() => {
    api.groups(classId).then(setGroups).catch(fail);
    if (canReadRoster) allStudents(classId).then(setStudents).catch(fail);
    api.groupHistory(classId, {}).then((h) => setHistory(h.slice(-200).reverse())).catch(fail);
  }, [classId, revision, nameMode, canReadRoster]);

  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    setError("");
    try {
      setMessage(await work());
      setRevision((r) => r + 1);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const problem = randomizeProblem(groups, randomIds, seed);
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id;

  return (
    <>
      <PageHeader title="Groups" count={groups.length} tabs={<SectionTabs section="students" />} />
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
      {canManage && (
        <section className="panel work-panel">
          <h2 className="panel-heading">New group</h2>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const g = await api.createGroup(classId, draft);
                setDraft({ ...draft, name: "", description: "" });
                return `Created ${groupKindLabel(g.kind).toLowerCase()} ${g.name}.`;
              });
            }}
          >
            <label className="work-label">
              Name
              <input value={draft.name} maxLength={80} required onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="work-label">
              Kind
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as GroupKind })}>
                <option value="section">Section</option>
                <option value="condition">Experimental condition</option>
                <option value="cohort">Cohort</option>
              </select>
            </label>
            <label className="work-label">
              Description
              <input value={draft.description} maxLength={500} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </label>
            <button className="primary-button" disabled={busy || !draft.name.trim()}>
              <Plus size={15} /> Create group
            </button>
          </form>
        </section>
      )}
      <GroupsView
        groups={groups}
        canManage={canManage}
        onMembers={(g) => {
          setEditing(g);
          setChosen(new Set(students.filter((s) => s.groups.some((x) => x.groupId === g.id)).map((s) => s.studentId)));
        }}
        onRename={(g) => setRenaming({ group: g, name: g.name })}
        onArchive={setArchiving}
      />
      {canManage && (
        <section className="panel work-panel">
          <h2 className="panel-heading">
            <Shuffle size={16} /> Randomly assign to groups
          </h2>
          <p className="muted">
            Students are sorted by sha256(seed:studentId) and dealt round-robin to the chosen groups (sizes differ by at most one). The same seed and the
            same students always give the same assignment. Without overwrite, only students without a group of that kind are assigned.
          </p>
          <div className="checkbox-row" role="group" aria-label="Groups to assign">
            {groups
              .filter((g) => g.kind !== "cohort")
              .map((g) => (
                <label key={g.id} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={randomIds.includes(g.id)}
                    onChange={(e) => setRandomIds((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((x) => x !== g.id)))}
                  />
                  {g.name} ({groupKindLabel(g.kind)})
                </label>
              ))}
          </div>
          <div className="inline-form">
            <label className="work-label">
              Seed
              <input value={seed} maxLength={64} placeholder="css190-f26" onChange={(e) => setSeed(e.target.value)} />
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Re-assign students who already have a group
            </label>
            <button
              className="primary-button"
              disabled={busy || Boolean(problem)}
              onClick={() =>
                void act(async () => {
                  const r = await api.randomizeGroups(classId, { groupIds: randomIds, seed: seed.trim(), overwrite });
                  setRandomResult(r);
                  return `Assigned ${pluralize(r.assignments.length, "student")} with seed ${r.seed}.`;
                })
              }
            >
              Assign
            </button>
          </div>
          {problem && <p className="muted">{problem}</p>}
          {randomResult && (
            <ul className="link-list">
              {randomResult.assignments.map((a) => (
                <li key={a.studentId}>
                  {labels[a.studentId] ?? a.studentId} → {groupName(a.groupId)}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="panel work-panel">
        <h2 className="panel-heading">Membership history</h2>
        <HistoryTable changes={history} labels={labels} />
      </section>
      <ConfirmDialog
        open={Boolean(editing)}
        title={editing ? `Members of ${editing.name}` : "Members"}
        confirmLabel="Save members"
        busy={busy}
        onCancel={() => setEditing(null)}
        onConfirm={() =>
          editing &&
          void act(async () => {
            const g = await api.setGroupMembers(classId, editing.id, [...chosen]);
            setEditing(null);
            return `${g.name} now has ${pluralize(g.members, "student")}.`;
          })
        }
      >
        {editing && (
          <MembersEditor
            group={editing}
            students={students}
            chosen={chosen}
            onToggle={(id) =>
              setChosen((s) => {
                const next = new Set(s);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          />
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={Boolean(renaming)}
        title="Rename group"
        confirmLabel="Save"
        busy={busy}
        onCancel={() => setRenaming(null)}
        onConfirm={() =>
          renaming &&
          void act(async () => {
            const g = await api.updateGroup(classId, renaming.group.id, { name: renaming.name });
            setRenaming(null);
            return `Renamed to ${g.name}.`;
          })
        }
      >
        {renaming && (
          <label className="work-label">
            Name
            <input value={renaming.name} maxLength={80} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
          </label>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={Boolean(archiving)}
        title={archiving ? `Archive ${archiving.name}?` : "Archive group"}
        confirmLabel="Archive"
        danger
        busy={busy}
        onCancel={() => setArchiving(null)}
        onConfirm={() =>
          archiving &&
          void act(async () => {
            await api.archiveGroup(classId, archiving.id);
            setArchiving(null);
            return `Archived ${archiving.name}. Its history stays in exports.`;
          })
        }
      >
        Members leave the group now; past events keep the group they had at the time.
      </ConfirmDialog>
    </>
  );
}
