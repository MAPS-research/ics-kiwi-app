import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Copy, FlaskConical, ListChecks, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { formatShortDate } from "../../lib/format";
import { LABELS, questionTypeLabel } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { AiRuleScope, AiStatus, Course, Difficulty, Group, PlatformRule, PolicyConfig, PolicyLint, PolicyVersion } from "../../types";
import {
  AI_TYPES, cellLabel, CONTEXT_FIELD_OPTIONS, difficultyOptions, FIELD_LABELS, HELP_LEVEL_OPTIONS, isDirty, lintDraft, mergeLint,
  modelOptions, REASONING_OPTIONS, resetLabel, scopeFromRoute, scopeRouteId, scopeTitle, setRubricLevel, shouldConfirmSwitch,
  statusBarText, toggleContextField, toggleType, typeCheckboxLabel, UNSAVED_PROMPT, validateDraft, type RuleScope,
  type RulesOverview,
} from "./policyForm";
import { SavedChecksPanel } from "./SavedChecksPanel";
import { TestRulePanel } from "./TestRulePanel";
import { VersionHistory } from "./VersionHistory";

/*
 * AI tutor rules editor (/teacher/chapters/ai/:unitId?groupId=) [F06, F07, TH08, NM02–NM07]. One scope at a time
 * (course default or a chapter, for all students or one group). "Save as new version" appends a version; nothing is
 * changed in place. TAs and viewers see the same page read-only: every control disabled and no mutating buttons (§3.1).
 */

export interface PlatformRulesData { version: string; rules: PlatformRule[]; precedence: string[] }

type NumberKey = "maxOutputTokens" | "historyTurns";

function NumberField({
  label, value, min, max, step = 1, disabled, onChange, error,
}: { label: string; value: number; min: number; max: number; step?: number; disabled: boolean; onChange: (v: number) => void; error?: string }) {
  return (
    <label>
      {label}
      <input type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ""} disabled={disabled} aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))} />
      {error && <span className="error-text airules-field-error">{error}</span>}
    </label>
  );
}

