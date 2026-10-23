# CSS Kiwi Lab 0.6.0

A local Computational Social Science learning app for SOCS-SH 190: R practice, assignments and teacher analytics, standalone or opened from a Kiwi course. Version **0.6.0** rebuilds the teacher side around what a teacher does each week (Home, grading with rubrics and release, AI tutor rules per chapter, Insights, people and research exports), makes the server the source of truth for answers and AI provenance, and adds a final-answer guard for graded homework. See [CHANGELOG](CHANGELOG.md) and the [architecture spec](docs/architecture-v0.6.0.md).

## Run locally

Requires Node.js 20+ and Python 3.10+. R runs in the browser through webR; a local R installation is unnecessary.

```bash
cp .env.example .env        # then set KIWI_TEACHER_KEY to a long random value (no default)
npm install
npm run dev:all             # API on 127.0.0.1:8101, UI on 127.0.0.1:8100
```

Open [workspace selection](http://127.0.0.1:8100/entry), the [student workspace](http://127.0.0.1:8100/student/assignments) or the [teacher workspace](http://127.0.0.1:8100/teacher/home). The standalone teacher workspace opens with `KIWI_TEACHER_KEY` (or a staff key created in Course settings › Staff & roles); without it the API answers `503 teacher_key_not_configured`. Data lives in `data/kiwi-lab.sqlite3` unless `KIWI_DB_PATH` is set.

For AI, set `OPEN_AI_TEST_KEY` (or `OPENAI_API_KEY`) in the server `.env`. Keys, instructions and reference answers never reach the browser. Without a key, Ask Kiwi answers with labelled **Local guidance** and practice uses local templates and closed in-class exercises; provider errors stay errors.

### Deploy v0.6.0 on this Mac (upgrading a v0.5.1 install)

The first v0.6.0 start migrates `data/kiwi-lab.sqlite3`. It takes an automatic online backup first, but keep your own copy as well.

```bash
npm run demo:stop                    # stops Kiwi API/UI, the app API (8101) and app UI (8100) that demo:start manages
                                     # (if you started `npm run dev:all` or server/app.py yourself, stop those too)
mkdir -p data/backups
sqlite3 data/kiwi-lab.sqlite3 ".backup 'data/backups/kiwi-lab.manual-pre-0.6.0.sqlite3'"
# .env: set KIWI_TEACHER_KEY=<long random value> (e.g. `openssl rand -hex 24`); there is no default key any more
node scripts/local-kiwi/reinstall-bridge.mjs     # copies the bridge controller, nest build, starts the demo DB container,
                                                 # upgrade-integration (app config/version)
npm run demo:start                   # app API migrates the DB (backup in data/backups/), Kiwi UI gets the host adapters
curl -s http://127.0.0.1:8101/api/health          # → "version": "0.6.0"
npm run test:bridge                  # controller spec + bridge UI tests inside .local
node scripts/local-kiwi/verify-integration.mjs    # bridge SQL end to end against the running demo
```

Without the Kiwi demo (standalone only): stop the API, run the same `sqlite3 … .backup`, set `KIWI_TEACHER_KEY`, then `npm run dev:all`. Rollback: stop the servers and copy `data/backups/kiwi-lab.pre-0.6.0-001-columns-<timestamp>.sqlite3` over `data/kiwi-lab.sqlite3` (v0.5.1 code also runs on the migrated file; it ignores the new columns and tables).

## Teacher workspace

Seven sections; narrow screens use a menu drawer. The top bar has **Find a student…**, the shared **Time** range (This class · Since last class · This week · Last 7 days · Whole term · Custom, computed from Course settings › Class schedule in the course time zone; shown only on Home, Needs attention, student profiles, Insights and Course settings, the pages whose numbers follow it), **Presentation mode** (pseudonyms everywhere, including names and emails inside prompts, replies and answers; turning it on reloads the open page) and **Open Kiwi**/**Back to Kiwi**; **Preview as student** is in the account menu. Every date, on teacher and student pages, is shown in the course time zone with its offset (for example `Due Wed 10/21 14:59 GMT+8`), and the assignment editor reads and writes dates in that zone. Old v0.5 bookmarks redirect with a “That page moved” notice.

| Section | Pages (route) |
| --- | --- |
| Home | Needs your action · Students needing attention · What to re-teach · What students asked the AI · This week at a glance (`/teacher/home`) |
| Assignments | All assignments, editor, in-class exercise Results, Starter assignments (`/teacher/assignments`, `…/new`, `…/:id/edit`, `…/:id/results`, `…/starter`) |
| Grading | To grade (n), Gradebook, Release & export (`/teacher/grading`, `…/gradebook`, `…/release`) |
| Students | Roster, Needs attention, Groups, profile, full activity timeline, student × assignment timeline (`/teacher/students`, `…/attention`, `…/groups`, `…/s/:id`, `…/s/:id/timeline`, `…/s/:id/assignments/:assignmentId`) |
| Chapters & AI tutor | Chapters, AI tutor rules (overview → editor), AI-generated practice, Linked lecture materials (`/teacher/chapters`, `…/ai`, `…/ai/:unitId`, `…/ai-practice`, `…/materials`) |
| Insights | AI conversations, Activity explorer, question activity, answers by question, Course metrics, Exports, Data health (`/teacher/insights/…`) |
| Course settings | Course info, Class schedule, Kiwi connection, Staff & roles, Privacy, Course package (`/teacher/settings?tab=…`) |

**Roles.** The server enforces four staff roles ([decisions D1, D3](docs/handoff/v0.6.0-decisions.md)):

- *Instructor* (Kiwi course manager, or the local key): everything.
- *TA* (Kiwi assistant, or a TA staff key): grading, Insights, read-only assignments and AI rules, exports. A TA releases grades only if Course settings allows it.
- *Viewer* (Kiwi analytics access, e.g. an observing co-instructor): Home, Students, Insights and read-only AI rules; a viewer reads the re-teach list but does not add to it. Viewer exports are always pseudonymized and consent-filtered.
- *Researcher* (a researcher staff key, or a Staff & roles override on a Kiwi staff member): Insights, read-only chapters, AI tutor rules and groups, and research exports. The sidebar shows Groups, Chapters & AI tutor and Insights, and Home opens the Activity explorer. The server shows researchers pseudonyms only, whatever the client’s name mode (names and emails inside prompts and replies are replaced too), shows only students with research consent (others answer 404, as if they did not exist), uses research ids (the same `P…` ids as in research exports) instead of student ids in every response and link (a request that names a student by a raw student id answers 404), names a classmate without research consent `[classmate]` inside free text, and logs every read with the role. Their exports are always pseudonymized, consent-filtered and limited to verified identities, and case files are refused. Researchers cannot grade, edit, manage people, open the roster, profiles or Home’s named lists, or preview as a student.

Instructors can override any Kiwi staff member’s Lab role in Course settings › Staff & roles. A Kiwi staff member without a Lab role can only preview. Staff use **Preview as student** to try student pages; preview rows are marked as tests and never counted. The server enforces every permission; the UI only hides what a role cannot use.

**Students** have Assigned work, Practice with AI, R workspace, Ask Kiwi and Course outline. Inside an assignment, Answer & submit, R workspace, Ask Kiwi and Try a similar question are separate tabs, shown only when the assignment’s tool policy allows them. Answers are saved to the server as drafts while typing (and restored on another device); submissions follow the due, close, late, attempt and time-limit rules; grades appear after release.

## AI tutor rules and the final-answer guard

Rules are set per chapter (or as the course default) and optionally per group, saved as append-only versions with history, compare, restore and copy. Every request is assembled by the server in this order (precedence system > developer > user):

1. **system** — the read-only platform rules (`platform-rules-v2`): untrusted student data; no prompt disclosure; graded work follows the assignment’s help level and never gets the final answer; reply language; only the chapter’s R packages and datasets; the generated-practice format. Then “Reply in {language}.”
2. **developer (teacher)** — Instructions for Ask Kiwi (tutoring) or Instructions for generated practice, reference notes, difficulty rubric, chapter packages and datasets, and optional AI-reference material (≤ 8,000 characters).
3. **developer (server)** — the help level for chat, or the item format for generation.
4. **user** — the learning context as data (chapter, question, starter code, the student’s code/error/output/answer as configured), then recent turns of the same thread and question, then the prompt. Reference answers are never sent.

Students cannot send system messages, models, token limits or policy overrides. A homework is protected while it is published, the student is in its audience, and its solutions are not yet visible ([decision D2](docs/handoff/v0.6.0-decisions.md)):

- New homework defaults to *Solutions visible: After the due date*, so protection lasts while students can still submit: until the due date, or the end of the late window when late work is accepted. Solutions appear at the same moment, when the homework closes. A homework that accepts late work with no end date stays protected until a closing date is set or it is archived.
- *Never* keeps answers protected until the homework is archived or the setting changes. Use it for items you will reuse.
- The editor’s Student help note and the assignment list show the actual state, for example `Ask Kiwi won't give final answers until this homework closes (…)` or `Answers are no longer protected: this homework is closed.`
- **Revisions.** A homework and its revision protect each other: publishing a revision closes the original, but the original’s solutions stay hidden and Ask Kiwi stays protected while the revision accepts submissions. The editor and the list link the original and its revisions (`Revision of “…”`, `Revised as “…”`). A student who submitted the original is not counted as *Missing* on the revision (`Submitted the original` in the gradebook and the list) and sees a note on the revision; merging grades across versions is not done (deferred).

While a homework is protected, the server checks every reply and generated item against that homework’s answers: one rewrite, then redaction of the leaking span; the turn is flagged for staff, who can see the original reply and clear the flag. **Test this rule** shows the exact messages (dry run) or makes a real call logged as a teacher test.

## Data guarantees

- **Telemetry** goes through a durable outbox in the browser (persisted before delivery, retried with backoff, batched, flushed on page hide). The server deduplicates by `eventId` (at-least-once delivery, exactly-once storage) and never rejects an event for size: long fields keep head and tail with a truncation flag.
- **Server-owned events.** Answer checks, submissions, drafts, AI questions and generated items are written by the server (`checked_by='server'`). Client copies are refused (`KIWI_SERVER_OWNED_EVENTS` default `enforce`); v0.5.1 rows keep their original values and are marked `client` or `legacy_server`.
- **Payloads are never rewritten.** Chapter mappings live in `material_unit_map`, corrections of imported Kiwi records in `event_revisions`; a replayed submission request returns the original result and writes no second `work_submitted`.
- **Native Kiwi events are versioned projections** (`native-projection-v3`) of Kiwi interactions; thumbs/flags and every AI response are kept; Kiwi’s own records stay in Kiwi.
- **Population at query time.** Counts include enrolled, non-excluded students only; staff, preview and excluded students are left out unless *Include teaching staff* is chosen. Names come from the roster, never from events.
- **Question activities** group one student’s work on one question, item or thread; events less than 30 minutes apart belong to the same activity, across browser tabs. Homework views count the homework’s own questions only; similar-practice attempts appear under Similar practice (AI).

## Metric definitions

- **Enrolled**: active, non-excluded roster students. **Active (range)**: enrolled students with at least one action event in the range; every “per active student” card states both numbers.
- **Active minutes**: counted heartbeats × 0.5 (one per 30-second bucket per student while the page is visible and recently used).
- **Auto-checked accuracy (your questions)**: server-checked correct ÷ server-checked attempts on teacher-authored questions (homework auto-check and in-class checks). Legacy v0.5 checks count only with their re-judged value; the rest are shown as *Legacy auto-check (v0.5 rules)* in the Research preset.
- **Similar practice accuracy (AI)**: server-checked correct ÷ checked on similar items. **Client-reported accuracy (legacy)**: Research preset only.
- **First try correct %** and **mean tries to correct** (What to re-teach): per question, over students who attempted it; a question needs 3 or more students in the range.
- **AI tutor questions (incl. hints)**: Lab AI tutor turns + Kiwi lecture AI questions + legacy hint requests.
- **Logged actions**: answer attempts, code runs, AI questions, submissions, generations, package installs and file loads.
- **Last seen** (roster, student profile): the newest event of any kind from the student, page views, heartbeats and lecture views included. **Last learning action** (roster tooltip, student profile): the newest answer (submitted, saved or checked, in the Lab or Kiwi's scratchpad), code run, AI question or submission.
- **No learning actions for N days** (Students needing attention): no learning action, as defined above, for at least N days; the reason also shows when the student was last seen, so a student who only opens pages is listed with "last seen 2 min ago".
- **Missing work**: published homework in the student's audience, past its due date (after grace), with no submission. A homework and its published revisions count once (decision D8): a submission to any version counts, and a student who submitted none is missing it once, on the newest version they can submit to; the tooltip names the original. The roster, profile, Home, Needs attention, the Activity explorer, the Assignments list, gradebook cells and the status CSV use this one rule (`analytics.missing_work`).
- **AI requests turned away / failed**: unavailable, busy, rate-limited, blocked by tool policy, provider or validation errors (`ai_calls.status`).

## Exports and codebook

Insights › Exports offers the activity log, AI conversations, generated practice items and coded conversations (CSV/JSONL), Grades for LMS, Student × assignment status, one student’s case file (with a recorded purpose), the research package (events, conversations, items, groups and group history, codebook, manifest with hashes, README with outage periods) and `codebook.md`. Teaching CSVs use a UTF-8 BOM, CRLF and spreadsheet-formula neutralization; research-package files are plain UTF-8 without neutralization. Exports can be pseudonymized with HMAC research ids and filtered by research consent, and every export is recorded in the audit log. Pseudonymized exports replace every roster student’s name and email in free text (prompts, replies, answers, AI call text, coding notes) with that student’s research id, so a classmate named in someone else’s chat never appears. The research package has its own settings next to its button, pseudonymized and consented students only by default; the filter panel above applies to the teaching exports. Viewer and researcher exports are always pseudonymized and consent-filtered; researcher exports also exclude unverified (demo) identities and never include a student’s case file. Standalone demo data is unverified: the research package refuses it unless *Include unverified (demo) identities* is chosen, and marks it as demo data.

## Kiwi integration

From a Kiwi course card, **Open CSS Lab** opens the Lab with a Kiwi app token; the Lab server verifies course membership and role with Kiwi on every request (cached ≤ 120 s). Teachers need no second key. While any teacher page is open, one sync loop imports native Kiwi activity; a **New activity · Refresh** notice appears instead of resetting the page. **Linked lecture materials** maps Kiwi materials to chapters.

Kiwi’s own side-panel chat is registered in **guidance** mode on Lab pages and does not know assignment answers. With the local host patch, homework whose Ask Kiwi is Off also hides Kiwi’s chat panel while that page is open; on an unpatched host it stays available in guidance mode, and the editor says so. A second patch returns teachers to the requested Lab page after Kiwi sign-in. Both patches are approved for the local demo ([decision D5](docs/handoff/v0.6.0-decisions.md)) and reach your local Kiwi with the bridge reinstall below. A production Kiwi needs them upstream; they are written up as proposals for the Kiwi maintainers. The bridge still returns student emails and the roster, as in v0.5; this boundary is an open question for the Kiwi maintainers ([open questions](docs/handoff/v0.6.0-open-questions.md)), and `showEmails=false` with roster import by id is the implemented fallback.

### Bridge reinstall (local Kiwi demo)

```bash
npm run demo:stop
node scripts/local-kiwi/reinstall-bridge.mjs     # copies controller, nest build, starts the demo DB container, upgrade-integration
npm run demo:start                               # frontend.mjs re-applies UI adapters on start
npm run test:bridge                              # optional: controller spec + bridge UI tests inside .local
```

The app database migrates itself on the next `server/app.py` start (backup first). Kiwi course content, Lab assignments, submissions and grades are preserved. The full demo (official Kiwi UI/backend, PostgreSQL, Redis, MinIO) is described in [docs/local-kiwi-demo.md](docs/local-kiwi-demo.md); `npm run demo:setup` performs a fresh installation.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `KIWI_TEACHER_KEY` | none | instructor key for standalone demo classes (required for the standalone teacher workspace) |
| `KIWI_STANDALONE_CLASS_IDS` | `local-r-class` | standalone classes that accept student writes without a course row |
| `OPEN_AI_TEST_KEY` / `OPENAI_API_KEY` | none | server-only AI key |
| `KIWI_DEMO_MODEL` | `gpt-5.4-mini` | default model |
| `KIWI_MODEL_ALLOWLIST` | `KIWI_DEMO_MODEL` | models selectable in AI tutor rules |
| `KIWI_AI_CONCURRENCY` / `KIWI_AI_QUEUE_WAIT_S` | `4` / `20` | concurrent provider calls per process / longest wait for a slot |
| `KIWI_AI_PER_IP_PER_MINUTE` | `60` | AI requests per client address per minute (standalone classes) |
| `KIWI_SERVER_OWNED_EVENTS` | empty = `enforce` | `accept` stores client copies of server-owned events flagged as client-reported |
| `KIWI_GIT_SHA` | unset | commit recorded in research packages |
| `KIWI_DB_PATH`, `KIWI_API_PORT` | `data/kiwi-lab.sqlite3`, `8101` | database file, API port (Vite's proxy reads `KIWI_API_PORT` from the shell) |
| `KIWI_API_ORIGIN`, `KIWI_CLASS_IDS`, `VITE_KIWI_ORIGIN` | `http://localhost:3000`, `local-css-demo`, — | Kiwi bridge origin, linked classes, Kiwi UI origin |
| `KIWI_SNAPSHOT_DBS` | unset | extra database snapshots for the migration tests |

## Course content, R and boundaries

The course template follows the real SOCS-SH 190 Spring 2026 materials ([decision D4](docs/handoff/v0.6.0-decisions.md)):

- **Structure.** Template `socs-sh-190-spring-2026` (Course settings › Course package): 12 chapters from the lecture weeks and dates, each paired with the R sessions taught that week and the packages those sessions load. Chapters, week labels and R sessions follow the slides’ module schedule tables; the one inferred pairing (session 2d in chapter 5) is marked. The import preview lists the notes and course milestones under each chapter (with a Week column), and applying the template keeps them as each chapter’s **Chapter notes (staff only)** on the Chapters page; students never see them. Apply asks for confirmation when it would archive chapters.
- **Packages.** Packages that webR 0.6.0 cannot install (`duke` in session 2e, `ldatuning` in 3c) are left out of the chapter packages and marked “run locally”. The YouTube session’s live API steps say “use the provided data file” (`YT_scraped_Data.RData`). Each case also has a chapter error hint for students.
- **Editable.** Chapters, learning goals and dates are editable. Chapter dates shift on import: by the week shift, and to your term start when the course schedule has one.

The materials also informed editable starter assignments. Teachers must check examples, reference answers, data and rubrics before assigning them.

R executes in browser webR, never on the Python server: printed values autoprint, plots render, warnings and errors are structured, each question has its own environment, allowlisted course packages install on demand (chapter packages before the first run), and assignment or chapter data files are written into the R working directory (`/home/web_user/<file name>`). Correctness of code questions uses the student’s own run output (`client_run_output`); the server does not run R.

This remains a local pilot: SQLite, one process, loopback ports. Shared deployment needs HTTPS, managed persistence, retention and load validation; no production-capacity claim is made.

## Validation

```bash
npm run test:server        # python3 -m unittest discover -s server -p 'test_*.py'  (AI keys are always empty in tests)
npm test                   # vitest (incl. the naming lint and accessible-name scan)
npm run coverage           # vitest with @vitest/coverage-v8: line coverage over src/** (writes coverage/, git-ignored)
npx tsc --noEmit -p tsconfig.json
npm run build
node scripts/verify-r-capture.mjs
npm run test:bridge        # inside .local/kiwi*, or KIWI_UI_DIR=… KIWI_BACKEND_DIR=… on copies; skips when absent
python3 -m coverage run --source=server -m unittest discover -s server -p 'test_*.py' && python3 -m coverage report
python3 scripts/benchmark-analytics.py --sessions 20000 --events 50000 --students 300
```

Coverage target ([decision D7](docs/handoff/v0.6.0-decisions.md)): at least 80 % lines for `src/lib` modules and for new server modules. Page containers are covered by view tests and the browser review; their numbers are reported, not gated. Measured numbers are in the spec’s As-built notes (Appendix E). Reviews: [v0.6.0 preservation check](docs/reviews/2026-10-22-v0.6.0-preservation.md); earlier: [v0.5.1](docs/reviews/2026-10-15-v0.5.1.md), [v0.5.0](docs/reviews/2026-10-15-v0.5.0.md), [v0.4](docs/reviews/2026-10-15-v0.4.0.md), [v0.3](docs/reviews/2026-10-14-v0.3.0.md), [v0.2](docs/reviews/2026-10-12-v0.2.0.md).

Theme and fonts match the local `NYUSH-ML/kiwi-ui` commit `fbc29beab4c6063c07fcf273d89e7237fad850b7` (primary Purple 800 `#6A1B9A`; Montserrat self-hosted).
