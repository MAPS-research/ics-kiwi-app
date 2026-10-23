import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { ExportMenu } from "../../components/ExportMenu";
import { FilterChips } from "../../components/FilterChips";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { Popover } from "../../components/Popover";
import { api } from "../../lib/api";
import { LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { rangeQuery } from "../../lib/timeRange";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import { CodingMode } from "./CodingMode";
import { DigestView, TopicRulesEditor } from "./DigestView";
import type { ConversationDigest, Course, Group, TopicRule } from "../../types";

/*
 * AI conversations [DA03, FD05, TH07, AU-T-07] (§13.5) — Insights' first page. Digest (default) and Coding mode share
 * the global top-bar range (no page-specific default) and the Chapter (default: this week's chapter) / Group filters.
 * `Export ▾` offers AI conversations (CSV/JSONL, current filters) and Coded conversations (CSV) [TH07, INSIGHTS-22].
 */

export type ConversationMode = "digest" | "coding";
const FILTER_KEYS = ["unitId", "groupId", "studentId", "codeId", "uncoded", "flagged", "assignmentId"] as const;

/** Effective filters: the Chapter chip defaults to this week's chapter; `unitId=all` removes it. */
export function conversationFilters(values: Readonly<Record<string, string>>, course: Course | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FILTER_KEYS) if (values[key] && values[key] !== "all") out[key] = values[key];
  if (!values.unitId && course?.currentUnitId) out.unitId = course.currentUnitId;
  return out;
}

/** Export ▾ items with the page's filters (INSIGHTS-22). */
export function conversationExports(filters: Readonly<Record<string, string>>, range: { from?: string; to?: string }) {
  const query: Record<string, string> = {};
  if (filters.unitId) query.unitIds = filters.unitId;
  if (filters.groupId) query.groupIds = filters.groupId;
  for (const key of ["studentId", "codeId", "flagged", "assignmentId"] as const) if (filters[key]) query[key] = filters[key];
  if (range.from) query.from = range.from;
  if (range.to) query.to = range.to;
  return [
    { label: `${LABELS.aiConversations} (CSV)`, path: "ai-conversations.csv", query },
    { label: `${LABELS.aiConversations} (JSONL)`, path: "ai-conversations.jsonl", query },
    { label: LABELS.codedConversationsCsv, path: "conversation-codes.csv", query },
  ];
}