function Check({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="checkbox-label airules-check">
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function PlatformRulesView({ platform, lint }: { platform: PlatformRulesData | null; lint: readonly PolicyLint[] }) {
  return (
    <section className="panel work-panel airules-section" aria-labelledby="platform-rules-title">
      <div className="panel-heading">
        <h2 id="platform-rules-title">
          <ShieldCheck size={17} aria-hidden="true" />
          {LABELS.platformRules}
        </h2>
        {platform && <span className="small-pill">{platform.version}</span>}
      </div>
      {platform ? (
        <>
          <ol className="airules-platform-rules">
            {platform.rules.map((rule) => (
              <li key={rule.id}>
                <strong>{rule.title}</strong> — {rule.text}
              </li>
            ))}
          </ol>
          <p className="muted">{platform.precedence.join(" ")}</p>
        </>
      ) : (
        <p className="muted">Loading platform rules…</p>
      )}
      {lint.length > 0 && (
        <ul className="airules-lint" aria-label="Rule warnings">
          {lint.map((l) => (
            <li key={`${l.field}-${l.message}`}>
              <StatusBadge tone={l.severity === "warning" ? "warning" : "info"}>{l.severity === "warning" ? "Warning" : "Note"}</StatusBadge> {l.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface AiRulesEditorViewProps {
  course: Course;
  scope: RuleScope;
  groups: readonly Group[];
  overview: RulesOverview | null;
  status: AiStatus | null;
  statusLoading?: boolean;
  platform: PlatformRulesData | null;
  scopeData: AiRuleScope | null;
  draft: PolicyConfig | null;
  onDraft: (config: PolicyConfig) => void;
  dirty: boolean;
  readOnly: boolean;
  busy: boolean;
  note: string;
  onNote: (note: string) => void;
  lint: readonly PolicyLint[];
  onScope: (next: RuleScope) => void;
  onSave: () => void;
  onReset: () => void;
  onCopy: () => void;
  onTest: () => void;
  onRunChecks: () => void;
  timeZone?: string;
  /** Test panel, saved checks and version history (containers), rendered below the form. */
  children?: ReactNode;
}

export function AiRulesEditorView(props: AiRulesEditorViewProps) {
  const { course, scope, groups, overview, status, platform, scopeData, draft, onDraft, dirty, readOnly, busy, note, onNote, lint, onScope, timeZone } = props;
  const errors = draft ? validateDraft(draft) : {};
  const hasErrors = Object.keys(errors).length > 0;
  const current = scopeData?.current ?? null;
  const ownCustomized = Boolean(current && !("inherit" in current.config));
  const effective = scopeData?.effective;
  const set = <K extends keyof PolicyConfig>(key: K, value: PolicyConfig[K]) => draft && onDraft({ ...draft, [key]: value });
  const unitCells = new Map((overview?.units ?? []).map((u) => [u.unitId, u.cells[scope.groupId] ?? u.cells[""]]));
  const courseCell = scope.groupId ? overview?.courseCells?.[scope.groupId] : overview ? { ...overview.courseDefault, updatedBy: null } : null;
  const dis = readOnly || busy;
  const diffOptions = draft ? difficultyOptions(draft.difficultyRubric) : [];
  return (
    <>
      <div className={`airules-status ${status?.configured ? "is-connected" : "is-local"}`} role="status">
        <span>{statusBarText(status, props.statusLoading)}</span>
      </div>
      <section className="panel work-panel airules-section airules-scope" aria-label="Rules scope">
        <div className="work-form-grid">
          <label>
            Chapter
            <select
              value={scopeRouteId(scope)}
              onChange={(e) => onScope(e.target.value === "course" ? { scope: "course", unitId: "", groupId: scope.groupId } : { scope: "unit", unitId: e.target.value, groupId: scope.groupId })}
            >
              <option value="course">{`Course default · ${cellLabel(courseCell ?? null, timeZone)}`}</option>
              {course.units.map((u) => (
                <option key={u.id} value={u.id}>
                  {`${u.title} · ${cellLabel(unitCells.get(u.id) ?? null, timeZone)}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Applies to
            <select value={scope.groupId} onChange={(e) => onScope({ ...scope, groupId: e.target.value })}>
              <option value="">All students</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {`${g.name} (${g.kind === "section" ? "section" : "condition"})`}
                </option>
              ))}
            </select>
          </label>
        </div>
        {effective && (
          <p className="muted airules-applies">
            {/* RV6-m18: read-only roles view the rules; they do not edit them or save versions */}
            {ownCustomized
              ? `${readOnly ? "Viewing" : "Editing"} ${effective.scopeLabel}${effective.updatedAt ? `, saved ${formatShortDate(effective.updatedAt, timeZone)}` : ""}${effective.updatedBy ? ` by ${effective.updatedBy}` : ""}${readOnly ? " (read-only)" : ""}.`
              : `${scopeTitle(scope, course, groups)} has no rules of its own. What applies now: ${effective.scopeLabel}.${readOnly ? "" : " Saving creates its own version."}`}
            {dirty && <strong className="airules-unsaved"> Unsaved changes.</strong>}
          </p>
        )}
      </section>
      <PlatformRulesView platform={platform} lint={lint} />
      {draft && (
        <section className="panel work-panel airules-section" aria-labelledby="ai-rules-form-title">
          <h2 id="ai-rules-form-title" className="airules-form-title">
            {readOnly ? "Rules (read-only)" : "Rules"}
          </h2>
          {readOnly && <p className="muted">Your role can read these rules. Only instructors can change them.</p>}
          <fieldset className="editor-fields" disabled={dis}>
            <label className="work-label">
              {LABELS.tutoringInstructions}
              <textarea rows={6} maxLength={6000} value={draft.tutoringInstructions} disabled={dis} onChange={(e) => set("tutoringInstructions", e.target.value)} />
              <span className="muted">{draft.tutoringInstructions.length.toLocaleString("en-US")} / 6,000 characters · any language</span>
            </label>
            <label className="work-label">
              {LABELS.generationInstructions}
              <textarea rows={5} maxLength={6000} value={draft.generationInstructions} disabled={dis} onChange={(e) => set("generationInstructions", e.target.value)} />
            </label>
            <label className="work-label">
              {FIELD_LABELS.groundingNotes}
              <textarea rows={3} maxLength={4000} value={draft.groundingNotes} disabled={dis} onChange={(e) => set("groundingNotes", e.target.value)} />
            </label>
            <div className="work-form-grid">
              <label>
                {FIELD_LABELS.helpLevel}
                <select value={draft.helpLevel} disabled={dis} onChange={(e) => set("helpLevel", e.target.value as PolicyConfig["helpLevel"])}>
                  {HELP_LEVEL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {FIELD_LABELS.replyLanguage}
                <input value={draft.replyLanguage} maxLength={40} disabled={dis} onChange={(e) => set("replyLanguage", e.target.value)} />
                {errors.replyLanguage && <span className="error-text airules-field-error">{errors.replyLanguage}</span>}
              </label>
            </div>
            <h3>Generated practice</h3>
            <div className="airules-grid-3">
              {(
                [
                  ["minDifficulty", LABELS.lowestDifficulty],
                  ["maxDifficulty", LABELS.highestDifficulty],
                  ["startingDifficulty", LABELS.startingDifficulty],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <select value={draft[key]} disabled={dis} onChange={(e) => set(key, Number(e.target.value) as Difficulty)}>
                    {diffOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {errors[key] && <span className="error-text airules-field-error">{errors[key]}</span>}
                </label>
              ))}
            </div>
            <details className="airules-rubric">
              <summary>{FIELD_LABELS.difficultyRubric} (labels for each level; sent to the AI)</summary>
              {([1, 2, 3, 4, 5] as Difficulty[]).map((level) => (
                <label key={level} className="work-label">
                  Level {level}
                  <input
                    aria-label={`Difficulty level ${level} description`}
                    value={draft.difficultyRubric[String(level) as keyof PolicyConfig["difficultyRubric"]]}
                    maxLength={200}
                    disabled={dis}
                    onChange={(e) => onDraft(setRubricLevel(draft, level, e.target.value))}
                  />
                </label>
              ))}
              {errors.difficultyRubric && <span className="error-text airules-field-error">{errors.difficultyRubric}</span>}
            </details>
            <fieldset className="policy-types">
              <legend>{FIELD_LABELS.allowedTypes}</legend>
              {AI_TYPES.map((type) => (
                <label key={type}>
                  <input
                    type="checkbox"
                    aria-label={typeCheckboxLabel(type)}
                    checked={draft.allowedTypes.includes(type)}
                    disabled={dis}
                    onChange={(e) => onDraft(toggleType(draft, type, e.target.checked))}
                  />
                  {questionTypeLabel(type)}
                </label>
              ))}
            </fieldset>
            {errors.allowedTypes && <span className="error-text airules-field-error">{errors.allowedTypes}</span>}
            <div className="work-form-grid">
              <label>
                {FIELD_LABELS.choiceCount}
                <select value={draft.choiceCount} disabled={dis} onChange={(e) => set("choiceCount", Number(e.target.value) as PolicyConfig["choiceCount"])}>
                  {[3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              {(
                [
                  ["maxOutputTokens", LABELS.maxReplyLength, 512, 4000, 128],
                  ["historyTurns", FIELD_LABELS.historyTurns, 2, 12, 1],
                ] as [NumberKey, string, number, number, number][]
              ).map(([key, label, min, max, step]) => (
                <NumberField key={key} label={label} value={draft[key]} min={min} max={max} step={step} disabled={dis} error={errors[key]} onChange={(v) => set(key, v)} />
              ))}
              <label>
                {FIELD_LABELS.model}
                <select value={draft.model ?? ""} disabled={dis} onChange={(e) => set("model", e.target.value || null)}>
                  {modelOptions(status).map((o) => (
                    <option key={o.value || "default"} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                  {draft.model && !(status?.modelAllowlist ?? []).includes(draft.model) && <option value={draft.model}>{draft.model}</option>}
                </select>
              </label>
              <label>
                {FIELD_LABELS.reasoningEffort}
                <select value={draft.reasoningEffort} disabled={dis} onChange={(e) => set("reasoningEffort", e.target.value as PolicyConfig["reasoningEffort"])}>
                  {REASONING_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset className="policy-types">
              <legend>{FIELD_LABELS.contextFields}</legend>
              {CONTEXT_FIELD_OPTIONS.map((o) => (
                <label key={o.value}>
                  <input
                    type="checkbox"
                    aria-label={`AI sees: ${o.label}`}
                    checked={draft.contextFields.includes(o.value)}
                    disabled={dis}
                    onChange={(e) => onDraft(toggleContextField(draft, o.value, e.target.checked))}
                  />
                  {o.label}
                </label>
              ))}
            </fieldset>
            <h3>Feedback and free practice</h3>
            <div className="work-form-grid">
              <NumberField label={FIELD_LABELS.revealAfterAttempts} value={draft.feedback.revealAfterAttempts} min={0} max={10} disabled={dis}
                error={errors.feedback} onChange={(v) => set("feedback", { ...draft.feedback, revealAfterAttempts: v })} />
              <NumberField label={FIELD_LABELS.dailyItemLimit} value={draft.practice.dailyItemLimit} min={0} max={500} disabled={dis}
                onChange={(v) => set("practice", { ...draft.practice, dailyItemLimit: v })} />
              <NumberField label={FIELD_LABELS.unlockAfterCorrect} value={draft.practice.unlockAfterCorrect} min={0} max={20} disabled={dis}
                error={errors.practice} onChange={(v) => set("practice", { ...draft.practice, unlockAfterCorrect: v })} />
            </div>
            {/* RV6-m17: one checkbox per row, each box directly before its own label */}
            <div className="airules-check-list">
              <Check label={FIELD_LABELS.showExplanationOnWrong} checked={draft.feedback.showExplanationOnWrong} disabled={dis}
                onChange={(v) => set("feedback", { ...draft.feedback, showExplanationOnWrong: v })} />
              <Check label={FIELD_LABELS.allowFocusNote} checked={draft.practice.allowFocusNote} disabled={dis}
                onChange={(v) => set("practice", { ...draft.practice, allowFocusNote: v })} />
              <Check label={FIELD_LABELS.aiTutorEnabled} checked={draft.aiTutorEnabled} disabled={dis} onChange={(v) => set("aiTutorEnabled", v)} />
              <Check label={FIELD_LABELS.generationEnabled} checked={draft.generationEnabled} disabled={dis} onChange={(v) => set("generationEnabled", v)} />
            </div>
            <label className="work-label">
              {FIELD_LABELS.localGuidance}
              <textarea rows={3} maxLength={2000} value={draft.localGuidance} disabled={dis} onChange={(e) => set("localGuidance", e.target.value)} />
            </label>
          </fieldset>
          {!readOnly && (
            <div className="airules-actions">
              <label className="work-label airules-note">
                Version note (optional)
                <input value={note} maxLength={500} onChange={(e) => onNote(e.target.value)} placeholder="What changed and why" />
              </label>
              <div className="work-actions">
                <button type="button" className="primary-button" disabled={busy || hasErrors || (!dirty && ownCustomized)} onClick={props.onSave}>
                  <Save size={16} aria-hidden="true" />
                  {LABELS.saveAsNewVersion}
                </button>
                <button type="button" className="outline-button" disabled={busy} onClick={props.onTest}>
                  <FlaskConical size={15} aria-hidden="true" />
                  {LABELS.testThisRule}
                </button>
                <button type="button" className="outline-button" disabled={busy || hasErrors} onClick={props.onRunChecks}>
                  <ListChecks size={15} aria-hidden="true" />
                  {LABELS.runSavedChecks}
                </button>
                <button type="button" className="outline-button" disabled={busy || !ownCustomized} onClick={props.onReset}>
                  <RotateCcw size={15} aria-hidden="true" />
                  {resetLabel(scope)}
                </button>
                <button type="button" className="outline-button" disabled={busy || !ownCustomized || dirty} onClick={props.onCopy}
                  title={dirty ? "Save first; copying uses the saved version" : undefined}>
                  <Copy size={15} aria-hidden="true" />
                  Copy to chapters…
                </button>
              </div>
              {hasErrors && <p className="error-text">Fix the highlighted fields before saving.</p>}
            </div>
          )}
        </section>
      )}
      {props.children}
    </>
  );
}

/** Body of the "Copy to chapters…" dialog: every other chapter (same group) plus the course default. */
export function CopyTargetsView({
  course, scope, selected, onToggle,
}: { course: Course; scope: RuleScope; selected: ReadonlySet<string>; onToggle: (unitId: string, on: boolean) => void }) {
  const options = [{ id: "course", title: "Course default" }, ...course.units.map((u) => ({ id: u.id, title: u.title }))].filter(
    (o) => o.id !== scopeRouteId(scope),
  );
  return (
    <fieldset className="policy-types airules-copy-targets">
      <legend>Copy the saved version to</legend>
      {options.map((o) => (
        <label key={o.id}>
          <input type="checkbox" aria-label={`Copy to ${o.title}`} checked={selected.has(o.id)} onChange={(e) => onToggle(o.id, e.target.checked)} />
          {o.title}
        </label>
      ))}
    </fieldset>
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function AiRulesEditorPage({ params, route }: TeacherPageProps) {
  const { classId, course, me } = useTeacher();
  const readOnly = !me.permissions.includes("manageAiRules");
  const search = route.includes("?") ? route.slice(route.indexOf("?")) : "";
  const scope = useMemo(() => scopeFromRoute(params.unitId, search, course?.currentUnitId ?? ""), [params.unitId, search, course?.currentUnitId]);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [platform, setPlatform] = useState<PlatformRulesData | null>(null);
  const [overview, setOverview] = useState<RulesOverview | null>(null);
  const [scopeData, setScopeData] = useState<AiRuleScope | null>(null);
  const [history, setHistory] = useState<PolicyVersion[]>([]);
  const [draft, setDraft] = useState<PolicyConfig | null>(null);
  const [base, setBase] = useState<PolicyConfig | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testOpen, setTestOpen] = useState(false);
  const [checksKey, setChecksKey] = useState(0);
  const [runRequest, setRunRequest] = useState(0);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyTargets, setCopyTargets] = useState<Set<string>>(new Set());
  const [resetOpen, setResetOpen] = useState(false);
  const dirty = isDirty(draft, base);

  useEffect(() => {
    let live = true;
    setStatusLoading(true);
    Promise.all([api.aiStatus(classId), api.platformRules(classId)])
      .then(([s, p]) => {
        if (!live) return;
        setStatus(s);
        setPlatform(p);
      })
      .catch((e: unknown) => live && setError(message(e)))
      .finally(() => live && setStatusLoading(false));
    return () => {
      live = false;
    };
  }, [classId]);

  const loadScope = useCallback(async () => {
    const q = { scope: scope.scope, unitId: scope.unitId, groupId: scope.groupId };
    const [view, versions, matrix] = await Promise.all([api.aiRuleScope(classId, q), api.aiRuleHistory(classId, q), api.aiRulesOverview(classId)]);
    setScopeData(view);
    setHistory(versions);
    setOverview(matrix as RulesOverview);
    setDraft(structuredClone(view.effective.config));
    setBase(structuredClone(view.effective.config));
  }, [classId, scope.scope, scope.unitId, scope.groupId]);

  useEffect(() => {
    setError("");
    setNotice("");
    setNote("");
    void loadScope().catch((e: unknown) => setError(message(e)));
  }, [loadScope]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = UNSAVED_PROMPT;
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const switchScope = (next: RuleScope) => {
    if (shouldConfirmSwitch(dirty, scope, next) && !window.confirm(UNSAVED_PROMPT)) return;
    navigate(teacherPaths.aiRulesEditor(scopeRouteId(next), next.groupId ? { groupId: next.groupId } : {}));
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api.saveAiRule(classId, {
        scope: scope.scope, unitId: scope.unitId, groupId: scope.groupId, config: draft, note: note.trim(), baseVersion: scopeData?.current?.version ?? null,
      });
      await loadScope();
      setNote("");
      setNotice(`Saved as v${saved.version}. New replies and exercises use it now.`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    setBusy(true);
    setError("");
    try {
      await api.resetAiRule(classId, { scope: scope.scope, unitId: scope.unitId, groupId: scope.groupId });
      setResetOpen(false);
      await loadScope();
      setNotice(scope.scope === "course" && !scope.groupId ? "The course default now uses the platform default rules." : "These rules now follow the broader rules.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    const current = scopeData?.current;
    if (!current || !copyTargets.size) return;
    setBusy(true);
    setError("");
    try {
      const targets = [...copyTargets].map((id) =>
        id === "course" ? { scope: "course" as const, unitId: "", groupId: scope.groupId } : { scope: "unit" as const, unitId: id, groupId: scope.groupId },
      );
      const out = await api.copyAiRule(classId, { fromVersionId: current.id, targets, note: note.trim() });
      setCopyOpen(false);
      setCopyTargets(new Set());
      setOverview((await api.aiRulesOverview(classId)) as RulesOverview);
      setNotice(`Copied to ${out.created.length} ${out.created.length === 1 ? "scope" : "scopes"} as a new version each.`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const onError = useCallback((m: string) => setError(m), []);
  if (!course) return null;
  const groups = overview?.groups ?? [];
  const unit = course.units.find((u) => u.id === scope.unitId);
  const lint = draft ? mergeLint(lintDraft(draft, scope.scope === "unit" ? unit?.runtime.packages ?? [] : null, course.units), scopeData?.lint ?? [], dirty) : [];
  return (
    <>
      <PageHeader title={LABELS.aiTutorRulesTitle} meta={scopeTitle(scope, course, groups)} tabs={<SectionTabs section="chapters" />} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="work-message" role="status">
          {notice}
        </p>
      )}
      <AiRulesEditorView
        course={course}
        scope={scope}
        groups={groups}
        overview={overview}
        status={status}
        statusLoading={statusLoading}
        platform={platform}
        scopeData={scopeData}
        draft={draft}
        onDraft={setDraft}
        dirty={dirty}
        readOnly={readOnly}
        busy={busy}
        note={note}
        onNote={setNote}
        lint={lint}
        onScope={switchScope}
        onSave={() => void save()}
        onReset={() => setResetOpen(true)}
        onCopy={() => setCopyOpen(true)}
        onTest={() => setTestOpen((v) => !v)}
        onRunChecks={() => setRunRequest((n) => n + 1)}
      >
        {!readOnly && testOpen && draft && (
          <TestRulePanel classId={classId} scope={scope} config={draft} configured={Boolean(status?.configured)} onSavedCheck={() => setChecksKey((n) => n + 1)} />
        )}
        <SavedChecksPanel
          classId={classId}
          scope={scope}
          config={draft}
          readOnly={readOnly}
          configured={Boolean(status?.configured)}
          refreshKey={checksKey}
          runRequest={runRequest}
          onError={onError}
        />
        <VersionHistory
          classId={classId}
          history={history}
          readOnly={readOnly}
          dirty={dirty}
          onError={onError}
          onRestored={(v) => {
            void loadScope().then(() => setNotice(`Restored as v${v.version}.`));
          }}
        />
      </AiRulesEditorView>
      <ConfirmDialog
        open={copyOpen}
        title="Copy to chapters…"
        confirmLabel={copyTargets.size ? `Copy to ${copyTargets.size} ${copyTargets.size === 1 ? "scope" : "scopes"}` : "Copy"}
        busy={busy}
        onCancel={() => setCopyOpen(false)}
        onConfirm={() => void copy()}
      >
        <p>Each chosen chapter gets a new version with these saved rules{scope.groupId ? " for the same group" : ""}. Their earlier versions stay in history.</p>
        <CopyTargetsView
          course={course}
          scope={scope}
          selected={copyTargets}
          onToggle={(id, on) =>
            setCopyTargets((prev) => {
              const next = new Set(prev);
              if (on) next.add(id);
              else next.delete(id);
              return next;
            })
          }
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={resetOpen}
        title={`${resetLabel(scope)}?`}
        confirmLabel={resetLabel(scope)}
        busy={busy}
        onCancel={() => setResetOpen(false)}
        onConfirm={() => void reset()}
      >
        <p>This saves a new version that hands these students back to the broader rules. You can restore the current version from the history later.</p>
      </ConfirmDialog>
    </>
  );
}
