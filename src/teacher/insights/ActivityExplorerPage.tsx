import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { ExportMenu } from "../../components/ExportMenu";
import { FilterChips } from "../../components/FilterChips";
import { MultiSelectBar, allSelected, setAllSelected, toggleSelected } from "../../components/MultiSelectBar";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { Pager } from "../../components/Pager";
import { Popover } from "../../components/Popover";
import { api } from "../../lib/api";
import { LABELS, rowActionLabel } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { rangeQuery } from "../../lib/timeRange";
import { useKiwiRefreshRevision } from "../kiwi/useKiwiSync";
import { cohortName } from "../students/NeedsAttentionPage";
import { PurposeExport } from "../students/StudentTimelinePage";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import {
  ACTIVITY_OPTIONS, EXPLORER_GROUPS, FILTER_DEFS, ORIGIN_OPTIONS, PINNED_ACTION, QUESTION_ACTIVITY_RULE, QUESTION_TYPE_OPTIONS, WHERE_OPTIONS,
  activityExportQuery,
  answersQuery, columnPreset, columnsFor, drillDown, explorerApiQuery, explorerChips, explorerGroup, removedValue, rowTitle, storeColumnPreset,
  workOptions, type ChipNames, type ColumnPreset, type ExplorerGroup, type FilterOption,
} from "./explorerColumns";
import type { AnalyticsRow, AnalyticsTable, Course, Group, Permission, WorkOption } from "../../types";

/*
 * Activity explorer [NM21, FD02, FD06, LY02, TH10, AU-D4-08, AU-D4-M1] (§13.4): group tabs, one filter chip row,
 * `Columns ▾` Teaching / Research presets, sticky header, pinned `See details`, Export ▾ › Activity log (this view).
 * Kiwi sync never resets the view: data reloads only on Refresh or after "New activity · Refresh" [AU-D4-18].
 */

export interface ExplorerViewProps {
  course: Course;
  group: ExplorerGroup;
  values: Readonly<Record<string, string>>;
  preset: ColumnPreset;
  data: AnalyticsTable | null;
  loading: boolean;
  names: ChipNames;
  permissions: readonly Permission[];
  selected: ReadonlySet<string>;
  onSelect: (next: Set<string>) => void;
  patch: (values: Record<string, string>) => void;
  onDetails: (row: AnalyticsRow) => void;
  onAnswers: (row: AnalyticsRow) => void;
  onAddFilter: (key: string, value: string) => void;
  /** the top-bar time range limits the table (TEACHER-09) */
  ranged?: boolean;
}

function filterOptions(key: string, names: ChipNames): FilterOption[] {
  if (key === "where") return [...WHERE_OPTIONS];
  if (key === "unitId") return [...(names.course?.units.map((u) => ({ value: u.id, label: u.title })) ?? []), { value: "unattributed", label: "Not linked to a chapter" }];
  if (key === "work") return workOptions(names.assignments);
  if (key === "origin") return [...ORIGIN_OPTIONS, { value: "all", label: "All origins" }];
  if (key === "groupId") return names.groups.map((g) => ({ value: g.id, label: g.name }));
  if (key === "activity") return [...ACTIVITY_OPTIONS];
  if (key === "questionType") return [...QUESTION_TYPE_OPTIONS];
  if (key === "difficulty") return [1, 2, 3, 4, 5].map((d) => ({ value: String(d), label: String(d) }));
  if (key === "includeStaff") return [{ value: "1", label: "Yes" }];
  return [];
}