export function AiConversationsPage({ route }: TeacherPageProps) {
  const { classId, course, me, timeRange } = useTeacher();
  const search = new URL(route, "http://lab.local").search;
  const values = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search]);
  const mode: ConversationMode = values.mode === "coding" || values.thread ? "coding" : "digest";
  const filters = conversationFilters(values, course);
  const range = rangeQuery(timeRange);
  const query = { ...filters, ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) };
  const key = JSON.stringify(query);
  const [digest, setDigest] = useState<ConversationDigest | null>(null);
  const [rules, setRules] = useState<TopicRule[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [markedLabels, setMarkedLabels] = useState<ReadonlySet<string>>(() => new Set());
  const [revision, setRevision] = useState(0);
  const canEditTopics = me.permissions.includes("manageCourse");

  useEffect(() => {
    if (mode !== "digest") return;
    let active = true;
    setError("");
    api
      .conversationDigest(classId, JSON.parse(key) as Record<string, string>)
      .then((d) => active && setDigest(d))
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, [classId, key, mode, revision]);
  useEffect(() => {
    let active = true;
    api.groups(classId).then((g) => active && setGroups(g.filter((x) => !x.archived))).catch(() => active && setGroups([]));
    if (canEditTopics) api.topicRules(classId).then((r) => active && setRules(r)).catch(() => active && setRules(null));
    return () => {
      active = false;
    };
  }, [classId, canEditTopics]);

  const patch = (v: Record<string, string>) => navigate(teacherPaths.aiConversations({ ...values, ...v }), true);
  const open = (threadKey: string) => patch({ mode: "coding", thread: threadKey });
  const mark = (label: string, kind: "ai_prompt" | "topic") => {
    setNotice("");
    api
      .markReteach(classId, { targetKind: kind, assignmentId: "", questionId: "", unitId: filters.unitId ?? "", chatTurnId: null, label, note: "" })
      .then(() => {
        setNotice(`Added to What to re-teach: ${label}`);
        setMarkedLabels((prev) => new Set(prev).add(label));   // SB-m07: the button turns into "Marked"
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const chapterName = (id: string) => course?.units.find((u) => u.id === id)?.title ?? id;
  const chips = [
    ...(filters.unitId ? [{ key: "unitId", label: "Chapter", value: chapterName(filters.unitId), onRemove: () => patch({ unitId: "all" }) }] : []),
    ...(filters.groupId ? [{ key: "groupId", label: "Group", value: groups.find((g) => g.id === filters.groupId)?.name ?? filters.groupId, onRemove: () => patch({ groupId: "" }) }] : []),
    ...(filters.studentId ? [{ key: "studentId", label: "Student", value: filters.studentId, onRemove: () => patch({ studentId: "" }) }] : []),
    ...(filters.flagged ? [{ key: "flagged", label: "Flagged", value: "Yes", onRemove: () => patch({ flagged: "" }) }] : []),
    ...(filters.uncoded ? [{ key: "uncoded", label: "Uncoded", value: "Yes", onRemove: () => patch({ uncoded: "" }) }] : []),
    ...(filters.assignmentId ? [{ key: "assignmentId", label: "Assignment", value: filters.assignmentId, onRemove: () => patch({ assignmentId: "" }) }] : []),
  ];
  return (
    <>
      <PageHeader
        title={LABELS.aiConversations}
        meta={timeRange.label}
        actions={<ExportMenu classId={classId} items={conversationExports(filters, range)} />}
        tabs={<SectionTabs section="insights" />}
      />
      <div className="conversation-toolbar">
        <div className="segmented" role="tablist" aria-label="View">
          {(["digest", "coding"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => patch({ mode: m, thread: m === "digest" ? "" : values.thread ?? "" })}>
              {m === "digest" ? "Digest" : "Coding mode"}
            </button>
          ))}
        </div>
        <FilterChips chips={chips} />
        <Popover label="+ Filter" buttonClassName="filter-chip filter-chip-add" ariaLabel="Add a filter">
          {(close) => (
            <div className="add-filter-panel">
              <label>
                Chapter
                <select aria-label="Chapter" value={filters.unitId ?? ""} onChange={(e) => { close(); patch({ unitId: e.target.value || "all" }); }}>
                  <option value="">All chapters</option>
                  {course?.units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Group
                <select aria-label="Group" value={filters.groupId ?? ""} onChange={(e) => { close(); patch({ groupId: e.target.value }); }}>
                  <option value="">All students</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
              {mode === "coding" && (
                <>
                  <button type="button" className="text-button" onClick={() => { close(); patch({ uncoded: values.uncoded ? "" : "1" }); }}>
                    {values.uncoded ? "Show coded threads too" : "Uncoded threads only"}
                  </button>
                  <button type="button" className="text-button" onClick={() => { close(); patch({ flagged: values.flagged ? "" : "1" }); }}>
                    {values.flagged ? "All threads" : "Flagged replies only"}
                  </button>
                </>
              )}
            </div>
          )}
        </Popover>
      </div>
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
      {mode === "digest" ? (
        digest ? (
          <DigestView
            digest={digest}
            canMark={me.permissions.includes("viewStudents") && me.permissions.includes("grade")}   // SB-m11: viewers read only
            marked={markedLabels}
            onMark={mark}
            onOpen={open}
            topicEditor={
              canEditTopics && rules ? (
                <TopicRulesEditor
                  rules={rules}
                  saving={saving}
                  onSave={(next) => {
                    setSaving(true);
                    api
                      .saveTopicRules(classId, next)
                      .then((saved) => {
                        setRules(saved);
                        setRevision((r) => r + 1);
                      })
                      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setSaving(false));
                  }}
                />
              ) : undefined
            }
          />
        ) : (
          !error && <EmptyState>Loading the digest…</EmptyState>
        )
      ) : (
        <CodingMode classId={classId} filters={query} current={values.thread ?? ""} permissions={me.permissions} onOpen={open} />
      )}
    </>
  );
}
