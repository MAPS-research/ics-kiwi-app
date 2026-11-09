import { LABELS } from "../../lib/labels";
import { teacherPaths } from "../../lib/routes";
import { HomeLink } from "./HomeLink";
import { askedLine } from "./homeModel";
import type { HomeData } from "../../types";

/** What students asked the tutor [DA03, TH07]: top repeated prompts, topics, replies that may state a final answer. */
export function AskedAiPanel({ asked, flaggedVisible }: { asked: HomeData["askedAi"]; flaggedVisible: boolean }) {
  return (
    <section className="panel home-block home-asked" aria-labelledby="home-asked-title">
      <h2 id="home-asked-title">{LABELS.whatStudentsAsked}</h2>
      {asked.repeated.length ? (
        <ul className="asked-list">
          {asked.repeated.map((r) => (
            <li key={r.prompt}>
              <HomeLink href={teacherPaths.aiConversations({ mode: "coding", thread: r.threadKeys[0] })} allowed>
                {askedLine(r)}
              </HomeLink>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No question was asked by two or more students in this period.</p>
      )}
      {asked.topics.length > 0 && (
        <p className="asked-topics">
          Topics: {asked.topics.map((t) => `${t.label} ${t.count}`).join(" · ")}
        </p>
      )}
      {flaggedVisible && asked.flaggedFinalAnswer > 0 && (
        <p className="asked-flagged">
          <HomeLink href={teacherPaths.aiConversations({ mode: "coding", flagged: "1", unitId: "all" })} allowed>
            ! {asked.flaggedFinalAnswer} {asked.flaggedFinalAnswer === 1 ? "reply may state" : "replies may state"} a final answer
          </HomeLink>
        </p>
      )}
      <HomeLink className="text-button" href={teacherPaths.aiConversations({ unitId: "all" })} allowed>
        Open AI conversations
      </HomeLink>
    </section>
  );
}
