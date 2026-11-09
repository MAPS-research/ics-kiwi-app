# v0.4 architecture and operating limits

## Route ownership

`App.tsx` resolves browser history and provides role navigation, embedded Kiwi context, course identity, and telemetry. `TeacherDashboard` guards local teacher access and mounts only the selected module. `TeacherWork`, `TeacherCourse`, and `TeacherAnalytics` own their task pages. `StudentWork` keeps assignment/question context while rendering one tool page; `Practice` does the same for generated practice. `LearningTools` shares the R console, persisted tutoring thread, and safe text/code rendering.

`navigate()` changes history and scrolls only when the pathname changes. Query filters keep the current scroll position. Search filter updates replace the current history entry. Sidebar and tool navigation use real addresses; no section-scrolling navigation remains.

## Learning evidence

SQLite `events` remains the event source. The additive `learning_session_id` column links each meaningful event to `learning_sessions`. A session key includes course, student, browser session, chapter, assignment, question or thread/workspace. A 30-minute inactivity gap splits sessions. Question sessions contain code edits/runs, answer attempts, and related conversation events; heartbeats are excluded.

Ingestion updates counters transactionally. Analytics reads counters through SQL, validates sort columns against an allowlist, binds filter values, and returns bounded pages. Full code/answer/chat payloads are fetched only for the requested evidence/session. Derived indexes are versioned and can be rebuilt without changing original event payloads or assessment records. Historical submission snapshots supply missing historical homework attempts with explicit provenance. Chapter inference uses authored assignments or the same student's known question context; otherwise data remains unattributed.

Homework insertion and its per-question attempt events commit together. A write transaction serializes attempt numbering. Optional request IDs make retries idempotent, reject changed answers under the same ID, and avoid duplicate telemetry. The browser keeps a pending ID until submission is acknowledged. Grades use the original immutable question set once submissions exist.

Teacher lists retrieve 20 full assignments at a time. Grading retrieves 10 submissions and the associated question sets. Assignment pickers use metadata. Student list views use metadata and fetch one assignment's redacted questions; submission history is explicitly limited to its latest 100 records. Grade and session aggregates still include all stored attempts.

## Teacher policy boundary

`server/ai.py` stores policies by course/chapter. Only teacher-authenticated writes can change a prompt, range/default difficulty, allowed types, or token budget. Student requests cannot replace messages, model, instructions, developer policy, or output limits. The server resolves the current policy for each request and supplies system/application rules, teacher developer instructions, and student learning data in distinct roles. Reference homework answers are not included in AI request context.

Requests use the Responses API. The existing model environment setting is retained. Schema validation rejects malformed exercises, invalid choices, completion questions without actual gaps/output, and non-English generated stems/explanations. Source repetition triggers at most one fresh attempt. Provider failures/incomplete outputs remain visible. Four AI requests can run concurrently; each course/student identity is limited to 15 provider calls per minute. Conversations retain recent thread turns in the request and persist completed responses in SQLite. No SDK prompt concatenation is used to claim teacher precedence.

The role hierarchy follows [official OpenAI documentation](https://developers.openai.com/api/docs/guides/text#message-roles-and-instruction-following). This establishes a real message/parameter boundary. It does not prove every generated exercise is pedagogically correct or every adversarial natural-language input will be handled perfectly. Output quality still requires review.

## Known limits and next checks

- Local teacher-key access and browser-provided student IDs remain. Neither `KIWI LIVE` nor a role page proves API authorization. Trusted Kiwi JWT verification and course membership are required before institutional deployment.
- Independent v0.4 browser review stopped before grading, analytics, policies, official-host integration, and actual 390/320 viewport validation. The final pagination/retry fixes also need browser retesting. Automated checks are not substitutes for these tasks.
- The synthetic 100,000-session benchmark measures SQL rollup query latency only. It does not measure concurrent classrooms, sustained event ingestion, AI capacity, attachment downloads, mobile memory, or availability.
- Metadata pickers and Data Hub's student/grade matrix can still grow with course size. They avoid full code/response payloads, but need additional pagination or virtualized search for very large enrollments and assignment catalogs. SQLite/ThreadingHTTPServer is a local service, not a production deployment design.
- Student answer/code drafts live in one browser. Cross-device draft sync is not implemented. AI thread history is server-persisted. Teacher authoring drafts should be saved explicitly before leaving their editor.
- Keyword groups are transparent retrieval aids, not semantic misconception detection. Exact question distributions and examples remain available for teacher interpretation.
- R is serialized within one browser runtime and resets after an execution timeout. The text workspace does not render plots; package installation and large/complex R workflows remain outside this version's browser evidence.
- Existing authored content, prior submissions, and feedback retain their original language and values. Only default/system copy, new templates, and AI instructions were translated.
