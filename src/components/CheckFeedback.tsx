import { CheckCircle2 } from "lucide-react";
import { checkFeedback } from "../lib/questions";
import { ResponseText } from "./ResponseText";
import type { ItemCheckResult } from "../types";

/**
 * The feedback box after "Check answer" on an AI practice item (Practice with AI and Try a similar question). RT-01: the
 * verdict is one line and the explanation renders through ResponseText, so inline `code` and fenced R blocks look the
 * same as in the prompt instead of showing literal backticks.
 */
export function CheckFeedback({ result }: { result: ItemCheckResult }) {
  const feedback = checkFeedback(result);
  return (
    <div role="status" className={`feedback check-feedback ${feedback.tone}`}>
      {feedback.tone === "correct" && <CheckCircle2 size={18} aria-hidden="true" />}
      <div className="check-feedback-body">
        <p className="check-feedback-verdict">{feedback.text}</p>
        {feedback.explanation && <ResponseText className="check-feedback-explanation" text={feedback.explanation} />}
        {feedback.note && <p className="check-feedback-note">{feedback.note}</p>}
      </div>
    </div>
  );
}
