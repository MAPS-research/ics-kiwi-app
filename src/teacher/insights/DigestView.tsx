import { useState, type ReactNode } from "react";
import { formatDateTime } from "../../lib/format";
import { LABELS, pluralize } from "../../lib/labels";
import type { ConversationDigest, TopicRule } from "../../types";

/*
 * AI conversations › Digest [DA03, FD05, TH07, AU-D4-29] (§13.5): prompts repeated by several students, course topics,
 * replies that may contain a final answer, and recent questions — each with Open thread and Mark to re-teach.
 */

/** "Asked by 3 students · 4 times". */
export function repeatedMeta(entry: ConversationDigest["repeated"][number]): string {
  return `Asked by ${entry.students} students · ${entry.occurrences} ${entry.occurrences === 1 ? "time" : "times"}`;
}

/** Parses the topic editor text: one topic per line, `Label: keyword, keyword`. */
export function parseTopicRules(text: string): TopicRule[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(":");
      const label = colon >= 0 ? line.slice(0, colon) : line;
      const rest = colon >= 0 ? line.slice(colon + 1) : "";
      return { label: label.trim(), keywords: rest.split(",").map((k) => k.trim()).filter(Boolean) };
    });
}
export function formatTopicRules(rules: readonly TopicRule[]): string {
  return rules.map((r) => `${r.label}: ${r.keywords.join(", ")}`).join("\n");
}

export function TopicRulesEditor({ rules, onSave, saving }: { rules: readonly TopicRule[]; onSave: (rules: TopicRule[]) => void; saving: boolean }) {
  const [text, setText] = useState(formatTopicRules(rules));
  return (
    <details className="topic-rules-editor">
      <summary>Edit topics</summary>
      <p className="muted">One topic per line: “Label: keyword, keyword”. A question counts toward every topic whose keyword it contains.</p>
      <textarea aria-label="Topic rules" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      <button type="button" className="primary-button" disabled={saving} onClick={() => onSave(parseTopicRules(text))}>
        {saving ? "Saving…" : "Save topics"}
      </button>
    </details>
  );
}

/** SB-m06: "Open thread: How do I join two tables?" — repeated buttons name their item (shortened to 80 characters). */
export function itemLabel(action: string, item: string): string {
  const text = item.replace(/\s+/g, " ").trim();
  return `${action}: ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`;
}

export function DigestView({
  digest,
  canMark,
  marked,
  onMark,
  onOpen,
  topicEditor,
}: {
  digest: ConversationDigest;
  canMark: boolean;
  /** SB-m07: labels already marked to re-teach in this session */
  marked?: ReadonlySet<string>;
  onMark: (prompt: string, kind: "ai_prompt" | "topic") => void;
  onOpen: (threadKey: string) => void;
  topicEditor?: ReactNode;
}) {
  return (
    <div className="digest">
      <section className="panel work-panel digest-block" aria-labelledby="digest-repeated">
        <h2 id="digest-repeated">Repeated by several students</h2>
        {digest.repeated.length ? (
          <ul className="digest-list">
            {digest.repeated.map((r) => (
              <li key={r.prompt}>
                <p className="digest-prompt">“{r.prompt}”</p>
                <p className="muted">
                  {repeatedMeta(r)} · {r.examples.map((e) => e.studentName).join(", ")}
                </p>
                <div className="work-actions">
                  {r.examples[0] && (
                    <button type="button" className="text-button" aria-label={itemLabel("Open thread", r.prompt)} onClick={() => onOpen(r.examples[0].threadKey)}>
                      Open thread
                    </button>
                  )}
                  {canMark && (marked?.has(r.prompt) ? <span className="status-badge tone-info">Marked</span> : (
                    <button type="button" className="text-button" aria-label={itemLabel(LABELS.markToReteach, r.prompt)} onClick={() => onMark(r.prompt, "ai_prompt")}>
                      {LABELS.markToReteach}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No question was asked by two or more students in this range.</p>
        )}
      </section>
      <section className="panel work-panel digest-block" aria-labelledby="digest-topics">
        <h2 id="digest-topics">Topics</h2>
        {digest.topics.length ? (
          <ul className="digest-topics">
            {digest.topics.map((t) => (
              <li key={t.label}>
                <strong>{t.label}</strong> {pluralize(t.turns, "question")} · {pluralize(t.students, "student")}{" "}
                {canMark && (marked?.has(t.label) ? <span className="status-badge tone-info">Marked</span> : (
                  <button type="button" className="text-button" aria-label={itemLabel(LABELS.markToReteach, t.label)} onClick={() => onMark(t.label, "topic")}>
                    {LABELS.markToReteach}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No question matched the course topics in this range.</p>
        )}
        {topicEditor}
      </section>
      <section className="panel work-panel digest-block" aria-labelledby="digest-flagged">
        <h2 id="digest-flagged">Replies that may contain a final answer</h2>
        {digest.flagged.length ? (
          <ul className="digest-list">
            {digest.flagged.map((f) => (
              <li key={f.chatTurnId}>
                <p>
                  <strong>{f.studentName}</strong> · {formatDateTime(f.at)} · <span className="status-badge tone-danger">{f.reason}</span>
                </p>
                <p className="digest-prompt">{f.prompt}</p>
                <button type="button" className="text-button" aria-label={itemLabel("Open thread", `${f.studentName}: ${f.prompt}`)} onClick={() => onOpen(f.threadKey)}>
                  Open thread
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No reply was flagged in this range.</p>
        )}
      </section>
      <section className="panel work-panel digest-block" aria-labelledby="digest-recent">
        <h2 id="digest-recent">Recent questions</h2>
        {/* RT-03: long assignment labels wrap (full title on hover) and the action column stays pinned in view */}
        <div className="table-scroll">
          <table className="data-table digest-recent-table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Question</th>
                <th>Assignment / question</th>
                <th>When</th>
                <th>{LABELS.whereLabel}</th>
                <th className="pinned-col">{LABELS.seeDetails}</th>
              </tr>
            </thead>
            <tbody>
              {digest.recent.map((r, i) => (
                <tr key={`${r.threadKey}:${i}`}>
                  <td>{r.studentName}</td>
                  <td className="wrap-cell">{r.prompt}</td>
                  <td className="digest-assignment-cell" title={r.assignmentTitle || r.assignmentLabel || undefined}>{r.assignmentLabel || "—"}</td>
                  <td className="digest-when-cell">{formatDateTime(r.at)}</td>
                  <td>{r.where === "kiwi" ? LABELS.kiwiLectureAi : LABELS.labAiTutor}</td>
                  <td className="pinned-col">
                    <button type="button" className="text-button" aria-label={itemLabel("Open thread", `${r.studentName}: ${r.prompt}`)} onClick={() => onOpen(r.threadKey)}>
                      Open thread
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!digest.recent.length && <p className="muted">No AI questions in this range.</p>}
      </section>
    </div>
  );
}
