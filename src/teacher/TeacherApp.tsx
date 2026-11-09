import { useEffect, type ComponentType } from "react";
import { LoaderCircle } from "lucide-react";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { navigate, useRoute } from "../lib/navigation";
import { previewPaths, resolveTeacherRoute, roleRedirect, teacherPageKey, type TeacherPageId } from "../lib/routes";
import { KiwiReturn } from "../KiwiReturn";
import { TeacherGate } from "./TeacherGate";
import { TeacherShell } from "./shell/TeacherShell";
import { TeacherProvider, useTeacherSession, type TeacherPageProps } from "./shell/TeacherContext";
import { HomePage } from "./home/HomePage";
import { AssignmentListPage } from "./assignments/AssignmentListPage";
import { AssignmentEditorPage } from "./assignments/AssignmentEditorPage";
import { StarterAssignmentsPage } from "./assignments/StarterAssignmentsPage";
import { ExerciseResultsPage } from "./grading/ExerciseResultsPage";
import { ToGradePage } from "./grading/ToGradePage";
import { GradebookPage } from "./grading/GradebookPage";
import { ReleaseExportPage } from "./grading/ReleaseExportPage";
import { RosterPage } from "./students/RosterPage";
import { NeedsAttentionPage } from "./students/NeedsAttentionPage";
import { GroupsPage } from "./students/GroupsPage";
import { StudentProfilePage } from "./students/StudentProfilePage";
import { StudentTimelinePage } from "./students/StudentTimelinePage";
import { ChaptersPage } from "./chapters/ChaptersPage";
import { AiRulesOverviewPage } from "./chapters/AiRulesOverviewPage";
import { AiRulesEditorPage } from "./chapters/AiRulesEditorPage";
import { GeneratedItemsPage } from "./chapters/GeneratedItemsPage";
import { LectureMaterialsPage } from "./chapters/LectureMaterialsPage";
import { AiConversationsPage } from "./insights/AiConversationsPage";
import { ActivityExplorerPage } from "./insights/ActivityExplorerPage";
import { QuestionActivityPage } from "./insights/QuestionActivityPage";
import { AnswersByQuestionPage } from "./insights/AnswersByQuestionPage";
import { CourseMetricsPage } from "./insights/CourseMetricsPage";
import { ExportsPage } from "./insights/ExportsPage";
import { DataHealthPage } from "./insights/DataHealthPage";
import { CourseSettingsPage } from "./settings/CourseSettingsPage";
import type { KiwiClient, VerifiedKiwiContext } from "../types";

/*
 * Teacher workspace (FOUNDATION, frozen): gate → shell → route switch (route table §3.2).
 * Workstreams change their page modules, never this switch.
 * R-B01: the workspace loads its own staff course after the staff identity is known (useTeacherSession); pages never
 * see the student view of the course that App boots with.
 */

export const TEACHER_PAGES: Readonly<Record<TeacherPageId, ComponentType<TeacherPageProps>>> = {
  home: HomePage,
  assignments: AssignmentListPage,
  assignmentNew: AssignmentEditorPage,
  assignmentEdit: AssignmentEditorPage,
  exerciseResults: ExerciseResultsPage,
  starterAssignments: StarterAssignmentsPage,
  toGrade: ToGradePage,
  gradebook: GradebookPage,
  releaseExport: ReleaseExportPage,
  roster: RosterPage,
  needsAttention: NeedsAttentionPage,
  groups: GroupsPage,
  studentProfile: StudentProfilePage,
  studentTimeline: StudentTimelinePage,
  studentAssignmentTimeline: StudentTimelinePage,
  chapters: ChaptersPage,
  aiRulesOverview: AiRulesOverviewPage,
  aiRulesEditor: AiRulesEditorPage,
  generatedItems: GeneratedItemsPage,
  lectureMaterials: LectureMaterialsPage,
  aiConversations: AiConversationsPage,
  activityExplorer: ActivityExplorerPage,
  questionActivity: QuestionActivityPage,
  answersByQuestion: AnswersByQuestionPage,
  courseMetrics: CourseMetricsPage,
  exports: ExportsPage,
  dataHealth: DataHealthPage,
  courseSettings: CourseSettingsPage,
};

/** Replaces the URL after render (a role without Home lands on its own start page, decision D3). */
function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, true), [to]);
  return null;
}

function OpeningScreen() {
  return (
    <div className="boot-screen">
      <span className="kiwi-wordmark">kiwi</span>
      <LoaderCircle className="spin" size={22} />
      <p>Opening the teacher workspace…</p>
    </div>
  );
}

export function TeacherApp({ classId, kiwi, verified }: { classId: string; kiwi: KiwiClient | null; verified: VerifiedKiwiContext | null }) {
  const route = useRoute();
  const path = route.split("?")[0];
  const session = useTeacherSession({ classId, verified });

  if (session.status === "loading") return <OpeningScreen />;
  const failure = session.status === "error" ? session.error : session.me?.role ? session.courseError : "";
  if (failure)
    return (
      <div className="boot-screen">
        <span className="kiwi-wordmark">kiwi</span>
        <p>Unable to open the teacher workspace</p>
        <p className="error-text" role="alert">
          {failure}
        </p>
        <button className="primary-button" onClick={session.retry}>
          Try again
        </button>
        {session.teacherKey && (
          <button className="text-button" onClick={() => session.setTeacherKey(null)}>
            Use a different key
          </button>
        )}
        <KiwiReturn kiwi={kiwi} teacher />
      </div>
    );
  if (!session.me)
    return <TeacherGate classId={classId} reason="signed_out" error={session.error} onSignedIn={(key) => session.setTeacherKey(key)} />;
  if (session.me.role === null)
    return (
      <TeacherGate
        classId={classId}
        reason="no_lab_role"
        onSignedIn={(key) => session.setTeacherKey(key)}
        onPreview={() => navigate(previewPaths.assignments())}
      />
    );
  if (!session.value) return <OpeningScreen />;   // R-B01: the staff course is still loading

  const landing = roleRedirect(path, session.me.permissions);
  if (landing) return <Redirect to={landing} />;
  const resolved = resolveTeacherRoute(path) ?? resolveTeacherRoute("/teacher/home");
  if (!resolved) throw new Error("The teacher route table has no Home page.");
  const Page = TEACHER_PAGES[resolved.route.id];
  const allowed = session.me.permissions.includes(resolved.route.permission);
  return (
    <TeacherProvider value={session.value}>
      <TeacherShell kiwi={kiwi}>
        {allowed ? (
          <Page key={teacherPageKey(resolved.route.id, resolved.params, session.value.nameMode)} params={resolved.params} route={route} />
        ) : (
          <>
            <PageHeader title="Not available for your role" />
            <section className="panel work-panel">
              <EmptyState>Your course role does not include this page. Ask the course instructor if you need access.</EmptyState>
            </section>
          </>
        )}
      </TeacherShell>
    </TeacherProvider>
  );
}
