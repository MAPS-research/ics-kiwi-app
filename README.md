# CSS Kiwi Lab

A local Computational Social Science learning app for SOCS-SH 190. Version **0.5.1** repairs teacher entry from Kiwi's global menu, including instructor course selection and recovery after a failed lookup. Kiwi and CSS Lab share verified course identity and teacher analytics covering both Lab work and native Kiwi coding and lecture conversations.

## Run locally

Requires Node.js 20+ and Python 3.10+. R runs in the browser through webR; a local R installation is unnecessary.

```bash
cp .env.example .env
npm install
npm run dev:all
```

Open [workspace selection](http://127.0.0.1:8100/entry), [student assigned work](http://127.0.0.1:8100/student/assignments), or [teacher assignments](http://127.0.0.1:8100/teacher/work/assignments). The default local teacher key is `kiwi-local-demo`; configure `KIWI_TEACHER_KEY` in `.env`. The API listens on loopback port 8101 and stores SQLite data in `data/kiwi-lab.sqlite3` unless `KIWI_DB_PATH` is set.

For AI, set `OPENAI_API_KEY` or the existing `OPEN_AI_TEST_KEY` in the server `.env`. `KIWI_DEMO_MODEL` selects the configured model (existing default: `gpt-5.4-mini`). API keys and teacher prompts stay on the server. Without an AI key, exercises and help are explicitly labeled local templates/guidance; local templates enforce allowed types and difficulty but cannot interpret a custom teacher system prompt. Provider errors remain errors.

## Pages and workflows

Navigation changes the URL and rendered page. Refresh, deep links, and browser Back/Forward are supported; navigation does not scroll through a page containing every module.

| Teacher module | Pages |
| --- | --- |
| Practice & assignments | Assignment list; create/edit; publish/unpublish; grading; chapter-specific generation settings |
| Course management | Course plan and current chapter; enrollment and roster import; Kiwi lecture-to-chapter links |
| Data analytics | Overview; interaction explorer; full session; answer/question evidence; grades and Data Hub |

Students have Assigned work, Guided practice, R workspace, Ask Kiwi, and Course outline. Within an assignment, **Answer & submit**, **R workspace**, **Ask Kiwi**, and **Similar practice** are separate pages sharing the selected question. Answers and code are saved in the current browser; AI conversations persist on the server. Generated practice is retained in the browser session.

Create a draft, fill in questions and reference answers, then publish it from the assignment list. Classroom practice is checked immediately; homework is manually graded. Homework submission requires every answer. Retrying the same pending request does not create another submission. A deliberate subsequent submission creates a new attempt. Once work has submissions, create a revision to preserve its original questions and grades.

Teacher generation settings apply per chapter: an English system prompt, minimum/maximum/default difficulty, allowed question types, and output token limit. Every AI request loads the current server-owned policy; students supply typed learning inputs in user messages. Teachers' rules occupy a higher-priority developer message. Students cannot send system messages, model settings, token limits, or policy overrides through these endpoints. Types/difficulty are validated before generation and generated question schemas are checked afterward. Similar-question generation rejects copied concrete numeric vectors or substantive source stems, retries once, then reports a failure if the repetition continues.

## Analytics and definitions

Overview cards link to filtered evidence tables. The explorer groups data by student, chapter, assignment, question, Kiwi material, or complete session. Source filters distinguish CSS Lab from Kiwi, with original record IDs, lecture pages, code/output and conversation threads in the evidence. It supports name/ID search, sorting, chapter/assignment filters, and filters for answer attempts, R runs, R errors, successful runs, or Kiwi questions.

- A session represents one student working on one question, code workspace, or dialogue thread in a browser session. Repeated attempts, code, and dialogue about that question are grouped together. Thirty minutes of inactivity starts a new session.
- Course progress counts completed chapters; the current chapter remains in progress. Active students means meaningful activity in the last seven days.
- Average answer attempts and interactions divide all recorded activity by students with recorded activity. Timing heartbeats are excluded from interactions. Per-row averages use students represented in that row.
- Checked accuracy uses automatically checked attempts. Ungraded/open-ended homework is not counted as incorrect. Homework attempts count per-question submitted snapshots.
- Question evidence shows answer/option counts and shares, including unused authored options. It displays up to 50 distinct answers; shares use all matching attempts. Raw student questions are paginated.
- Repeated questions use normalized exact text. Shared topics use named keyword rules with original examples and session links; they are candidates for teacher inspection, not inferred diagnoses.
- Data Hub scores use the latest graded submission. Active minutes estimate CSS Lab engagement from visible-page activity heartbeats; they do not estimate time spent reading in native Kiwi. CSV export neutralizes spreadsheet formula prefixes.

Original event payloads and timestamps are retained. Old homework attempts missing question-level telemetry are recovered from actual submission snapshots and explicitly labeled. Legacy events without enough chapter information remain unattributed. Existing authored assignments, answers, feedback, and grades are preserved in their original language.

Analytics aggregate indexed session counters on the server instead of downloading the full event log. Table responses default to 25 rows and cap at 100; full-session events use 100-event cursor pages. Teacher authoring loads 20 assignments per page; grading loads 10 submissions plus only their associated questions. Assignment dropdowns use lightweight metadata. Students load question bodies and up to 100 latest submissions for the selected assignment. AI concurrency is bounded and requests are rate-limited. See [Kiwi integration and limits](docs/architecture-v0.5.0.md) and the [Lab workflow architecture](docs/architecture-v0.4.0.md).

## Official Kiwi demo

The existing full local demo includes the official Kiwi UI/backend, PostgreSQL, Redis, and MinIO. Current installation is retained:

```bash
npm run demo:start
npm run demo:status
npm run demo:stop
```

For a fresh installation, configure the server key, install Docker Desktop and dependencies, then run:

```bash
npm run demo:setup
npm run demo:start
```

Open [Kiwi login](http://localhost:3001/login). Accounts are in `.local/demo-credentials.json`; the app teacher key is in `.local/app-access.json`. They are not bundled in the browser. The setup pins Node.js 24.21.0 and upstream repositories, and retains existing app assignments/submissions. New example content is English; legacy demo titles are matched without duplicating or rewriting existing work.

From Kiwi’s student home or teacher class list, use **Open CSS Lab** below the course card. **Back to Kiwi** returns to the course Materials page (student) or class list (teacher). The host SDK supplies an app token; the Lab server verifies course membership and permissions with Kiwi. Embedded teachers use Kiwi sign-in, without a second local teacher key.

The [global teacher entry](http://localhost:3001/admin/app/ics-r-lab) resolves the courses where CSS Lab is enabled: one opens automatically, several require a selection, and a lookup failure offers a retry. Ordinary instructors use their teaching assignments; administrators use their existing course access. Standalone teacher pages link to **Sign in with Kiwi** and label the independent demo-key form separately. Initialization failures offer retry and return navigation instead of leaving a spinner running.

Teacher analytics refresh native Kiwi activity automatically while open and offer **Refresh Kiwi activity**. Native scratchpad runs, lecture page events, and AI questions/responses join Lab evidence without erasing their source. **Course management → Kiwi materials** links lecture materials to Lab chapters. Historical code outcomes without the corrected capture metadata remain unknown.

Lab AI generation and tutoring still use server-owned teacher policy. Native Kiwi conversations remain in Kiwi; the Lab imports an analytics projection. Historical records from this Lab’s old SDK chat are excluded from the native import to avoid counting them twice. See the [integration architecture](docs/architecture-v0.5.0.md), [local demo guide](docs/local-kiwi-demo.md), and [partial independent browser review](docs/reviews/2026-10-15-v0.5.0.md).

Register the app with an existing local Kiwi installation:

```bash
node scripts/register-kiwi-app.mjs --kiwi-repo /path/to/kiwi --list-classes
node scripts/register-kiwi-app.mjs --kiwi-repo /path/to/kiwi --class <classId>
```

## Course examples and boundaries

The supplied `190 css_KIWI integration materials_09162026` informed editable examples: CSS/digital-data ethics, base R/import/wrangling, flights/joins/visualization, lyrics/text preprocessing, and social networks. This is an inferred skill mapping, not an authoritative syllabus. The app does not publish the supplied answer files. Teachers must check examples, reference answers, attached data, and rubrics before assigning them. Student work APIs redact reference answers and explanations.

R code executes in browser webR, never on the Python server. CSV/RDS/TXT can be loaded into `/home/web_user/`; webR-compatible packages can be installed as needed. The current workspace is a text console and does not render plots. Package availability, large datasets, and external networks require separate verification.

This remains a local pilot. Embedded courses require a server-verified Kiwi app token and current course permissions. Standalone demo identity and its teacher key apply to unlinked demo courses. Shared deployment still requires HTTPS, managed persistence and retention, and deployment/load validation. No production-capacity claim is made from local API checks or a query benchmark.

## Validation

```bash
npm run build
npm test
python3 -m unittest server.test_app server.test_kiwi_bridge -q
node scripts/verify-r-capture.mjs
python3 scripts/benchmark-analytics.py --sessions 100000
```

[Independent v0.5.1 review](docs/reviews/2026-10-15-v0.5.1.md) found three additional entry defects, all corrected and retested in 14 DOM cases. [v0.5.1 engineering verification](docs/reviews/2026-10-15-v0.5.1-engineering.md) records actual sign-in/course APIs, authorization checks, builds, and preservation. Required browser review is **incomplete** after the session was stopped: teacher UI, student regressions, and true narrow-viewport checks remain pending. The [v0.5.0 browser review](docs/reviews/2026-10-15-v0.5.0.md) records earlier student launch/SSO/return and native lecture chat; [v0.5.0 engineering validation](docs/reviews/2026-10-15-v0.5.0-engineering.md) records ingestion and real-R checks. Earlier reports: [v0.4](docs/reviews/2026-10-15-v0.4.0.md), [v0.3](docs/reviews/2026-10-14-v0.3.0.md), [v0.2](docs/reviews/2026-10-12-v0.2.0.md).

Theme/fonts match the active local `NYUSH-ML/kiwi-ui` commit `fbc29beab4c6063c07fcf273d89e7237fad850b7`. Both `src/Theme.ts` and `public/kiwi-design-tokens.css` were checked: active primary is Purple 800 (`#6A1B9A`), while public tokens still use Purple 700. Montserrat is self-hosted; success/error retain their semantic colors.
