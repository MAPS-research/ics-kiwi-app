import { useEffect, useState, type ReactNode } from "react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { displayTimeZone, formatDateTime, formatShortDate } from "../../lib/format";
import { LABELS } from "../../lib/labels";
import { useKiwiRefreshRevision } from "../kiwi/useKiwiSync";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { DataHealth, OutagePeriod } from "../../types";

/*
 * Data health (TELEMETRY; §13.10, TELEMETRY-16/20, [DA05, AU-D3-M02]): what the server received, ignored, truncated or
 * rejected for the selected time range, Lab AI tutor turns vs analytics events, AI requests turned away or failed,
 * heartbeat accounting, identity and preview traffic, client contract drift, legacy auto-checks, outage periods and
 * the Kiwi import status (incl. records excluded by design and students no longer enrolled).
 */

// RT-07: the outage times use the course zone (as their date does) when the caller passes none
const hhmm = (iso: string, timeZone?: string): string =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timeZone ?? displayTimeZone() });

/** "10/21 10:00–10:12 · Activity not saved by 3 browsers (41 events)" */
export function outageLabel(period: OutagePeriod & { browsers?: number }, timeZone?: string): string {
  const span = `${formatShortDate(period.from, timeZone)} ${hhmm(period.from, timeZone)}–${hhmm(period.to, timeZone)}`;
  if (period.kind === "client_gap") {
    const browsers = period.browsers ?? 1;
    return `${span} · Activity not saved by ${browsers} ${browsers === 1 ? "browser" : "browsers"} (${period.count} ${period.count === 1 ? "event" : "events"})`;
  }
  if (period.kind === "server_error") return `${span} · Server errors (${period.count})`;
  return `${span} · Kiwi unreachable (${period.count} ${period.count === 1 ? "failed request" : "failed requests"})`;
}

