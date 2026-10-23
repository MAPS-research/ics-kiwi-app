import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { MultiSelectBar, setAllSelected, toggleSelected, allSelected } from "../../components/MultiSelectBar";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { useStudentLabel } from "../../components/NameContext";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { rangeQuery } from "../../lib/timeRange";
import { AttentionRows } from "../home/AttentionList";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { AttentionItem, AttentionRule, AttentionRules } from "../../types";

/*
 * Students needing attention [AU-D4-09, TH06] (§13.2): rule results with their evidence, rules editable by instructors,
 * and actions on selected students — Create group from selected (a cohort) and Assign work to selected (cohort, then the
 * assignment editor with that audience).
 */

export const RULE_TITLES: Readonly<Record<AttentionRule["id"], string>> = {
  no_activity: "No activity",
  missing_work: "Missing work",
  stuck_question: "Stuck on a question",
  repeated_ai_help: "Repeated AI help",
  low_accuracy: "Low accuracy in this week's chapter",
  late_pattern: "Late submissions",
};
export const PARAM_LABELS: Readonly<Record<string, string>> = {
  days: "Days",
  count: "Count",
  errors: "Code errors",
  questions: "AI questions",
  pct: "Below %",
  minChecked: "Minimum checks",
};

/** Default cohort name, editable before creating: `Needs attention · 10/22`. */
export function cohortName(date: Date = new Date()): string {
  return `Needs attention · ${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

/** Accessible name of a rule parameter input: `No activity: Days`. */
export function ruleParamLabel(rule: AttentionRule["id"], param: string): string {
  return `${RULE_TITLES[rule]}: ${PARAM_LABELS[param] ?? param}`;
}

/** Immutable update of one rule. */
export function updateRule(rules: AttentionRules, id: AttentionRule["id"], patch: { enabled?: boolean; param?: [string, number] }): AttentionRules {
  return {
    rules: rules.rules.map((r) =>
      r.id !== id ? r : { ...r, enabled: patch.enabled ?? r.enabled, params: patch.param ? { ...r.params, [patch.param[0]]: patch.param[1] } : r.params },
    ),
  };
}

export function RulesEditor({ rules, editable, saving, onChange, onSave }: {
  rules: AttentionRules; editable: boolean; saving: boolean; onChange: (r: AttentionRules) => void; onSave: () => void;
}) {
  return (
    <details className="panel attention-rules">
      <summary>Attention rules</summary>
      <ul>
        {rules.rules.map((rule) => (
          <li key={rule.id} className="attention-rule">
            <label className="checkbox-label">
              <input
                type="checkbox"
                aria-label={`Use rule ${RULE_TITLES[rule.id]}`}
                checked={rule.enabled}
                disabled={!editable}
                onChange={(e) => onChange(updateRule(rules, rule.id, { enabled: e.target.checked }))}
              />
              {RULE_TITLES[rule.id]}
            </label>
            {Object.entries(rule.params).map(([param, value]) => (
              <label key={param} className="attention-param">
                {PARAM_LABELS[param] ?? param}
                <input
                  type="number"
                  min={1}
                  aria-label={ruleParamLabel(rule.id, param)}
                  value={value}
                  disabled={!editable}
                  onChange={(e) => onChange(updateRule(rules, rule.id, { param: [param, Number(e.target.value)] }))}
                />
              </label>
            ))}
          </li>
        ))}
      </ul>
      {editable && (
        <button type="button" className="primary-button" disabled={saving} onClick={onSave}>
          {saving ? "Saving…" : "Save rules"}
        </button>
      )}
    </details>
  );
}

export function NeedsAttentionPage(_props: TeacherPageProps) {
  const { classId, me, timeRange } = useTeacher();
  const label = useStudentLabel();
  const [students, setStudents] = useState<AttentionItem[] | null>(null);
  const [rules, setRules] = useState<AttentionRules | null>(null);
  const [evaluatedAt, setEvaluatedAt] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState(cohortName());
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const query = useMemo(() => rangeQuery(timeRange), [timeRange]);
  const key = JSON.stringify(query);
  const canEdit = me.permissions.includes("manageCourse");
  const canGroup = me.permissions.includes("manageStudents");

  useEffect(() => {
    let active = true;
    api
      .attention(classId, JSON.parse(key) as typeof query)
      .then((data) => {
        if (!active) return;
        setStudents(data.students);
        setRules(data.rules);
        setEvaluatedAt(data.evaluatedAt);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [classId, key, revision]);

  const ids = (students ?? []).map((s) => s.studentId);
  const createCohort = async () => {
    const name = groupName.trim() || cohortName();
    const group = await api.createGroup(classId, { name, kind: "cohort", description: "Created from Students needing attention", studentIds: [...selected] });
    return group;
  };
  const run = async (assign: boolean) => {
    setError("");
    setStatus("");
    try {
      const group = await createCohort();
      if (assign) navigate(teacherPaths.assignmentNew({ audienceGroupId: group.id }));
      else {
        setStatus(`Group “${group.name}” created with ${selected.size} students.`);
        setSelected(new Set());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const save = () => {
    if (!rules) return;
    setSaving(true);
    api
      .saveAttentionRules(classId, rules)
      .then((saved) => {
        setRules(saved);
        setRevision((r) => r + 1);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };
  return (
    <>
      <PageHeader
        title={LABELS.studentsNeedingAttention}
        count={students?.length}
        meta={`${timeRange.label}${evaluatedAt ? ` · checked ${formatDateTime(evaluatedAt)}` : ""}`}
        tabs={<SectionTabs section="students" />}
      />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="success-text" role="status">
          {status}
        </p>
      )}
      {rules && <RulesEditor rules={rules} editable={canEdit} saving={saving} onChange={setRules} onSave={save} />}
      <section className="panel work-panel">
        {students === null ? (
          <EmptyState>Checking the attention rules…</EmptyState>
        ) : (
          <>
            {students.length > 0 && canGroup && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  aria-label="Select all students needing attention"
                  checked={allSelected(selected, ids)}
                  onChange={(e) => setSelected(setAllSelected(selected, ids, e.target.checked))}
                />
                Select all
              </label>
            )}
            <AttentionRows
              students={students}
              canGrade={me.permissions.includes("grade")}
              selected={selected}
              onToggle={canGroup ? (id) => setSelected(toggleSelected(selected, id)) : undefined}
              studentLabel={(s) => label(s)}
            />
          </>
        )}
      </section>
      {canGroup && selected.size > 0 && (
        <div className="attention-group-name">
          <label>
            Group name
            <input aria-label="Name of the new group" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
          </label>
        </div>
      )}
      <MultiSelectBar
        count={canGroup ? selected.size : 0}
        noun="student"
        actions={[
          { label: LABELS.createGroupFromSelected, onClick: () => void run(false) },
          { label: LABELS.assignWorkToSelected, onClick: () => void run(true), disabled: !me.permissions.includes("editAssignments") },
        ]}
        onClear={() => setSelected(new Set())}
      />
    </>
  );
}