/** `+ Filter` panel: pick a filter, then a value (free text for Student, Policy version and Tag). */
export function AddFilterPanel({ preset, names, onAdd }: { preset: ColumnPreset; names: ChipNames; onAdd: (key: string, value: string) => void }) {
  const defs = FILTER_DEFS.filter((d) => preset === "research" || !d.research);
  const [key, setKey] = useState(defs[0]?.key ?? "where");
  const [value, setValue] = useState("");
  const options = filterOptions(key, names);
  return (
    <div className="add-filter-panel">
      <label>
        Filter
        <select aria-label="Filter to add" value={key} onChange={(e) => { setKey(e.target.value); setValue(""); }}>
          {defs.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Value
        {options.length ? (
          <select aria-label="Filter value" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input aria-label="Filter value" value={value} onChange={(e) => setValue(e.target.value)} placeholder={key === "studentId" ? "Student ID" : ""} />
        )}
      </label>
      <button type="button" className="primary-button" disabled={!value} onClick={() => onAdd(key, value)}>
        Add filter
      </button>
    </div>
  );
}

export function ActivityExplorerView({ course, group, values, preset, data, loading, names, permissions, selected, onSelect, patch, onDetails, onAnswers, onAddFilter, ranged = false }: ExplorerViewProps) {
  const columns = columnsFor(group, preset);
  const ctx = { course, assignmentTitle: (id: string) => names.assignments.find((a) => a.id === id)?.title ?? id,
    ranged: Boolean(values.from || values.to || ranged) };
  const chips = explorerChips(values, group, names).map((c) => ({ ...c, onRemove: () => patch({ [c.key]: removedValue(c.key, group) }) }));
  const selectable = group === "students" && permissions.includes("manageStudents");
  const rowIds = (data?.rows ?? []).map((r) => r.studentId || "").filter(Boolean);
  const sort = (key?: string) => {
    if (!key) return;
    patch({ sort: key, direction: values.sort === key && values.direction !== "asc" ? "asc" : "desc" });
  };
  const groups = EXPLORER_GROUPS.filter((g) => preset === "research" || !g.research);
  return (
    <section className="panel work-panel explorer">
      <div className="explorer-groups" role="tablist" aria-label="Group activity by">
        {groups.map((g) => (
          <button key={g.id} type="button" role="tab" aria-selected={group === g.id} className={group === g.id ? "selected" : ""} onClick={() => patch({ group: g.id, sort: "", direction: "" })}>
            {g.label}
          </button>
        ))}
      </div>
      <div className="explorer-filter-row">
        <FilterChips chips={chips} onClearAll={() => navigate(teacherPaths.activity({ group, columns: values.columns }))} />
        <Popover label="+ Filter" buttonClassName="filter-chip filter-chip-add" ariaLabel="Add a filter">
          {(close) => (
            <AddFilterPanel
              preset={preset}
              names={names}
              onAdd={(key, value) => {
                close();
                onAddFilter(key, value);
              }}
            />
          )}
        </Popover>
      </div>
      {data?.population && (
        <p className="muted explorer-population">
          {data.population.active} active of {data.population.enrolled} enrolled (learning actions) · auto-checked accuracy counts server checks on your questions only
        </p>
      )}
      <div className="table-scroll explorer-table" tabIndex={0} role="region" aria-label={`${LABELS.activityExplorer} table`}>
        <table className="data-table sticky-head">
          <thead>
            <tr>
              {selectable && (
                <th className="select-col">
                  <input type="checkbox" aria-label="Select all students on this page" checked={allSelected(selected, rowIds)} onChange={(e) => onSelect(setAllSelected(selected, rowIds, e.target.checked))} />
                </th>
              )}
              {columns.map((c) => (
                <th key={c.key} aria-sort={values.sort === c.sort && c.sort ? (values.direction === "asc" ? "ascending" : "descending") : undefined} className={c.numeric ? "num" : undefined}>
                  {c.sort ? (
                    <button type="button" onClick={() => sort(c.sort)}>
                      {c.label} {values.sort === c.sort ? (values.direction === "asc" ? "↑" : "↓") : ""}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
              <th className="pinned-col">{PINNED_ACTION}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((row, i) => {
              const answers = answersQuery(group, row);
              return (
                <tr key={row.id || `${row.studentId}:${i}`}>
                  {selectable && (
                    <td className="select-col">
                      <input type="checkbox" aria-label={`Select ${rowTitle(group, row, ctx)}`} checked={selected.has(row.studentId || "")} onChange={() => onSelect(toggleSelected(selected, row.studentId || ""))} />
                    </td>
                  )}
                  {columns.map((c, ci) => (
                    <td key={c.key} className={c.numeric ? "num" : ci === 0 ? "row-title" : c.stamp ? "stamp-cell" : undefined}>
                      {ci === 0 ? (
                        <>
                          {rowTitle(group, row, ctx)}
                          {group === "students" && row.groupNames?.length ? <small>{row.groupNames.join(", ")}</small> : null}
                        </>
                      ) : (
                        c.cell(row, ctx)
                      )}
                    </td>
                  ))}
                  <td className="pinned-col">
                    {/* K-m04: one See details per row — each names its row */}
                    <button type="button" className="text-button" aria-label={rowActionLabel(LABELS.seeDetails, rowTitle(group, row, ctx))} onClick={() => onDetails(row)}>
                      {LABELS.seeDetails}
                    </button>
                    {answers && (
                      <button type="button" className="text-button" aria-label={rowActionLabel("Answers", rowTitle(group, row, ctx))} onClick={() => onAnswers(row)}>
                        Answers
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {loading && !data && (
        <p role="status" className="empty-state">
          Loading activity…
        </p>
      )}
      {data?.total === 0 && <EmptyState>No activity matches these filters. Remove a filter or choose another time range.</EmptyState>}
      {data && <Pager page={data.page} total={data.total} size={data.pageSize} onPage={(p) => patch({ page: String(p) })} />}
      {group === "question-activities" && <p className="muted explorer-rule">{QUESTION_ACTIVITY_RULE}</p>}
    </section>
  );
}

export function ActivityExplorerPage({ route }: TeacherPageProps) {
  const { classId, course, me, timeRange } = useTeacher();
  const kiwiRevision = useKiwiRefreshRevision();
  const url = new URL(route, "http://lab.local");
  const search = url.search;
  const values = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search]);
  const group = explorerGroup(values.group);
  const preset = columnPreset(search);
  const range = rangeQuery(timeRange);
  const apiQuery = explorerApiQuery(values, group, range);
  const key = JSON.stringify(apiQuery);
  const [data, setData] = useState<AnalyticsTable | null>(null);
  const [works, setWorks] = useState<WorkOption[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    api
      .workOptions<WorkOption>(classId)
      .then((w) => {
        if (active) setWorks(w);
      })
      .catch(() => {
        if (active) setWorks([]); // WHY: the Work filter falls back to free/assigned only; the table still loads
      });
    api
      .groups(classId)
      .then((g) => {
        if (active) setGroups(g.filter((x) => !x.archived));
      })
      .catch(() => {
        if (active) setGroups([]); // WHY: groups are optional (PEOPLE); the Group filter lists none until available
      });
    return () => {
      active = false;
    };
  }, [classId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api
      .analytics(classId, JSON.parse(key) as Record<string, string>)
      .then((r) => {
        if (active) setData(r);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [classId, key, revision, kiwiRevision]);

  const patch = (v: Record<string, string>) => {
    const next: Record<string, string> = { ...values, ...v };
    if (!("page" in v)) next.page = "";
    if (v.columns) storeColumnPreset(v.columns as ColumnPreset);
    navigate(teacherPaths.activity(next), true);
  };
  if (!course) return null;
  const names: ChipNames = { course, assignments: works, groups };
  const exportQuery = activityExportQuery(values, range);
  const go = (row: AnalyticsRow) => {
    const target = drillDown(group, row, values);
    if (target.kind === "timeline") navigate(teacherPaths.studentTimeline(target.query.studentId, { from: target.query.from || undefined, to: target.query.to || undefined }));
    else if (target.kind === "questionActivity") navigate(teacherPaths.questionActivity(target.query.activityId));
    else navigate(teacherPaths.activity({ ...target.query, columns: values.columns }));
  };
  const makeCohort = async (assign: boolean) => {
    setError("");
    try {
      const created = await api.createGroup(classId, { name: cohortName(), kind: "cohort", description: "Created from the Activity explorer", studentIds: [...selected] });
      if (assign) navigate(teacherPaths.assignmentNew({ audienceGroupId: created.id }));
      else {
        setNotice(`Group “${created.name}” created with ${selected.size} students.`);
        setSelected(new Set());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <PageHeader
        title={LABELS.activityExplorer}
        count={data?.total}
        meta={timeRange.label}
        actions={
          <>
            <Popover label={`Columns: ${preset === "research" ? "Research" : "Teaching"} ▾`} ariaLabel="Column preset">
              {(close) => (
                <div className="menu-list" role="group" aria-label="Column preset">
                  {(["teaching", "research"] as const).map((p) => (
                    <button key={p} type="button" className="menu-item" aria-pressed={preset === p} onClick={() => { close(); patch({ columns: p }); }}>
                      {p === "teaching" ? "Teaching (6 columns)" : "Research (all columns and filters)"}
                    </button>
                  ))}
                </div>
              )}
            </Popover>
            {exportQuery.studentId ? (
              <PurposeExport classId={classId} query={exportQuery} />
            ) : (
              <ExportMenu
                classId={classId}
                items={[
                  { label: `${LABELS.activityLog} (this view, CSV)`, path: "activity.csv", query: exportQuery },
                  { label: `${LABELS.activityLog} (this view, JSONL)`, path: "activity.jsonl", query: exportQuery },
                ]}
              />
            )}
            <button className="icon-button" aria-label={LABELS.refresh} title={LABELS.refresh} onClick={() => setRevision((r) => r + 1)}>
              <RefreshCw size={15} />
            </button>
          </>
        }
        tabs={<SectionTabs section="insights" />}
      />
      <p className="muted page-helper">{LABELS.activityExplorerHelp}</p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success-text" role="status">
          {notice}
        </p>
      )}
      <ActivityExplorerView
        ranged={Boolean(range.from || range.to)}
        course={course}
        group={group}
        values={values}
        preset={preset}
        data={data}
        loading={loading}
        names={names}
        permissions={me.permissions}
        selected={selected}
        onSelect={setSelected}
        patch={patch}
        onDetails={go}
        onAnswers={(row) => {
          const q = answersQuery(group, row);
          if (q) navigate(teacherPaths.answers(q));
        }}
        onAddFilter={(k, v) => patch({ [k]: v })}
      />
      <MultiSelectBar
        count={selected.size}
        noun="student"
        actions={[
          { label: LABELS.createGroupFromSelected, onClick: () => void makeCohort(false) },
          { label: LABELS.assignWorkToSelected, onClick: () => void makeCohort(true), disabled: !me.permissions.includes("editAssignments") },
        ]}
        onClear={() => setSelected(new Set())}
      />
    </>
  );
}