function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: string; tone?: "warning" | "danger" | "success" }) {
  return (
    <div className="health-stat">
      <span>{label}</span>
      <strong>{tone ? <StatusBadge tone={tone}>{value}</StatusBadge> : value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function Section({ title, children, help }: { title: string; children: ReactNode; help?: string }) {
  return (
    <section className="panel work-panel health-section" aria-label={title}>
      <h2>{title}</h2>
      {help && <p className="muted">{help}</p>}
      {children}
    </section>
  );
}

/** SB-m13: "4 by local guidance, no AI" — local fallbacks are counted, but not as AI. */
export function localNote(local: number | undefined, of: number, what: string): string | undefined {
  if (!local) return undefined;
  return local >= of ? `All ${what}, no AI` : `${local} ${what}, no AI`;
}

export function DataHealthView({ health, timeZone }: { health: DataHealth; timeZone?: string }) {
  const { events, aiTurns, aiCalls, heartbeats, identity, generatedItems, clientReported, legacyChecks, outages, kiwi } = health;
  const rejected = events.rejected.reduce((sum, r) => sum + r.count, 0);
  return (
    <div className="data-health">
      <p className="muted health-range">{health.range.label}</p>
      <Section title="Activity received">
        <div className="health-grid">
          <Stat label="Events received" value={events.received} />
          <Stat label="Duplicates ignored" value={events.duplicatesIgnored} note="Retries of events the server already had (same event id)" />
          <Stat label="Truncated (kept, shortened)" value={events.truncated} />
          <Stat label="Rejected" value={rejected} tone={rejected ? "warning" : undefined} note={events.rejected.map((r) => `${r.code} ${r.count}`).join(" · ") || undefined} />
          <Stat label="Dropped in browsers (reported)" value={events.clientGapsReported} tone={events.clientGapsReported ? "warning" : undefined} />
          <Stat label="Clock skew over 5 min" value={events.clockSkewOver5Min} />
        </div>
      </Section>
      <Section title="Outage periods" help="Times when activity may be missing: browsers that could not save, server errors, or Kiwi being unreachable.">
        {outages.length ? (
          <ul className="health-outages">
            {outages.map((o, i) => (
              <li key={`${o.kind}-${o.from}-${i}`}>
                <StatusBadge tone={o.kind === "client_gap" ? "warning" : "danger"}>
                  {o.kind === "client_gap" ? "Client gap" : o.kind === "server_error" ? "Server error" : "Kiwi unreachable"}
                </StatusBadge>{" "}
                {outageLabel(o, timeZone)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No outage periods in this range.</p>
        )}
      </Section>
      <Section title={`${LABELS.labAiTutor} turns`} help="Every reply is recorded by the server; analytics should show each one.">
        <div className="health-grid">
          <Stat label="Turns recorded by the server" value={aiTurns.serverTurns} />
          <Stat label="With a server analytics event" value={aiTurns.withServerEvent} note="Turns before v0.6 were reported by browsers instead (below)" />
          <Stat label="Missing from analytics" value={aiTurns.mismatch} note="v0.6 replies without an analytics event" tone={aiTurns.mismatch ? "warning" : undefined} />
          <Stat label="Reported by browsers (before v0.6)" value={aiTurns.legacyClientOnly} />
        </div>
      </Section>
      <Section title="AI requests">
        <div className="health-grid">
          <Stat label="Requests" value={aiCalls.total} note={aiCalls.teacherTests ? `Students only; ${aiCalls.teacherTests} "Test this rule" ${aiCalls.teacherTests === 1 ? "run is" : "runs are"} not counted` : "Students only"} />
          <Stat label="Answered" value={aiCalls.ok} note={localNote(aiCalls.local, aiCalls.ok, "by local guidance")} />
          <Stat label="Turned away" value={aiCalls.turnedAway} note="Rate limits, busy, unavailable, daily quota" tone={aiCalls.turnedAway ? "warning" : undefined} />
          <Stat label="Blocked by course rules" value={aiCalls.blocked ?? 0} note="Chapter not open, Ask Kiwi off for an assignment, homework match" />
          <Stat label="Failed" value={aiCalls.failed} tone={aiCalls.failed ? "danger" : undefined} />
          {(aiCalls.other ?? 0) > 0 && <Stat label="Other" value={aiCalls.other ?? 0} note="Still running or invalid requests" />}
          <Stat label="Never reached the server" value={clientReported.aiRequestsUnreached} note="Reported by browsers (network, timeout, HTTP error)" />
        </div>
      </Section>
      <Section title="Active time" help="Heartbeats are counted once per student per 30 seconds, across tabs.">
        <div className="health-grid">
          <Stat label="Heartbeats received" value={heartbeats.received} />
          <Stat label="Counted" value={heartbeats.counted} />
          <Stat label="Duplicates (other tabs, replays)" value={heartbeats.duplicates} />
        </div>
      </Section>
      <Section title="Identity">
        <div className="health-grid">
          <Stat label="Unverified events" value={identity.unverifiedEvents} note="Standalone demo classes have no verified identity" />
          <Stat label="Identities not on the roster" value={identity.nonRosterIdentities} />
          <Stat label="Preview (test) events" value={identity.previewEvents} />
          <Stat label="Teaching staff events" value={identity.staffEvents} />
        </div>
      </Section>
      <Section title={LABELS.aiGeneratedPractice}>
        <div className="health-grid">
          <Stat label="Items" value={generatedItems.total} note={localNote(generatedItems.local, generatedItems.total, "local templates")} />
          <Stat label="Verified in R" value={generatedItems.verified} />
          <Stat label="Output mismatch" value={generatedItems.mismatch} tone={generatedItems.mismatch ? "warning" : undefined} />
          <Stat label="Rejected" value={generatedItems.rejected} />
          <Stat label="Flagged" value={generatedItems.flagged} />
        </div>
      </Section>
      <Section title="Client data contract" help="Server-owned events sent by browsers are kept but never counted; unknown fields are kept and listed here.">
        <p>
          Server-owned events sent by browsers: <strong>{clientReported.serverOwnedFromClient}</strong>
        </p>
        {clientReported.unknownPayloadKeys.length > 0 && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Event type</th>
                  <th>Unregistered fields</th>
                  <th>Events</th>
                </tr>
              </thead>
              <tbody>
                {clientReported.unknownPayloadKeys.map((u) => (
                  <tr key={u.type}>
                    <td>{u.type}</td>
                    <td className="mono">{u.keys.join(", ")}</td>
                    <td>{u.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title={LABELS.legacyAutoCheck} help="v0.5 in-class checks are re-judged with the current rules when the question is unchanged; the rest are excluded from accuracy.">
        <div className="health-grid">
          <Stat label="Legacy checks" value={legacyChecks.legacyServer} />
          <Stat label="Re-judged" value={legacyChecks.rejudged} />
          <Stat label="Not re-judged (question changed)" value={legacyChecks.notRejudged} />
        </div>
      </Section>
      <Section title="Kiwi import">
        {kiwi.connected ? (
          <>
            <p>
              {kiwi.lastSynced ? `Last imported ${formatDateTime(kiwi.lastSynced, { timeZone })}` : "Kiwi activity has not been imported yet."} ·{" "}
              {kiwi.nativeEvents} native Kiwi events{kiwi.hasMore ? " · importing earlier course history…" : ""}
            </p>
            {kiwi.error && <p className="error-text">{kiwi.error}</p>}
            <ul className="health-kiwi">
              <li>Legacy CSS Lab chats stored in Kiwi (excluded by design): {kiwi.excludedByDesign ?? 0}</li>
              <li>Kiwi activity from students no longer enrolled: {kiwi.excludedNotEnrolled ?? 0} (not imported)</li>
            </ul>
            {kiwi.perStudent.length > 0 && (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Last import</th>
                      <th>Earlier activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kiwi.perStudent.map((s) => (
                      <tr key={s.studentId}>
                        <td>{s.label}</td>
                        <td>{formatDateTime(s.lastImportedAt, { timeZone, empty: "Nothing imported yet" })}</td>
                        <td>{s.backfilled ? "Imported" : "Importing…"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <p className="muted">{LABELS.kiwiNotLinked}</p>
        )}
      </Section>
      {Object.keys(health.retentionDue).length > 0 && (
        <Section title="Past the retention period">
          <ul>
            {Object.entries(health.retentionDue).map(([table, count]) => (
              <li key={table}>
                {table}: {count}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

export function DataHealthPage(_props: TeacherPageProps) {
  const { classId, timeRange } = useTeacher();
  const revision = useKiwiRefreshRevision();
  const [health, setHealth] = useState<DataHealth | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    api
      .dataHealth(classId, { from: timeRange.from ?? undefined, to: timeRange.to ?? undefined })
      .then((h) => {
        if (active) setHealth(h);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [classId, timeRange.from, timeRange.to, revision]);
  return (
    <>
      <PageHeader title={LABELS.dataHealth} tabs={<SectionTabs section="insights" />} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {health ? <DataHealthView health={health} /> : !error && <EmptyState title="Loading data health…" />}
    </>
  );
}
