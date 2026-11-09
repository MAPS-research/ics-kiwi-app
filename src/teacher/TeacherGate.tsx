import { useState } from "react";
import { ArrowLeft, KeyRound } from "lucide-react";
import { api } from "../lib/api";
import { kiwiTeacherEntryUrl } from "../lib/kiwi";
import { LABELS } from "../lib/labels";
import { navigate } from "../lib/navigation";
import { studentPaths } from "../lib/routes";

/*
 * Teacher gate — FOUNDATION baseline owned by PEOPLE (moved from the v0.5.1 TeacherDashboard login).
 * Full-screen, no sidebar (§3.1). `no_lab_role`: a Kiwi course staff member without a Lab role (§5.3 step 1e).
 */
export function TeacherGate({
  classId,
  reason,
  error = "",
  onSignedIn,
  onPreview,
}: {
  classId: string;
  reason: "signed_out" | "no_lab_role";
  error?: string;
  onSignedIn: (key: string) => void;
  onPreview?: () => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const login = async () => {
    setBusy(true);
    setFailure("");
    try {
      await api.verifyTeacher(classId, input);
      onSignedIn(input);
      setInput("");
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const message = failure || error;
  return (
    <div className="teacher-login-screen">
      <button className="text-button back-button" onClick={() => navigate(studentPaths.entry())}>
        <ArrowLeft size={16} />
        Back to workspaces
      </button>
      <section className="login-card">
        <div className="login-icon">
          <KeyRound size={25} />
        </div>
        <h1>Teacher workspace</h1>
        {reason === "no_lab_role" ? (
          <>
            <p className="muted">
              Your account has no CSS Lab teacher grant for this course. Ask the Lab administrator to grant access to your course and account ID.
            </p>
            {onPreview && (
              <button className="primary-button full" onClick={onPreview}>
                {LABELS.previewAsStudent}
              </button>
            )}
          </>
        ) : (
          <>
            <p className="muted">Open Kiwi, choose your course, then open CSS Lab from the course's Apps panel. Teacher access requires a Lab administrator's grant.</p>
            <a className="primary-button full" href={kiwiTeacherEntryUrl()}>
              Open Kiwi
            </a>
            <h2 className="local-demo-login-title">Local demo access</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void login();
              }}
            >
              <label className="work-label">
                Local demo or staff access key
                <input type="password" value={input} onChange={(e) => setInput(e.target.value)} autoComplete="current-password" required />
              </label>
              {message && (
                <p className="error-text" role="alert">
                  {message}
                </p>
              )}
              <button className="primary-button full" disabled={busy || !input}>
                {busy ? "Verifying…" : "Open local demo workspace"}
              </button>
            </form>
            <p className="login-footnote">A Kiwi account password belongs on the Kiwi sign-in page. This key opens only the standalone demo.</p>
          </>
        )}
      </section>
    </div>
  );
}
