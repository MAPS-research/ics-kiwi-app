# CSS Kiwi Lab 0.6.0

CSS Kiwi Lab is a local learning app for SOCS-SH 190 *Introduction to Computational Social Science*. Students practise R in the browser (webR), answer and submit assignments, and get help from an AI tutor ("Ask Kiwi") that will not hand out graded answers. Teachers author assignments, grade with rubrics and release grades, set AI tutor rules per chapter, follow each student's activity and export data for teaching or research. The app runs on its own (standalone, with a local teacher key) or embedded in a [Kiwi](https://github.com/NYUSH-ML/kiwi) course, where Kiwi verifies every user. It is a local pilot: one Python process and one SQLite file.

> **This computer only.** The app listens on `127.0.0.1`, so it works only in a browser on the computer that runs it. Students on other devices cannot connect. Use it on a shared or lab machine, or for demos. Serving a class over a network needs a proper hosted deployment, which v0.6.0 does not provide.

[CHANGELOG](CHANGELOG.md) · [Architecture spec](docs/architecture-v0.6.0.md) · [Owner decisions D1–D8](docs/handoff/v0.6.0-decisions.md) · [Open questions](docs/handoff/v0.6.0-open-questions.md) · [Agent deployment runbook](set_up_for_agent.md)

## 中文速览

**是什么。** CSS Kiwi Lab 是 SOCS-SH 190（计算社会科学导论）的本地学习应用：学生在浏览器里用 webR 跑 R、做作业并提交、向 Ask Kiwi 求助（计分作业默认只给提示，且在答案受保护期间服务器会改写或遮挡泄露最终答案的回复）；教师出题、按评分标准批改并发布成绩、按章节设置 AI 助教规则、查看学生活动、导出教学或研究数据。可以独立运行（本地教师 key），也可以嵌入 Kiwi 课程（由 Kiwi 验证身份）。这是仅限本机（127.0.0.1）访问的本地试点：只有运行它的这台电脑上的浏览器能打开，学生无法从自己的设备连接；面向全班的网络部署需要另行托管，v0.6.0 不提供。

**给谁用。** 课程教师和助教（Teacher workspace）、学生（Student workspace）、研究人员（researcher 角色，只看化名和同意参与研究的学生），以及负责在本机部署的人或 coding agent。

**五步快速开始（独立模式）：**

1. `git clone https://github.com/MAPS-research/ics-kiwi-app.git && cd ics-kiwi-app && git checkout codex/css-lab-v0.6.0`
2. `cp .env.example .env`，把已有的 `KIWI_TEACHER_KEY=` 这一行改成一个长随机值（例如 `openssl rand -hex 24` 的输出），不要在下面另加一行：同名变量出现多行时，API 和演示脚本都只用第一行，并给出警告（只列变量名，不显示值）。需要 AI 时再填 `OPEN_AI_TEST_KEY=`。
3. `npm install`（会把 webR 运行时复制到 `public/webr`）
4. `npm run dev:all`（API 在 `127.0.0.1:8101`，界面在 `127.0.0.1:8100`）。如果 API 端口已被占用，API 会在打开数据库之前退出，并提示 `Kiwi Lab API did not start: port 8101 on 127.0.0.1 is already in use …`。
5. 在**同一台电脑**的浏览器打开 `http://127.0.0.1:8100/entry`：教师端用第 2 步的 key 登录，学生端选择演示学生或使用教师生成的 `#demo=` 链接（链接也只能在这台电脑上打开）。

**当前状态。** 没有未解决的 blocker 或 major。第 7 轮浏览器复测发现的六个 minor（K-m01–K-m06）已在 2026-10-23 修复并有回归测试，但还没有经过独立的浏览器复测。仍未解决的问题、未测试的部分和推迟的功能见下文 [Known limitations and open questions](#known-limitations-and-open-questions)。

**延伸阅读。** 本 README 的各章节（教师指南、学生指南、数据与隐私、运维、故障排查）；本地 Kiwi 演示见 [docs/local-kiwi-demo.md](docs/local-kiwi-demo.md)（中文）；让 Codex / Claude Code 自动部署见 [set_up_for_agent.md](set_up_for_agent.md)；设计细节见 [architecture-v0.6.0.md](docs/architecture-v0.6.0.md)。

## What's in v0.6.0

- **Teacher workspace rebuilt around the teaching week**: seven sections (Home, Assignments, Grading, Students, Chapters & AI tutor, Insights, Course settings), a shared time range, Presentation mode (pseudonyms everywhere) and Preview as student.
- **Assignments and grading**: late policies, attempt limits, timed homework, revisions, server-side drafts, per-question rubric grading with drafts and release, gradebook and LMS CSV export.
- **AI tutor rules per chapter and group**, saved as versions, with a test bench and saved checks. A deterministic **final-answer guard** rewrites or redacts replies that would leak a protected homework answer.
- **The server is the source of truth** for answer checks, submissions, AI provenance and grades. Telemetry goes through a durable browser outbox and is deduplicated by `eventId`.
- **People and governance**: roster import, research consent, groups with seeded randomization, four staff roles (instructor, TA, viewer, researcher), audit log, anonymize/delete, retention, research package with codebook.
- **Course package and template**: a 12-chapter SOCS-SH 190 Spring 2026 template.
- **Standalone hardening**: no default teacher key, rate-limited key checks, signed demo-student sessions.

Full list, design rationale and caveats: [CHANGELOG](CHANGELOG.md).

## Requirements

| Item | Standalone | Kiwi demo | Notes |
| --- | --- | --- | --- |
| OS | macOS (verified). Linux probably works but is **not verified**. Windows is **not supported** (`dev:all` spawns `python3` and `npm` without a shell). | macOS arm64 or x64 only (`scripts/local-kiwi/setup.mjs` refuses other platforms) | |
| Node.js + npm | Node 20, 22 or 24+ | same | vitest 4.1.11 does not support Node 21 or 23. Verified with Node 22.16.0 / npm 10.9.2. The demo downloads its own Node 24.21.0 for Kiwi. |
| Python | 3.10+ on `PATH` as `python3` | same | Standard library only, so there is nothing to `pip install`. The scripts call bare `python3`, so make sure it resolves to 3.10+ (a conda Python is fine). Verified with 3.13.5. |
| SQLite (inside Python) | JSON1 and window functions | same | `npm run test:server` asserts SQLite ≥ 3.45. Check with `python3 -c 'import sqlite3; print(sqlite3.sqlite_version)'`. |
| `sqlite3` CLI | for manual backups | same | Optional. Python can make the same backup (see [Operations](#operations)). |
| R | not needed | not needed | R runs in the browser through webR 0.6.0. The server never runs R. |
| Git | to clone; the repository is private, so you need GitHub access | required (the demo clones the private `NYUSH-ML/kiwi` and `NYUSH-ML/kiwi-ui`; you need access to the `NYUSH-ML` organization) | Without access, `npm run demo:setup` stops at once with `cannot access NYUSH-ML/kiwi — check GitHub access …`; it never waits for a password. |
| Docker | not needed | Docker Desktop with `docker compose` v2 | Runs PostgreSQL (pgvector), Redis and MinIO for Kiwi. |
| OpenAI API key | optional | **required** by `npm run demo:setup` | Server-only. Without one, Ask Kiwi answers with labelled *Local guidance*. |
| Disk (measured on the development Mac) | about 330 MB (`node_modules` 278 MB, `public/webr` 47 MB) plus the database | about 3 GB more (`.local/kiwi` 0.7 GB, `.local/kiwi-ui` 1.1 GB, Node runtime 0.2 GB, npm cache 0.1 GB, Docker images about 0.9 GB), plus the growth of the Docker volumes | |
| Network | npm registry during install. Students' browsers fetch R packages from webR's public repository `https://repo.r-wasm.org` the first time code loads a package. AI calls go to `https://api.openai.com`. | plus GitHub, nodejs.org and Docker Hub during setup | |
| Browser | a current desktop browser with WebAssembly | same | |

## Quick start (standalone)

From an empty directory:

```bash
git clone https://github.com/MAPS-research/ics-kiwi-app.git   # private repository: needs your GitHub access
cd ics-kiwi-app
git checkout codex/css-lab-v0.6.0      # v0.6.0 lives on this branch until PR #2 is merged
cp .env.example .env
python3 -c 'import re,secrets,pathlib; p=pathlib.Path(".env"); p.write_text(re.sub(r"(?m)^KIWI_TEACHER_KEY=.*$", "KIWI_TEACHER_KEY="+secrets.token_hex(24), p.read_text(), count=1))'
npm install
npm run dev:all
```

The `python3 -c` line fills in the empty `KIWI_TEACHER_KEY=` line of a **fresh** `.env` with a 48-character random key and prints nothing. It replaces any key already on that line, so do not re-run it on a `.env` you want to keep. You can also edit the line by hand with the output of `openssl rand -hex 24`. To read the key later: `grep '^KIWI_TEACHER_KEY=' .env`.

Then open, in a browser on this computer:

- [http://127.0.0.1:8100/entry](http://127.0.0.1:8100/entry): choose a workspace.
- [http://127.0.0.1:8100/teacher/home](http://127.0.0.1:8100/teacher/home): teacher. Paste the key into **Local demo or staff access key** and click **Open local demo workspace**.
- [http://127.0.0.1:8100/student/assignments](http://127.0.0.1:8100/student/assignments): student. Pick **Demo student** (Ada Chen or Bo Lin), or open a teacher-made `#demo=` link.

Stop with Ctrl-C (it stops both processes).

**Other ports.** Use this when 8100 or 8101 is already taken. First check what holds the port, for example `lsof -nP -iTCP:8101 -sTCP:LISTEN` (the `COMMAND` and `PID` columns). If it is this checkout's own API (for example an older version you started earlier), stop it instead: a second API on another port would use the same `data/kiwi-lab.sqlite3`, and v0.6.0 would migrate the file while the old API keeps writing to it. v0.6.0 refuses a busy port before it opens the database, but it cannot tell that another API serves the same file on a different port. `KIWI_API_PORT` must be set in the shell for both processes: Vite reads it to point its `/api` proxy at the API, and it does not read it from `.env`. (`npm run demo:start` is the exception: it also reads `KIWI_API_PORT` from `.env` and passes it to both; see [Full local demo](#full-local-demo-macos).)

```bash
# terminal 1: API on 8401
KIWI_API_PORT=8401 python3 server/app.py
# terminal 2: UI on 8421, proxying /api to 8401; --strictPort fails instead of silently moving to another port
KIWI_API_PORT=8401 npx vite --host 127.0.0.1 --port 8421 --strictPort
```

`KIWI_API_PORT=8401 npm run dev:all` also works. It moves the API and the proxy, and the UI stays on 8100.

**AI (optional).** Put the key in `.env` as `OPEN_AI_TEST_KEY=…` (or `OPENAI_API_KEY=…`), then restart the API. Never put it in a `VITE_` variable: those are shipped to the browser.

## Configuration

The API reads `<repo>/.env` **once at start**, whatever the current directory. Real environment variables override `.env`, and quotes around values are stripped. After editing `.env`, restart the API. The demo scripts (`npm run demo:*`, `scripts/local-kiwi/`) parse the same file the same way (first line wins, quotes stripped). `demo:setup` takes the AI key, the teacher-key check and `KIWI_DEMO_MODEL` from `.env` only, while the scripts' `KIWI_API_PORT` lookup prefers the shell, as the API does. Vite reads `VITE_*` variables from `.env` and reads `KIWI_API_PORT` from the shell only.

> **Keep one line per variable.** The API (`server/app.py`, `load_dotenv`) and the demo scripts (`scripts/local-kiwi/config.mjs`, `readEnv`) both use the **first** line of a name and ignore the later ones. Both print one warning that names the repeated variables, never their values: `Warning: .env sets KIWI_TEACHER_KEY on more than one line; the first line of each is used.` `.env.example` already contains an empty `KIWI_TEACHER_KEY=` line. If you append a second `KIWI_TEACHER_KEY=…` line below it, the empty first line still wins and the teacher workspace stays closed, so edit the existing line instead.

### API server

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KIWI_TEACHER_KEY` | for standalone teacher access | none | Instructor key, sent as the `X-Teacher-Key` header. Unset: the teacher workspace answers `503 teacher_key_not_configured`, and staff keys stop working too. Use 32+ random characters. |
| `OPEN_AI_TEST_KEY` / `OPENAI_API_KEY` | no (yes for `demo:setup`) | none | Server-only AI key. The API prefers `OPENAI_API_KEY` if both are set; `demo:setup` prefers `OPEN_AI_TEST_KEY`. Without a key, Ask Kiwi uses *Local guidance* and practice uses local templates. |
| `KIWI_DEMO_MODEL` | no | `gpt-5.4-mini` | Default model, also copied to the demo Kiwi as its chat model. |
| `KIWI_MODEL_ALLOWLIST` | no | value of `KIWI_DEMO_MODEL` | Comma list of models teachers may pick in AI tutor rules. |
| `KIWI_AI_CONCURRENCY` | no | `4` (1–64) | Concurrent provider calls per process. |
| `KIWI_AI_QUEUE_WAIT_S` | no | `20` (0–120) | Longest wait for a free slot before `503 ai_busy` (also after 32 waiting requests). |
| `KIWI_AI_PER_IP_PER_MINUTE` | no | `60` | AI requests per client address per minute, standalone classes only. |
| `KIWI_STANDALONE_CLASS_IDS` | no | `local-r-class` | Standalone classes that accept student writes before a course is saved. The standalone UI always uses `local-r-class`. |
| `KIWI_SERVER_OWNED_EVENTS` | no | empty = `enforce` | `accept` stores client copies of server-owned events, flagged as client-reported. Other values are ignored. |
| `KIWI_DB_PATH` | no | `<repo>/data/kiwi-lab.sqlite3` | Database file. The parent directory is created. A relative path is resolved against the current directory, so prefer an absolute path. |
| `KIWI_API_PORT` | no | `8101` | API port. The API always binds `127.0.0.1`. If the port is taken, the API exits with code 1 before it opens the database. `npm run demo:start`, `demo:status`, `demo:seed` and `verify-integration.mjs` use the same value (shell, then `.env`, then 8101). |
| `KIWI_GIT_SHA` | no | `git rev-parse HEAD`, else `unknown` | Commit recorded in research packages. |
| `KIWI_API_ORIGIN` | for Kiwi-linked use | `http://localhost:3000` | Kiwi API used to verify tokens and import activity. Must be HTTPS or loopback HTTP. |
| `KIWI_CLASS_IDS` | no | `local-css-demo` | Classes treated as Kiwi-linked. A class also becomes linked the first time a Kiwi token is used for it, and nothing in the app un-links it. Do not add `local-r-class`. |

### Frontend (Vite)

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `KIWI_API_PORT` | shell only | `8101` | Target of the `/api` proxy (2–5 digits, otherwise the config throws). `npm run demo:start` passes it to Vite for you. |
| `VITE_KIWI_ORIGIN` | `.env` | `http://localhost:3001` | Kiwi UI origin: SDK bundle, the teacher's **Open Kiwi** link and the return page. `demo:setup` writes it. |

Not used at run time: `VITE_KIWI_CONTEXT_PROMPT_ID` appears in `.env.example`, but no code reads it (use `scripts/register-kiwi-app.mjs --context-prompt <id>`). `KIWI_SNAPSHOT_DBS` is read only by the migration tests.

### Scripts

| Variable | Used by | Purpose |
| --- | --- | --- |
| `KIWI_UI_DIR`, `KIWI_BACKEND_DIR` | `npm run test:bridge`, `scripts/local-kiwi/frontend.mjs` | Point the bridge tests and UI patches at another Kiwi UI or backend tree. |
| `KIWI_R_LAB_BASE_URL`, `KIWI_URL`, `KIWI_REGISTRATION_SECRET`, `DATABASE_URL` | `scripts/register-kiwi-app.mjs` | App base URL (default `http://127.0.0.1:8100`), Kiwi API (default `http://localhost:3000`), registration secret, Kiwi database (default: taken from `<kiwi repo>/.env`). |

## Running

### Ports

| Service | Default address | Override |
| --- | --- | --- |
| App API | `127.0.0.1:8101` | `KIWI_API_PORT=<port> python3 server/app.py`; for `npm run demo:start`, `KIWI_API_PORT` in the shell or in `.env` |
| App UI (Vite dev or preview) | `127.0.0.1:8100` | `KIWI_API_PORT=<api port> npx vite --host 127.0.0.1 --port <port> --strictPort`; fixed at 8100 under `demo:start` |
| Kiwi API / Kiwi UI (demo only) | `localhost:3000` / `127.0.0.1:3001` | fixed |
| Demo PostgreSQL / Redis / MinIO / MinIO console | `127.0.0.1:5433` / `6380` / `9002` / `9003` | fixed |

`npm run dev` has no `--strictPort`: if 8100 is busy, Vite moves to the next free port without failing.

The API binds its port first and opens the database only after that. If the port is busy, it exits with code 1 and the database is not opened or migrated:

```
Kiwi Lab API did not start: port 8101 on 127.0.0.1 is already in use. Stop the other process (lsof -nP -iTCP:8101 -sTCP:LISTEN) or set KIWI_API_PORT; the database was not opened.
```

Any other listen error reads `cannot listen on 127.0.0.1:<port> (…)` in the same sentence. Once the port is bound and the migrations have run, the API prints `Kiwi Lab API: http://127.0.0.1:<port>` and starts serving; requests that arrive during the migrations wait in the socket's queue.

`npm run demo:start` keeps the UI on 8100, because the Kiwi app registration points there. It runs the app API on `KIWI_API_PORT` (shell, then `.env`, then 8101), polls readiness on that port and gives Vite the same value.

### Development (foreground)

```bash
npm run dev:all            # API + Vite; logs in this terminal; Ctrl-C stops both; if one exits, both stop
```

Or run them in two terminals: `python3 server/app.py` and `npm run dev`. Run both from the repo root.

### Background with log files

There is no built-in daemon for standalone mode. This pattern keeps pid and log files in the git-ignored `.local/standalone/`:

```bash
mkdir -p .local/standalone
nohup env KIWI_API_PORT=8101 python3 server/app.py >> .local/standalone/api.log 2>&1 < /dev/null &
echo $! > .local/standalone/api.pid
nohup env KIWI_API_PORT=8101 BROWSER=none node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 8100 --strictPort >> .local/standalone/ui.log 2>&1 < /dev/null &
echo $! > .local/standalone/ui.pid
curl -s http://127.0.0.1:8100/api/health     # after a few seconds; through the UI proxy, so it checks both processes
```

Stop them:

```bash
kill "$(cat .local/standalone/ui.pid)" "$(cat .local/standalone/api.pid)"
rm -f .local/standalone/ui.pid .local/standalone/api.pid
```

### Build and preview

```bash
npm run build              # tsc -b && vite build → dist/ (needs public/webr; only a chunk-size warning is expected)
npm run preview            # serves dist/ on 127.0.0.1:8100 and proxies /api to KIWI_API_PORT (default 8101)
python3 server/app.py      # the API does not serve the UI; run it next to the preview
```

The Python API does not serve static files. Any path that is not an API route answers `404 {"error": "Endpoint not found", "code": "not_found"}`. If you host `dist/` elsewhere, reverse-proxy `/api` to the API on loopback and forward `X-Forwarded-For`. The rate limits use the right-most entry of that header for loopback peers.

### Stopping

- `npm run dev:all`: Ctrl-C.
- Background processes started as above: the `kill` command above.
- Kiwi demo: `npm run demo:stop`. It stops only the processes that `demo:start` started and recorded in `.local/services.json`, then stops the demo containers. An API or Vite you started yourself keeps running.

## First-time setup for a course

These steps use a standalone course. A standalone browser session always uses class `local-r-class`. A Kiwi-linked course is set up the same way, but you sign in through Kiwi (see [Kiwi integration](#kiwi-integration)).

1. **Sign in as instructor.**
   1. Open `http://127.0.0.1:8100/teacher/home`.
   2. Under **Local demo access**, paste `KIWI_TEACHER_KEY` into **Local demo or staff access key** and click **Open local demo workspace**.

   The key is kept for this browser tab only (`sessionStorage`). After 10 wrong keys from one address within 60 seconds, every key, the correct one included, gets 429 until a minute has passed since the oldest failure.
2. **Course info.** Go to **Course settings › Course info**.
   1. Set **Course title** and **Description**, then click **Save course info**.
   2. Under *Grading and AI defaults*, choose:
      - whether grades for new homework become visible *When I release them* (the default) or immediately;
      - whether *Teaching assistants may release grades* (off by default);
      - the Lab AI tutor limits per student and per course per minute (defaults 15 and 120).
   3. Click **Save defaults**. The two buttons save separately.
3. **Class schedule.** Go to **Course settings › Class schedule**.
   1. Set **Time zone** (default `Asia/Shanghai`).
   2. Set **Term start**.
   3. Add the weekly meetings (day, start time, 15–300 minutes).
   4. Click **Save schedule**.

   The time range presets *This class* and *Since last class* use these meetings. Every date in the app is shown in the course time zone. Set the term start before you apply a template: the template's chapter dates move to your term start.
4. **Apply the SOCS-SH 190 template.** Go to **Course settings › Course package**.
   1. Under **Start from a template**, select *SOCS-SH 190 Introduction to Computational Social Science · Spring 2026*.
   2. Optionally set **Shift dates by weeks** (−52 to 52).
   3. Tick **Archive current chapters that nothing refers to** to archive the five built-in default chapters. A chapter that assignments, activity or materials refer to is kept.
   4. Click **Preview**. Check the chapters, weeks, R packages and the staff-only notes.
   5. Click **Apply**, and confirm if it asks (it asks when chapters would be archived).

   The template adds 12 chapters. It has no assignments, AI rules or groups. Import never overwrites or publishes anything: it adds chapters, creates assignments as drafts, appends rule versions and creates groups by name.
5. **Chapters and this week's chapter.** Open **Chapters & AI tutor › Chapters**.
   1. Review each chapter: week, title, learning goal, student access, R packages, files and error hints.
   2. Pick **This week's chapter**. This saves immediately.
   3. Set **Free practice scope**: *Current and earlier chapters* (the default), *Current chapter only* or *All chapters*.
   4. Click **Save chapters**.
6. **Add students.** Go to **Students › Roster › Import or update students (CSV)**.
   1. Paste a CSV, or click **Choose CSV / TSV**. The header row can use Student ID, Name, Email, Section, Condition; common aliases such as `netid` and `full name` are recognized.
   2. Choose **Match students by**: *Student ID*, or *Email (Kiwi accounts)*.
   3. Click **Preview changes**, then **Apply import**.

   Example CSV:

   ```csv
   Student ID,Name,Email,Section
   s-001,Ada Chen,ada@example.edu,Section 1
   ```
7. **Give students a way in (standalone).** Standalone students are not verified.
   1. In **Students › Roster**, edit a student and click **Create demo link**.
   2. Copy the link (`…/student/assignments#demo=<token>`, valid 14 days). It opens only in a browser on this computer, for example a shared lab machine.

   A link signs the student in without a password, so give it to that student only. The built-in demo students *Ada Chen* and *Bo Lin* are always available from the **Demo student** picker. Their sessions last 7 days.
8. **Staff keys and roles.** Go to **Course settings › Staff & roles**.
   1. Enter **Name** and **Role** (*Teaching assistant*, *Viewer*, *Researcher* or *Instructor*).
   2. Click **Add staff member**.
   3. Copy the key. It is shown once; click **I copied it**.

   Keys are 24 hex characters and are stored as scrypt hashes. You can revoke a key or change its role later. Staff sign in on the same gate as the instructor. In a standalone course, *Viewer* and *Researcher* keys can sign in and read, but every export they request is refused (`409 unverified_identity`), because standalone identities are not verified; see [Data, privacy and research](#data-privacy-and-research). For a Kiwi-linked course, the panel lists *Kiwi course staff* with a per-person role override instead.
9. **Privacy.** Go to **Course settings › Privacy**. Set:
   - the default name mode;
   - the research purpose and IRB protocol, which pre-fill exports and package READMEs;
   - the activity retention period;
   - whether viewers may download the research package.

   See [Data, privacy and research](#data-privacy-and-research).

To try the student side as staff, use **Preview as student** in the account menu. Preview rows are marked as tests and never counted.

## Teacher guide

**Top bar.**

- **Find a student…** searches the roster.
- The **Time** range offers This class · Since last class · This week · Last 7 days · Whole term · Custom… It appears only on the pages whose numbers follow it.
- **Presentation mode** shows pseudonyms (`S-014`) everywhere, including names inside free text. Turning it on reloads the page.
- **Open Kiwi** / **Back to Kiwi** returns to the Kiwi course.
- The account menu has **Preview as student** and **Sign out of teacher view**.

Old v0.5 URLs redirect with a "That page moved" notice. The server enforces every permission; the UI only hides what your role cannot use.

**Roles.**

| Role | How you get it | Can do |
| --- | --- | --- |
| Instructor | `KIWI_TEACHER_KEY`, an instructor staff key, or Kiwi course manager | everything |
| TA | TA staff key, or a Kiwi assistant with analytics or materials permission (D1) | grade, Insights, exports, read-only assignments and AI rules; release grades only if Course info allows it; cannot unrelease |
| Viewer | viewer staff key, or Kiwi analytics-only staff | Home, Students, Insights, read-only AI rules; exports always pseudonymized, consent-filtered and limited to Kiwi-verified identities, so a standalone course allows no viewer exports; no case files |
| Researcher | researcher staff key, or a Staff & roles override (no Kiwi role maps to it) (D3) | Insights, read-only chapters, AI rules and groups, research exports; pseudonyms and consenting students only; research ids instead of student ids; Kiwi-verified identities only, so no exports in a standalone course; every read logged; no grading, editing, roster, profiles or preview |
| Kiwi staff without a Lab role | — | Preview as student only |

### Home

1. Open **Home** to see:
   - *Needs your action*: to grade, ready to release, missing past due, late, flagged AI replies;
   - *Students needing attention*;
   - *What to re-teach* (your own questions only);
   - *What students asked the AI*;
   - *This week at a glance*, which starts with `Active this week: N of M (learning actions)`. The label follows the time range, and Course metrics uses the same label and number (see [Metric definitions](#data-privacy-and-research)).
2. Click a count to jump to the matching list. The *Missing* chip opens that assignment's missing list.
3. Instructors can edit the attention rules (**Students › Needs attention**). The defaults are:
   - no learning action for 7 days;
   - 1 or more missing assignments;
   - 5 errors on one question;
   - 6 repeated AI questions;
   - accuracy below 50 % with at least 6 checked;
   - 2 late submissions in 21 days (off by default).
4. Use **Mark to re-teach** on a question to keep it on the list.

### Assignments

Create a homework:

1. Go to **Assignments › New assignment**.
2. **Details.** Fill in:
   - **Assignment type**: *Homework (graded)* or *In-class exercise (auto-checked, not graded)*;
   - **Chapter**, **Title** and **Instructions**;
   - optional attachments: `.qmd .md .txt .pdf .csv .R .rds .zip`, at most 3 MB each.
3. **Questions.** Add up to 30 questions of these types: Multiple choice, Fill in the blank, Predict output, Complete code, Written response. Fill in:
   - the reference answer;
   - *Explanation for students (shown after a correct answer)*;
   - *Grading rubric (staff only — shown while grading)*.

   Reference answers, rubrics and grading data are never sent to students.
4. **Student help & AI.** Fill in:
   - R workspace on/off;
   - *Allow running code for Predict output questions*;
   - Ask Kiwi: *Off*, *Give hints only (never the final answer)*, *Explain concepts* or *Show worked examples*;
   - *Try a similar question* on/off.

   The note in this section shows whether, and until when, Ask Kiwi protects this homework's answers. New homework defaults to R on, Run off for Predict output, *hints only* and similar practice off.
5. **Dates & late policy.**
   - **Opens** (optional) and **Due**.
   - **Late submissions**: *Not accepted*, *Accepted until a date*, or *Accepted, marked late*. New homework defaults to *Accepted until* the due date + 7 days, and that date follows the due date until you edit it.
   - Late penalty (% per day; each started day counts) and grace minutes (0–120).
   - **Attempts allowed**: 1–100, blank = unlimited.
   - Time limit (5–600 minutes) and what happens when time runs out.
   - **Grades visible to students**: *Immediately* or *When I release*.
   - **Solutions visible**: *Never*, *After the student submits*, *After the due date* (the default; see [AI tutor rules](#ai-tutor-rules-and-the-final-answer-guard)) or *After grades are released*.
   - **Assign to**: all students, or groups.
6. Click **Save draft**, then **Preview as student** to try it (preview rows are excluded from analytics), then **Publish now**.

Other tasks:

- **Row actions** in the list: Duplicate, Create revision, Preview as student, Clear test submissions, Close submissions / Reopen, Archive / Unarchive, Delete draft. Filter by All / Drafts / Published / Closed / Archived.
- **Revisions.**
  - Once students have made real attempts, the questions lock. Rubric and tags stay editable.
  - Use **Create revision** to change the questions. Publishing a revision closes the original. The two protect each other's answers.
  - A student who submitted the original is not counted missing on the revision. A homework and its revisions count once in *Missing work* (D8).
  - The first time a student opens the revision, the answers they had saved on the closed original are copied into it, and the page says "Your answers from the earlier version were copied here." The copy happens only when the student has no draft on the revision yet and submitted no earlier version. Questions are matched through the revision's question map, and the original keeps its draft. A copy is not a learning action; it keeps the student's own draft times.
- **Close date.** The editor has no close-date field. **Close submissions** sets it now, and **Reopen** clears it.
- **Starter assignments** (`/teacher/assignments/starter`): five editable starters (In-class R basics; Homework 1–4: R basics, joins, text, networks). They target four of the built-in default chapters (`r-basics`, `data-wrangling`, `text-analysis`, `network-analysis`), so on a template course you map each one to one of your chapters or it is skipped. Check examples, answers, data and rubrics before assigning.
- **In-class results** (`…/:id/results`): *First try correct* and *Correct eventually* per question, with stuck students.

### Grading

1. Open **Grading › To grade (n)**.
2. Pick a view:
   - Show: *Latest attempts to grade*, *All attempts*, *Graded*, *Late* or *Flagged*;
   - group by student or by question.
3. On each card, enter per-question scores and comments. Auto-check scores and the late penalty are pre-filled.
4. Use **Save draft**, **Save & next ungraded** (Ctrl/⌘+Enter) or **Release** / **Save & release**. A TA without release rights sees "Your role saves drafts; an instructor releases grades."
5. Integrity flags mark submissions for review:
   - "AI reply may contain the final answer";
   - "Large paste from an AI reply";
   - identical answers of 40 or more characters.
6. Go to **Grading › Gradebook** to see every student × assignment cell. Choose the score policy *Latest* or *Highest*.
7. Go to **Grading › Release & export**:
   1. Click **Release grades** per assignment and confirm. Students see grades and comments only after release.
   2. Under **Export grades for LMS**, choose:
      - Latest or Highest attempt;
      - *Released only*;
      - layout *Wide* (one row per student) or *Long* (one row per student and assignment).
   3. Download **Grades for LMS (CSV)** or **Student × assignment status (CSV)**. `grades.csv` always uses real names, even in Presentation mode.

Only an instructor can unrelease a grade.

### Students

1. **Roster.**
   - Filter by group, consent (Any / Yes / No / Not asked) and status (Active / Dropped).
   - The definitions of *Last seen*, learning actions and *Missing work* are printed above the table. Each *Last seen* cell also shows `Last learning action: …`, and a *Missing work* count opens a list of the missing homework (a revision is listed with its original).
   - Edit a student to set the status, record a consent override (*Record Yes*, *Record No*, *Clear teacher record (use Kiwi)*) or create a demo link.
   - Import with **Import or update students (CSV)** (see [First-time setup](#first-time-setup-for-a-course)).
2. **Needs attention** lists students by rule. Instructors edit the rules here.
3. **Groups.**
   1. Create *Section*, *Experimental condition* or *Cohort* groups.
   2. Optionally assign students at random. The randomization is reproducible from a seed of 1–64 characters (`sha256-sort-v1`).
   3. **Membership history** keeps every change.
4. **Student profile** (`/teacher/students/s/<id>`) shows:
   - *Last seen* and *Last learning action*;
   - the full activity timeline and the student × assignment timeline;
   - the actions *Exclude from analytics*, *Export this student's AI conversations* and *Download case file* (instructor or TA, with a recorded purpose).

### Chapters & AI tutor

1. **Chapters.** For each chapter you can edit:
   - Week (1–60), title, **Learning goal** and **Student access** (*Follows free practice scope*, *Open*, *Review only*, *Hidden*);
   - **Chapter notes (staff only)**;
   - R packages, chosen from the allowlist ("base R only" when none);
   - chapter files: **Chapter dataset**, and **Use as AI reference (text, ≤ 8,000 chars)**;
   - error hints.

   Add, archive, unarchive or remove chapters, then click **Save chapters**. A chapter that assignments, activity or materials refer to cannot be removed; archive it instead.
2. **This week's chapter** saves as soon as you pick it.
3. **AI tutor rules** (`…/chapters/ai`): open the course default or a chapter, and optionally a section or condition group.
   1. Edit the fields:
      - *Instructions for Ask Kiwi (tutoring)* and *Instructions for generated practice*;
      - reference notes;
      - help level, reply language, difficulty range and rubric, question types;
      - max reply length and conversation memory;
      - model and reasoning effort;
      - *What the AI sees* (default: code, error, output, instructions);
      - feedback reveal rules and free-practice limits;
      - per-chapter on/off switches for Ask Kiwi and generated practice.
   2. Click **Save as new version**.

   Use **Version history**, **Compare**, **Restore**, copy and **Reset to course default** as needed. Only instructors edit rules; other roles read them.
4. **Test this rule.**
   1. Choose an action, a sample (free text or a homework question), the type and difficulty, and optionally *Add an injection attempt*.
   2. Click **Show assembled prompt** for a dry run (no key needed, nothing written), or **Run test** for a real call logged as a teacher test.
   3. Click **Save as saved check** with an expectation (for example *Guard: no final answer*).
   4. Re-run all checks with **Run saved checks**. The dry run is forced on when no AI key is set.
5. **AI-generated practice** lists the items Ask Kiwi generated. TAs and instructors flag or unflag them; instructors retire or restore them.
6. **Linked lecture materials** (Kiwi-linked courses) maps Kiwi materials to chapters.

### Insights

1. **AI conversations.**
   - Filter by chapter, group, student, assignment, *Flagged* or *Uncoded*.
   - Open a thread to see *Show original reply (staff only)* and *Show instructions sent*, and use **Clear flag**.
   - Coding mode applies the codebook to threads; **This thread (CSV)** downloads one thread.
2. **Activity explorer.**
   - Filter by *Where* (All / CSS Lab / Kiwi lectures & scratchpad) and *Work* (All / Free practice only / Assigned work only).
   - Tick *Include teaching staff* to add staff activity.
   - The column presets are *Teaching* and *Research*.
   - In the *Students* group the Teaching columns are Student, *Last learning action*, *Last seen*, Attempts, Auto-checked accuracy (your questions), AI tutor questions (incl. hints) and Missing work. *Assignments*, *Lecture reading* and *Study sessions* show *Last seen*. Both stamps are sortable.
   - The population line above the table counts students with a learning action, as Home does.
3. **Course metrics.** *Active* (with the same label and number as Home), weekly trends, learning curve, time on task, "AI practice difficulty: requested vs observed".
4. **Exports.** See [Data, privacy and research](#data-privacy-and-research).
5. **Data health** shows:
   - activity received, outage periods, AI requests (including requests turned away);
   - active time, identity, the client data contract;
   - the Kiwi import status, and data past the retention period.

### Course settings

Course settings is for instructors only. It has six tabs:

- **Course info**: title, description, grading and AI defaults.
- **Class schedule**: time zone, term start, meetings.
- **Kiwi connection**: link status, with shortcuts to Linked lecture materials and Data health. While a teacher page is open, native Kiwi activity syncs every 30 s.
- **Staff & roles**: staff keys (standalone), or Kiwi staff role overrides (linked). A Kiwi staff member must have opened the Lab once before you can override their role, and you cannot change your own role.
- **Privacy**:
  - email display, default name mode, research purpose and IRB, retention and viewer research exports;
  - **Run retention now**;
  - **Delete or anonymize one student**;
  - the audit log.
- **Course package**:
  - **Download course package** (chapters, assignments, AI tutor rules, group names and course files; no student data);
  - **Start from a template**;
  - **Import a course package** (`.zip` up to about 15 MB, because it is sent base64-encoded in a 20 MB request; at most 200 files, 5 MB each, 60 MB uncompressed).

  Shift dates and archiving work as described in setup step 4. ZIP import is not yet verified in a browser review (see [Known limitations](#known-limitations-and-open-questions)); try it on a copy of the database first.

## Student guide

1. **Sign in.**
   - Kiwi course: open the course in Kiwi and click **Open CSS Lab**.
   - Standalone: open the `#demo=` link from your teacher, or pick a **Demo student** at `/student/assignments`.
2. The menu has **Assigned work**, **Practice with AI**, **R workspace**, **Ask Kiwi** and **Course outline**.
3. **Do an assignment.** Open it from Assigned work. The tabs **Answer & submit**, **R workspace**, **Ask Kiwi** and **Try a similar question** appear when the assignment allows them.
   - Answers save to the server about 2 seconds after you stop typing and come back on another device. The browser keeps a copy if you go offline.
   - Submitting follows the assignment's due date, late policy, attempts and time limit. Timed homework submits itself at 0:00 and keeps blank answers blank.
   - A homework your teacher closed before its due date reads `Closed early · due …`; one closed after its due date reads `Closed · was due …`.
   - When your teacher publishes a new version of a homework you had started, the old one closes and links to the new one. The new version opens with the answers you had saved on the old one ("Your answers from the earlier version were copied here."), unless you already submitted the old one.
   - Grades and comments appear when your teacher releases them, or right away if the homework is set to show grades immediately.
4. **Run R.**
   - The R workspace runs webR in your browser. Values print automatically and plots render.
   - Each question has its own R environment.
   - The default time limit is 12 seconds; after that R is reset.
   - Allowlisted R packages (31) install on first use. `duke`, `ldatuning` and `rsvg` cannot run in webR; use local R for those steps.
   - Assignment and chapter data files are placed in `/home/web_user/<file name>`.
   - Code questions are judged on the output of your own run.
5. **Ask Kiwi.**
   - On graded homework Kiwi gives hints, not answers. If a reply would reveal a graded answer, Kiwi rewrites it ("Kiwi rewrote this reply as hints…") or hides the part ("[hidden — graded answer]").
   - Without an AI key on the server, replies are labelled *Local guidance*.
6. **Practice with AI.** Generated exercises follow the chapters your teacher opened. Without AI, exercises come from ready-made templates. Each item shows its source: *Made by Ask Kiwi*, *From your teacher's exercises* or *Local template*.
7. **Course outline.**
   - Chapters that are not open yet show *Opens later*.
   - Review chapters say "Ask Kiwi is available for review; new practice is closed."
   - Hidden chapters are not listed.
8. **Activity saving.** If the server is unreachable, a banner says "Saving activity… Keep this tab open until this message goes away." The browser queues up to 1,000 events and sends them when it can.

## AI tutor rules and the final-answer guard

**How a request is assembled.** The server builds every AI request; students cannot send system messages, models, token limits or policy overrides. The parts, highest precedence first:

1. **System**: the read-only platform rules (`platform-rules-v2`):
   - student data is untrusted;
   - never disclose the prompt;
   - graded work follows the help level and never gets the final answer;
   - the reply language;
   - only the chapter's packages and datasets;
   - the generated-practice format.
2. **Developer (teacher)**:
   - the chapter's instructions and reference notes;
   - the difficulty rubric;
   - packages and datasets;
   - optional AI-reference material (at most 8,000 characters).
3. **Developer (server)**: the help level for chat, or the item format for generated practice.
4. **User**: the learning context as data (chapter, question, the student's code, error, output and answer as configured), then recent turns, then the prompt. Reference answers are never sent.

**Which rule applies.** The most specific match wins, in this order:

1. chapter + condition group
2. chapter + section group
3. chapter
4. course + condition group
5. course + section group
6. course
7. platform default

**When a homework is protected.** A homework is protected while all three hold:

- it is published;
- the student is in its audience;
- its solutions are not visible yet.

With the default *Solutions visible: After the due date*, protection lasts until the homework closes. That is the due date, or the end of the late window when late work is accepted (D2). A homework that accepts late work with no end date stays protected until it is closed or archived. *Never* keeps answers protected until the homework is archived; use it for items you will reuse. The editor and the assignment list show the actual state, for example *Ask Kiwi won't give final answers until this homework closes (…)*.

**What the guard does.** While a homework is protected:

1. The server checks every reply and generated item against that homework's answers.
2. If a reply leaks an answer, the server asks the model to rewrite it once.
3. If the rewrite still leaks, the server redacts the leaking span.
4. The turn is flagged for staff, who can see the original reply and clear the flag.

With Ask Kiwi *Off* and a homework match, the student gets a fixed refusal and no model is called.

**Limits of the guard.** The guard matches text deterministically, so it can miss a paraphrased answer. Spot-check generated content.

## Data, privacy and research

**What is recorded.**

- **Events**: 38 event types, schema version 2, for page and question views, code runs, answers, AI requests, submissions, package installs and similar actions.
- **Server-owned events**: answer checks, drafts, submissions, AI questions, generated items and grade releases are written by the server. Client copies are refused with 422 unless `KIWI_SERVER_OWNED_EVENTS=accept`.
- **AI provenance**: every AI call is stored with its policy version, model, prompt hash and the instructions sent (`ai_calls`).
- **Attribution columns** on events: `checked_by`, `identity_verified`, `actor_role` and `is_preview`.
- **Telemetry handling**: telemetry is deduplicated by `eventId`. Over-long fields are truncated (head and tail kept) instead of rejected.

**Who is counted.** Counts include enrolled, non-excluded, non-staff and non-preview students. This is decided when a number is computed, so roster fixes apply to past data. Names come from the roster, never from events.

**Metric definitions.**

- **Enrolled**: active, non-excluded roster students.
- **Learning action**: an answer (submitted, saved as a draft, or checked in the Kiwi scratchpad), a code run, an AI question (hint requests included) or a submission (`analytics.LEARNING_ACTION_TYPES`). Page views, time on a page, settings changes and opening work are not learning actions.
- **Active (range)**: enrolled students with at least one learning action in the range. Home's glance, Course metrics, the Activity explorer's population line and the weekly trend all use this definition (`analytics.learning_action_sql`). *Logged actions* (Research preset) still counts every action-category event.
- **Active minutes**: counted heartbeats × 0.5 (one per 30-second bucket while the page is visible and in use).
- **Auto-checked accuracy (your questions)**: server-checked correct ÷ server-checked attempts on teacher-authored questions.
- **Similar practice accuracy (AI)**: the same ratio, on similar items.
- **First try correct %** and **mean tries to correct** (What to re-teach): per question; a question needs 3 or more students in the range.
- **Question activity**: one student's work on one question, item or thread. Events less than 30 minutes apart belong to the same activity.
- **Last seen**: newest event of any kind, page views and heartbeats included (roster, profile, explorer). **Last learning action**: newest learning action (profile, roster cell, explorer *Students*, the *No learning actions* attention rule).
- **Missing work**: published homework in the student's audience, past due (after grace), with no submission. A homework and its revisions count once, on the newest version (D8).
- **AI requests turned away / failed**: requests that were unavailable, busy, rate-limited, blocked by policy, or failed with a provider or validation error.

**Exports** (**Insights › Exports**; each one is recorded in the audit log):

| Export | Format | Who |
| --- | --- | --- |
| Grades for LMS; Student × assignment status | CSV | instructor, TA |
| Activity log; AI conversations; Generated practice items | CSV or JSONL | instructor, TA, viewer\*, researcher\* |
| Coded conversations | CSV | instructor, TA, viewer\*, researcher\* |
| One student's case file (README, AI conversations, submissions, item scores, timeline) | ZIP, with a purpose of 5–500 characters | instructor, TA |
| Research package | ZIP | instructor, researcher\*, viewer\* (only if Privacy allows viewers) |
| Codebook | `codebook.md` | any staff role |

\* Viewers and researchers get de-identified, consent-filtered rows of Kiwi-verified students only. In a standalone course every export they request is refused (`409 unverified_identity`), because standalone identities are never verified. Only an instructor can export standalone demo data (the research package with *Include unverified (demo) identities*).

- **File formats.** Teaching CSVs use a UTF-8 BOM, CRLF and spreadsheet-formula neutralization. Research files are plain UTF-8.
- **Research package contents.**
  - README, `codebook.md`, `participants.csv`, `events.csv`, `ai_turns.csv`, `ai_calls.csv`, `group_history.csv`, `submissions.csv`, `item_scores.csv`, `generated_items.jsonl`, `policy_versions.jsonl`, `assignments.jsonl`, `native_ai_responses.csv`, `conversation_codes.csv`;
  - `manifest.json`, with hashes.

  The README records the app version, git SHA, purpose, IRB, filters, row counts, limitations and outage periods. The package needs a purpose. Its defaults are pseudonymized and consenting students only. *Include AI instructions sent and original replies* (instructor only) adds the instructions sent and the original model replies to `ai_calls.csv` (columns `developer_text` and `raw_output`).
- **Demo data.** Standalone identities are not verified, so the research package refuses them unless *Include unverified (demo) identities* is chosen, which only an instructor can do (a TA cannot download the research package). The package is then marked DEMO DATA.

**Consent.** Each student has a research consent state: Yes, No or Not asked. It comes from Kiwi or from a teacher override in the roster. Research exports, viewer exports and the researcher role include consenting students only.

**Pseudonyms.**

- **Presentation mode** uses `S-001`-style pseudonyms on screen.
- **Research exports** use research ids: `P` + base32 of HMAC-SHA256 with a per-course secret, 10 characters. Pseudonymized exports replace every roster student's name and email inside free text, so a classmate named in someone's chat does not appear.
- **Researchers** always get pseudonyms. A classmate without consent appears as `[classmate]`.

**Researcher role** (D3). Assign it with a researcher staff key (standalone) or a Staff & roles override (Kiwi-linked). Researchers see Groups, Chapters & AI tutor and Insights. Their exports are always pseudonymized, consent-filtered and limited to Kiwi-verified identities, so in a standalone course they cannot export anything. Case files are refused. Every read is logged with the role.

**Retention, anonymize, delete** (**Course settings › Privacy**).

- *Keep student activity for (days)*: 1–3650, empty = keep.
- **Run retention now** anonymizes events, chat turns, AI calls, drafts and generated items older than the period. Grades and submissions are kept. Retention runs only when you click this button; there is no schedule.
- **Delete or anonymize one student**: *Anonymize (keep content)* or *Delete student data*. Neither can be undone. Delete also removes submissions and grades. Kiwi sync honours the tombstone.
- Anonymize replaces the id, name and email. It cannot detect a first name written another way inside free text.

**Audit.**

- Teacher actions are logged in `teacher_actions`, and data reads in `data_access_log` (with the role).
- Instructors read the log in **Course settings › Privacy**.
- Audit rows keep the raw student id; this is an open question (SB-m10).

**Sensitive files.** Treat these as sensitive and never commit them:

- the database and its backups: they contain student data and the server's signing and pseudonym secrets;
- `.env`;
- `.local/`.

## Kiwi integration

### How it works

1. A Kiwi course card shows **Open CSS Lab** (student) or **Open CSS Lab · teaching & analytics** (teacher) when the `ics-r-lab` app is enabled for the class. Kiwi embeds `http://127.0.0.1:8100/student` or `/teacher` and passes an app token.
2. The Lab server verifies the user's course membership and role with Kiwi on every request, cached for up to 120 s. Teachers need no second key. Kiwi course managers become instructors, and assistants with analytics or materials permission become TAs (D1).
3. While any teacher page is open, one sync loop imports native Kiwi activity every 30 s. Kiwi materials can be mapped to chapters.
4. Once a class is Kiwi-linked, the standalone teacher key and demo sessions no longer work for it. The class is linked when it is listed in `KIWI_CLASS_IDS` or after its first Kiwi request.

### Full local demo (macOS)

The demo runs the official Kiwi backend and UI at pinned commits next to the Lab:

- [NYUSH-ML/kiwi](https://github.com/NYUSH-ML/kiwi) `2fe8d2d331dc619a1e22fe2fa61df2758ba7b353`;
- [NYUSH-ML/kiwi-ui](https://github.com/NYUSH-ML/kiwi-ui) `fbc29beab4c6063c07fcf273d89e7237fad850b7`.

Step-by-step (Chinese) in [docs/local-kiwi-demo.md](docs/local-kiwi-demo.md).

```bash
cp .env.example .env              # set OPEN_AI_TEST_KEY (required) and KIWI_TEACHER_KEY (for standalone access)
npm install
npm run demo:setup                # first time; re-running keeps passwords, secrets and data
npm run demo:start                # background; logs in .local/logs/
npm run demo:status               # four lines: kiwi-api, kiwi-ui, app-api, app-ui → ready | offline, each with the URL it polled
```

`demo:setup` does the following:

1. Clones both Kiwi repositories into `.local/kiwi` and `.local/kiwi-ui` (only the ones that are missing). Git runs with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`, so without GitHub access setup stops at once instead of waiting at a hidden password prompt. After git's own `fatal:` line it prints `cannot access NYUSH-ML/kiwi — check GitHub access (sign in with gh auth login or add an SSH key, and make sure your account can open https://github.com/NYUSH-ML/kiwi), then run npm run demo:setup again.`
2. Downloads Node 24.21.0 (SHA-256 checked) into `.local/runtime/`.
3. Checks that `.env` has an AI key, then writes private config files: `.local/infra.env`, `.local/kiwi/.env` and `.local/stack-manifest.json`. It does not copy the teacher key anywhere; the API reads it from `.env`. Setups before 2026-10-23 wrote a copy to `.local/app-access.json`, which nothing reads. If that file exists, setup says it is no longer used and can be deleted; delete it yourself.
4. Rewrites the project `.env`: it removes blank lines, replaces any `VITE_KIWI_ORIGIN=` line with `VITE_KIWI_ORIGIN=http://localhost:3001` at the end, and sets mode 0600.
5. Starts the Docker project `css-kiwi-demo` (PostgreSQL 5433, Redis 6380, MinIO 9002/9003).
6. Builds and seeds Kiwi:
   - demo teacher and student accounts, with random passwords in `.local/demo-credentials.json`;
   - the class `local-css-demo`;
   - the `ics-r-lab` app enabled for that class;
   - a demo PDF.
7. Applies the local UI patches.

How long setup takes depends on your network and the Docker image cache.

The Docker project name `css-kiwi-demo` and its volumes are the same for every checkout, so only one checkout per machine can run the demo. `npm run demo:stop` stops that shared project, whichever checkout started it.

`demo:start` starts Kiwi API (3000), Kiwi UI (3001), the app API (`KIWI_API_PORT` from the shell or `.env`, default 8101) and the app UI (8100, fixed because the Kiwi app registration points there). Vite gets the same `KIWI_API_PORT`, so its `/api` proxy follows the API. It then publishes two demo assignments and adds the demo student to the roster. Services that are already healthy on those ports are **reused, not restarted**, even if they are an older version. Check `curl -s http://127.0.0.1:8101/api/health` (or your `KIWI_API_PORT`) for `"version": "0.6.0"`. The demo with a non-default API port is covered by the script tests (`npm run test:scripts`) only; it has not been run against a live Kiwi.

Sign in at [http://localhost:3001/login](http://localhost:3001/login) as `demo.teacher@css-kiwi.local` or `demo.student@css-kiwi.local`. The passwords are in `.local/demo-credentials.json`; do not show that file on screen.

| Who | Entry |
| --- | --- |
| Student | [http://localhost:3001/local-css-demo/app/ics-r-lab](http://localhost:3001/local-css-demo/app/ics-r-lab) |
| Teacher | [http://localhost:3001/admin/app/ics-r-lab/class/local-css-demo](http://localhost:3001/admin/app/ics-r-lab/class/local-css-demo) |

Use separate browsers or profiles for teacher and student at the same time.

Other commands:

- `npm run demo:stop`: stops the services it manages and the containers. Data is kept.
- `npm run demo:seed`: re-adds the demo content; needs Kiwi and the app API running.
- After changing the AI key or `KIWI_DEMO_MODEL`, run `demo:stop`, `demo:setup`, then `demo:start`.

### Linking a course in another local Kiwi

`node scripts/register-kiwi-app.mjs` registers the app with a **separate** local Kiwi checkout (default `../kiwi`). It writes the whitelist and class enablement directly to that Kiwi's database (`DATABASE_URL`) and registers through `POST /api/kiwi-apps/register` when the backend is up. It has no localhost guard. This path was not exercised in the v0.6.0 review.

```bash
node scripts/register-kiwi-app.mjs --list-classes
node scripts/register-kiwi-app.mjs --class <classId-or-name> --app-url http://127.0.0.1:8100
node scripts/register-kiwi-app.mjs --unregister
```

Set `KIWI_API_ORIGIN` (and `VITE_KIWI_ORIGIN`) to that Kiwi's API and UI origins. Add its class id to `KIWI_CLASS_IDS` if it should count as linked before the first Kiwi request.

### Bridge reinstall (existing demo)

Run this after updating the Lab on a machine that already has the demo:

```bash
npm run demo:stop
node scripts/local-kiwi/reinstall-bridge.mjs     # re-applies backend patches + bridge controller, nest build, starts only the demo DB, upgrade-integration
npm run demo:start                               # re-applies the UI patches on every start
npm run test:bridge                              # optional: controller spec + bridge UI tests inside .local
```

`node scripts/local-kiwi/reinstall-bridge.mjs --dry-run` only checks that everything it needs exists.

### Host patches (D5)

The local Kiwi gets idempotent compatibility patches. If an upstream anchor moved, the patch step stops with "Kiwi upstream changed".

- **Backend**:
  - binds to loopback;
  - adds a `/health` endpoint;
  - longer demo token lifetime;
  - email test mode;
  - reasoning-model handling;
  - the Lab bridge controller.
- **UI**:
  - layout adapters;
  - the **Open CSS Lab** buttons;
  - the webR runtime.
- **The two v0.6 host patches**:
  - Kiwi hides its own chat panel on a homework whose Ask Kiwi is Off;
  - Kiwi returns to the requested page after sign-in (`/login?returnTo=`, same-site paths only).

These are approved for the local demo only. A production Kiwi needs them upstream; the proposals are in [open questions A2](docs/handoff/v0.6.0-open-questions.md). On an unpatched host, Kiwi's chat stays available in guidance mode, and the editor says so. The bridge still returns student emails and the roster to the Lab, which is open question A1. The implemented fallback is to turn emails off and import names by id.

## Operations

### Database

- **Location.**
  - One SQLite file, `data/kiwi-lab.sqlite3`, or the path in `KIWI_DB_PATH`.
  - WAL mode, so `-wal`/`-shm` files may sit next to it while the API runs.
  - Git ignores `*.sqlite3` and `*.sqlite3-*`.
- **Secrets inside.** The file also holds the server secrets for demo sessions and research ids.
- **File modes.** A `data/` directory or database the API creates is owner-only (0700 / 0600; `-wal`/`-shm` follow the database file). Existing directories and files keep their modes, so on an install created by an older version or a copied-in database run once: `chmod 700 data && chmod 600 data/kiwi-lab.sqlite3*`.
- **Every start.** Once it has bound its port, the API runs the schema and any pending migrations: 13 for v0.6.0, recorded in `schema_migrations`. Later starts change nothing. A start that cannot bind its port does not open the database at all.
- **Automatic backup.** Before the first pending migration, if the database already has data, the API writes `<db dir>/backups/<name>.pre-<tag>-<UTC yyyymmddTHHMMSS>.sqlite3` (file mode 0600, directory mode 0700).
  - If that backup fails, startup stops with `Kiwi Lab API did not start: Could not back up the database before <tag>: … no data was changed.` and exit code 1.
  - An empty new database gets no backup.

### Backups and restore

A manual online backup is safe while the API runs:

```bash
mkdir -p data/backups
sqlite3 data/kiwi-lab.sqlite3 ".backup 'data/backups/kiwi-lab.manual-$(date -u +%Y%m%dT%H%M%SZ).sqlite3'"
# without the sqlite3 CLI:
python3 -c 'import sqlite3,time; s=sqlite3.connect("file:data/kiwi-lab.sqlite3?mode=ro", uri=True); d=sqlite3.connect(time.strftime("data/backups/kiwi-lab.manual-%Y%m%dT%H%M%SZ.sqlite3", time.gmtime())); s.backup(d); d.close(); s.close()'
sqlite3 data/backups/<file>.sqlite3 "PRAGMA integrity_check;"     # expect: ok
```

Restore:

1. Stop the API.
2. Move the current file and any `-wal`/`-shm` aside. Do not delete them.
3. Copy the backup in.
4. Start the API.

```bash
mkdir -p data/replaced && chmod 700 data/replaced
mv data/kiwi-lab.sqlite3 data/replaced/kiwi-lab.$(date -u +%Y%m%dT%H%M%SZ).sqlite3
ls data/kiwi-lab.sqlite3-wal data/kiwi-lab.sqlite3-shm 2>/dev/null   # if listed, move them into data/replaced/ too
cp data/backups/<file>.sqlite3 data/kiwi-lab.sqlite3
```

Move the `-wal`/`-shm` files together with the main file: they can remain after the API stops (for example after a read-only check), and the `-wal` file can hold committed changes. For the same reason, never copy the main file on its own; make copies with `.backup`.

### Deploy v0.6.0 on this Mac (upgrading a v0.5.1 install)

The first v0.6.0 start migrates the database. It writes `data/backups/kiwi-lab.pre-0.6.0-001-columns-<timestamp>.sqlite3` first. All data is kept, and v0.5.1 runs again on that backup if you roll back.

**Standalone:**

1. Stop the running API (and Vite), on whatever port it runs. Do not start v0.6.0 on another port while the old API still runs: both would use the same database file. v0.6.0 refuses a busy port before it opens the database, but that does not help here. The old API on its own port keeps writing to the file while v0.6.0 migrates it. A v0.5.1 API also opens and initializes the database *before* it binds its port, so starting one by mistake touches the file even when its port is taken.
2. Take a manual backup (above).
3. Set a long `KIWI_TEACHER_KEY`. v0.6.0 has no built-in default. If your `.env` still sets the old public value `kiwi-local-demo` (15 characters), it keeps working but is publicly known; replace it with a long random key (`openssl rand -hex 24`).
4. Run `npm install`.
5. Start with `npm run dev:all`.
6. Check that `curl -s http://127.0.0.1:8101/api/health` shows `"version": "0.6.0"`, and that `data/backups/` holds one `pre-0.6.0-001-columns` file.

**With the Kiwi demo:**

```bash
npm run demo:stop                                # plus any API/Vite you started yourself
mkdir -p data/backups
sqlite3 data/kiwi-lab.sqlite3 ".backup 'data/backups/kiwi-lab.manual-pre-0.6.0.sqlite3'"
# .env: KIWI_TEACHER_KEY=<long random value>
node scripts/local-kiwi/reinstall-bridge.mjs
npm run demo:start
curl -s http://127.0.0.1:8101/api/health         # "version": "0.6.0"
ls data/backups/                                 # one kiwi-lab.pre-0.6.0-001-columns-<timestamp>.sqlite3
```

**Rollback:** stop the servers, restore the `pre-0.6.0-001-columns` backup (above) and start the v0.5.1 code (branch `codex/css-lab-v0.5.1`). Running v0.5.1 on the migrated file (it would ignore the new columns and tables) is untested; restore the backup instead. If the Kiwi demo is linked, the first Kiwi sync after the upgrade may write one more backup, `…pre-native-projection-v3-<timestamp>.sqlite3`.

### Moving to another machine

No script covers this. Importing a `.backup` copy into a fresh clone was tested on one Mac; the full move between two machines is **untested**:

1. Install the same branch and run `npm install` on the new machine.
2. On the old machine, make a fresh `.backup` (see [Backups and restore](#backups-and-restore)), check it with `PRAGMA integrity_check`, and copy that backup file to the new machine as `data/kiwi-lab.sqlite3` (or to its `KIWI_DB_PATH`). Do not copy the live file on its own. The server secrets and pseudonym keys travel inside the file, so research ids stay the same.
3. Recreate `.env` on the new machine (teacher key, AI key). Move it over a private channel, not by email or chat.
4. Start the API and check `/api/health`.

A **course package** moves course design only (chapters, assignments, rules, group names, files), never student data.

### Logs

- **API.**
  - One line per request on stderr: `[YYYY-MM-DDTHH:MM:SSZ] METHOD /path STATUS`. Query strings and client addresses are stripped.
  - Internal errors appear as `internal error request=<id> …` and answer `500 internal_error`.
  - Service incidents are counted in **Insights › Data health**.
- **`dev:all`**: both processes log to the terminal.
- **Background pattern above**: `.local/standalone/api.log` and `ui.log`.
- **Kiwi demo**: `.local/logs/{kiwi-api,kiwi-ui,app-api,app-ui}.log`. These may contain secrets; read them before sharing.

### Health checks

| Check | Expected |
| --- | --- |
| `curl -s http://127.0.0.1:8101/api/health` | `{"ok": true, "runtime": "browser-webR", "aiAvailable": <true\|false>, "version": "0.6.0"}` (public, no sign-in) |
| `curl -s http://127.0.0.1:8100/api/health` | same body through the Vite proxy (checks UI and proxy) |
| `KEY=$(sed -n 's/^KIWI_TEACHER_KEY=//p' .env \| head -1)` (prints nothing), then `printf 'X-Teacher-Key: %s\n' "$KEY" \| curl -s -X POST -H @- "http://127.0.0.1:8101/api/teacher/verify?classId=local-r-class"` (the key reaches curl on stdin, so `ps` never shows it) | `{"ok": true, "role": "instructor"}`; a wrong key gives 401 `"Teacher key is incorrect"` |
| `npm run demo:status` | `kiwi-api`, `kiwi-ui`, `app-api`, `app-ui`: `ready` |

`aiAvailable: true` only means that a key is set; it does not prove the key works. `demo:start` and `demo:status` do not check the version.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Teacher gate says "Set KIWI_TEACHER_KEY on the server…" / `503 teacher_key_not_configured` | No teacher key (staff keys fail too), or an empty `KIWI_TEACHER_KEY=` line comes first in `.env`, or the shell exports an empty value | Set the key on the **first** `KIWI_TEACHER_KEY=` line. Check the shell without printing the value: `[ -n "${KIWI_TEACHER_KEY+x}" ] && echo 'KIWI_TEACHER_KEY is set in this shell'`. Restart the API. |
| 401 "Teacher key is incorrect" | Wrong key | Re-enter it. The key is `KIWI_TEACHER_KEY` in `.env` or a staff key. |
| 429 "Too many incorrect teacher keys…" | 10 wrong keys from one address within 60 s. Every key, the correct one included, then gets 429 until a minute has passed since the oldest failure. | Wait 60 s, then enter the key once |
| 401 "Open this course's CSS Lab from Kiwi…" | The class is Kiwi-linked, so the teacher key and demo sessions are ignored | Open it from Kiwi, or use the standalone UI (`local-r-class`). Do not add `local-r-class` to `KIWI_CLASS_IDS`. |
| "Kiwi access expired…" / 503 "Could not reach Kiwi…" | Kiwi token or permission problem, or Kiwi is down | Reopen CSS Lab from Kiwi. Check `curl -s http://localhost:3000/health`. |
| 404 `unknown_course` "This course is not set up in CSS Lab yet…" | A student wrote to a standalone class that has no saved course, no assignment, and is not in `KIWI_STANDALONE_CLASS_IDS` | Save the course or an assignment first, or add the class to that variable |
| 403 `preview_required` | Staff opened a student route directly | Use **Preview as student** |
| 403 "This demo link is invalid or expired…" | The link is older than 14 days, or it was created for another class | Create a new link in Roster |
| 403 "This demo link no longer works because the student's data was removed from the course." | The student was deleted or anonymized (Privacy) | Nothing to fix; the student's data is gone |
| A link or URL works on the teacher's computer but not on a student's laptop | The app listens on `127.0.0.1` only | By design in v0.6.0; use a shared or lab machine |
| `Kiwi Lab API did not start: port <port> on 127.0.0.1 is already in use … the database was not opened.` (exit code 1) | The API port is taken. Nothing was migrated. | Find the holder with `lsof -nP -iTCP:<port> -sTCP:LISTEN`. If it is an older API of this checkout, stop it (see [Deploy v0.6.0 on this Mac](#deploy-v060-on-this-mac-upgrading-a-v051-install)); otherwise pick another port (see [Quick start](#quick-start-standalone)). Do not stop someone else's process. |
| `Warning: .env sets <names> on more than one line; the first line of each is used.` | A variable appears on several lines of `.env`. The API and the demo scripts both use the first line. | Keep one line per variable, then restart the API. |
| The UI opens on 8101/8102 instead of 8100 | `npm run dev` moved to the next free port | Use `npx vite … --port <p> --strictPort` |
| The UI loads but every `/api` call answers HTTP 500 with an empty body, and Vite logs `http proxy error … ECONNREFUSED` | The API is not running, or Vite proxies to the wrong port (`KIWI_API_PORT` was set only in `.env`) | Start the API. Set `KIWI_API_PORT` in the shell for both processes. |
| `demo:start` says "already running" but the old version still serves | An older healthy API on the API port, or Vite on 8100, is reused | Stop it yourself, run `demo:start`, check `"version": "0.6.0"` |
| `<name> is not ready. Private log: .local/logs/<name>.log` | That service failed or took longer than 25 s. For `app-api`, the log may say the port is already in use. | Read the log (it may contain secrets). Free the port, or set `KIWI_API_PORT` in `.env` to a free port. |
| `KIWI_API_PORT must be a port number, got "…"` from a `demo:` command | `KIWI_API_PORT` in the shell or `.env` is not 2–5 digits; an empty `KIWI_API_PORT=` line counts (the API then fails with `ValueError: invalid literal for int()`) | Fix or remove the line. `demo:stop` still works. |
| `cannot access NYUSH-ML/kiwi — check GitHub access …` during `demo:setup` | No GitHub access to a private Kiwi repository | Sign in (`gh auth login` or an SSH key), get access to the `NYUSH-ML` organization, then run `npm run demo:setup` again |
| `.local/app-access.json is no longer used and may hold an old copy of the teacher key …` | An older setup left that file | Delete it yourself (`rm .local/app-access.json`). The key in `.env` is not affected. |
| "Docker demo services failed. Is Docker Desktop running?" | Docker is not running | Start Docker Desktop |
| "Run npm run demo:setup first." | The demo is not installed | `npm run demo:setup` |
| "Add OPEN_AI_TEST_KEY to the project .env before running demo:setup." | No AI key | Add the key to `.env` |
| "… is on a different commit" / "Kiwi upstream changed…" | The `.local/kiwi*` checkout drifted | Inspect `.local/kiwi*`. Setup never discards changes. |
| "Kiwi requires Node 24.15 or later…" | A demo backend script ran with the system Node | Use the npm scripts; they use `.local/runtime/…/bin/node` |
| R never starts; 404 on `/webr/webr-worker.js` or `R.wasm` | `public/webr` is missing (`npm install --ignore-scripts`) | `npm run prepare:webr`, then restart Vite or rebuild |
| An R package fails to install | `repo.r-wasm.org` is unreachable, or webR cannot build the package (`duke`, `ldatuning`, `rsvg`) | Check network access; use local R for those packages |
| Ask Kiwi answers "Local guidance" | No AI key; this is by design | Set `OPEN_AI_TEST_KEY` or `OPENAI_API_KEY`, then restart the API |
| 503 `ai_unavailable` | Provider path with no key | Same as above |
| 503 `ai_busy` "Kiwi is busy right now…" | All AI slots taken | Wait, or raise `KIWI_AI_CONCURRENCY` / `KIWI_AI_QUEUE_WAIT_S` |
| 429 "Too many AI requests…" | Per-student (15/min), per-course (120/min) or per-address (60/min) limit | Wait, or change Course info limits or `KIWI_AI_PER_IP_PER_MINUTE` |
| 502 `ai_provider_error`, or 429 "The AI service is receiving too many requests…" | OpenAI error, timeout (50 s) or quota | Retry; check the key and quota |
| "Kiwi Lab API did not start: Could not back up the database…" | `<db dir>/backups` is not writable, or the disk is full | Fix the permissions or free space. No data was changed. |
| 409 `stale_version` when saving the course | Someone else saved in between | Reload and edit again |
| 422 `server_owned_event` | An old client sent server-owned events | Expected under `enforce`. `KIWI_SERVER_OWNED_EVENTS=accept` is the transitional option. |
| 400 "Request body is too large" | Body over 4.2 MB (20 MB for course package import) | Use smaller files |

## Validation and tests

Results recorded on the development Mac (macOS arm64) on 2026-10-23 (Node 22.16.0, Python 3.13.5), on the working tree that became commit `28092f6` (the known-minors fixes on top of `e8d819e`); a fresh clone of `28092f6` gave the same counts for `test:server`, `npm test` and `test:scripts`, and passed `tsc`, the build and the R capture check. Counts can change with later commits, so re-run the suites rather than trusting these numbers.

| Command | What it checks | Recorded result |
| --- | --- | --- |
| `npm run test:server` | Python unit tests on temporary databases, with AI keys cleared | 529 tests OK; 2 skipped on a fresh clone, 1 in the development checkout (migration-snapshot tests that need `.local/*.sqlite3` snapshots or `KIWI_SNAPSHOT_DBS`); about 4 minutes (234 s) |
| `npm test` | vitest: views, libraries, naming lint, accessible-name scan | 51 files, 1,301 passed; a few seconds |
| `npm run test:scripts` | the demo script helpers in `scripts/local-kiwi/config.mjs` (`.env` parsing, `KIWI_API_PORT`, git environment, setup messages), with `node:test` in temporary directories | 7 passed; under a second |
| `npx tsc --noEmit -p tsconfig.json` | TypeScript | no output, exit 0 |
| `npm run build` | production bundle into `dist/` | builds; only the chunk-size warning |
| `node scripts/verify-r-capture.mjs` | real webR output capture in Node | "Real R capture passed: …"; writes `.local/verify-r-engine.mjs` |
| `npm run coverage` | frontend line coverage (`coverage/`, git-ignored) | `src/lib` 96.7 % at the final verify, before the known-minors fixes (target ≥ 80 %, D7); not re-measured since |
| `python3 -m coverage run --source=server -m unittest discover -s server -p 'test_*.py' && python3 -m coverage report` | server coverage; needs `pip install coverage` | about 91 % at the final verify, before the known-minors fixes; not re-measured since |
| `npm run test:bridge` | Kiwi bridge UI tests and controller spec inside `.local` | 20/20 and 5/5 on temporary clones at the final check; skips with a message when `.local/kiwi*` is absent. Not re-run since: the later script changes did not touch `scripts/local-kiwi/bridge/`. |
| `node scripts/local-kiwi/verify-integration.mjs` | bridge SQL end to end against a running demo | prints `{"passed": N, …, "repeatedSyncStable": true}`; **not yet run** on the live demo. It writes to the app database (one native sync and one rejected event). |
| `python3 scripts/benchmark-analytics.py --sessions 20000 --events 50000 --students 300` | analytics query timing on a temporary database | timing report |

Also checked on 2026-10-23:

- before the known-minors fixes: a fresh clone deployed in standalone mode by following [set_up_for_agent.md](set_up_for_agent.md), including the background start pattern above, an import of a copy of a v0.5.1 database and a rollback to its automatic backup. The runbook has been updated for the fixes since (bind before migrate, `.env` duplicates, `demo:start` port, setup without GitHub access);
- after the known-minors fixes: a fresh agent followed the updated runbook on a fresh clone of `28092f6` in standalone mode (start on an empty database, then import of a copy of a v0.5.1 database, smoke tests, V1–V5 and V9) and got the expected results; Kiwi mode got the preflight only, and no rollback was run. The runbook changes made after that run (an API listing that also works in zsh, a commit check, a check that the UI proxy reaches the right API, owner-only file modes, the teacher key kept off `curl`'s command line) were checked block by block on a scratch clone, not in another end-to-end run;
- the v0.5.1 → v0.6.0 migration on copies of real v0.5.1 databases: no core table lost rows, and v0.5.1 ran again on the restored backup. No migration file (`server/migrations*.py`, `server/db.py`) changed in the known-minors fixes;
- by the fixer of the known-minors fixes, on a scratch copy of the live database (API 8700, Vite 8701): the roster, the explorer's *Students* view and the Course package panel at 1280 and 390 px, and a second API on the busy port 8700, which exited without creating its database file.

Reviews: [v0.6.0 browser review](docs/reviews/2026-10-22-v0.6.0.md), [v0.6.0 preservation check](docs/reviews/2026-10-22-v0.6.0-preservation.md).

## Architecture overview

```
Browser ── React 19 UI + webR (R in WebAssembly) + telemetry outbox
   │  /api/…  (relative URLs)
   ▼
Vite dev / preview  127.0.0.1:8100  ── proxies /api, forwards X-Forwarded-For
   │
   ▼
Python API  127.0.0.1:8101  (http.server, standard library only)
   ├── SQLite  data/kiwi-lab.sqlite3  (WAL; migrations + backups at start)
   ├── OpenAI Responses API  (server-only key; final-answer guard)
   └── Kiwi API  KIWI_API_ORIGIN  (token verification, native activity import)

Kiwi UI 127.0.0.1:3001 ── embeds the Lab (/student, /teacher) and passes an app token (Kiwi-linked mode)
```

```
server/              Python API
  app.py             bootstrap: .env, database path, init_db, HTTP handler
  router.py          routing, auth levels, class id, rate-limit address, errors
  routes/            endpoints: core, assignments, grading, insights, people, exports, ai_rules, ai_runtime, telemetry, kiwi, files
  auth.py identity.py governance.py research_view.py   roles, keys, demo sessions, consent, researcher view
  ai.py ai_runtime.py ai_policy.py leak_guard.py         AI provider, request assembly, rules, final-answer guard
  analytics.py attention.py telemetry.py event_schema.py metrics, attention rules, events
  assignments.py grading.py submissions.py judging.py    assignments, grading, answer checks
  migrations*.py db.py                                   schema, migrations, backups
  exports.py course_package.py course_templates/         exports, course packages, SOCS-SH 190 template
  kiwi_bridge.py     Kiwi verification and native sync
  test_*.py          unit tests (npm run test:server)
src/                 React frontend
  App.tsx RoleEntry.tsx   routing, workspace selection
  teacher/           home, assignments, grading, students, chapters, insights, settings, kiwi, shell
  student/           assignments, practice, pages, tools, telemetry
  lib/               API client, routes, labels, R engine (webR), outbox, formatting
public/sdk/          Kiwi app SDK (tracked); public/webr/ is copied at install (ignored)
scripts/             dev-all, copy-webr, verify-r-capture, benchmark-analytics, register-kiwi-app
  local-kiwi/        demo setup/start/stop, Kiwi patches, bridge controller, integration checks
docs/                architecture specs, handoff notes and decisions, reviews
data/                SQLite database and backups (ignored)
.local/              demo checkouts, runtime, credentials, logs (ignored)
```

## Known limitations and open questions

Compiled on 2026-10-23 from the [browser review](docs/reviews/2026-10-22-v0.6.0.md) (*Summary of all review rounds*, *Known-minors retest*) and the [open questions](docs/handoff/v0.6.0-open-questions.md), after the known-minors fixes.

- **Local pilot, this computer only.** SQLite, one process, `127.0.0.1` only: students cannot connect from their own devices. There is no HTTPS, managed persistence or load testing, and no production-capacity claim.
- **Standalone identities are not verified.** Research exports mark them as demo data, and viewer and researcher exports refuse them.
- **Native Kiwi activity syncs only while a teacher page is open.** Deletions made in Kiwi do not reach the Lab.
- **Review status.** No blocker or major is open. The seven browser review rounds found 3 blockers, 23 majors and 67 minors. All blockers and majors were fixed and then retested in the browser by an agent that did not write the fixes. Round 7 (*Known-minors retest*) retested the round-6 minors: B-m01–B-m04 were fixed, and SB-m06 was fixed in To grade. Their residuals became K-m01–K-m04.
  - **Fixed on 2026-10-23 but not yet retested in the browser** by an independent reviewer (regression tests in `server/test_review7.py`, `src/lib/a11y.views.test.tsx`, `scripts/local-kiwi/config.test.mjs` and the view tests named after each finding):
    - K-m01: *Active* means a learning action on Home, in Course metrics and in the Activity explorer, and the explorer shows *Last learning action* and *Last seen* instead of *Last activity*;
    - K-m02: a homework closed before its due date reads `Closed early · due …`;
    - K-m03: the first open of a revision copies the student's draft from the closed original;
    - K-m04: repeated row actions carry the row's name, and the Gradebook filter is *Filter students*;
    - K-m05: the roster's *Last seen* and *Missing work* explanations are printed on the page, and a *Missing work* count opens the list;
    - K-m06: the *Archive current chapters* label matches the form labels and sits under *Shift dates by weeks*;
    - deployment fixes: the API binds its port before it migrates, `demo:start` follows `KIWI_API_PORT`, `.env` duplicates are first-line-wins with a warning everywhere, and `demo:setup` fails at once without GitHub access. These have unit and script tests and a fixer's check on a scratch port; the Kiwi demo has not been run with them.
  - **Open minors.** Each one is left with its reason in [open questions › D2](docs/handoff/v0.6.0-open-questions.md#d2-supplementary-browser-findings-left-open-2026-10-23):
    - SB-m08: layouts at 320 px (Home top bar height, Grading toggle labels, the explorer's header and pinned column, the student menu). No page scrolls sideways;
    - SB-m10: audit rows (`teacher_actions`, `data_access_log`) keep a deleted or anonymized student's raw id. This waits for an owner ruling;
    - the unfinished parts of S-m03 (top-bar spacing at 1280 px with a custom range), S-m06 (naming the other student in *Same answer as …*; a confirmation for a card's *Release*), S-m07 (list card wording during an open attempt, a new attempt pre-filled with the previous answer, the over-time mark in the teacher popover, audience and time limit on the list row), SB-m07 (*Mark to re-teach* on Recent questions; one scope label for Home and AI conversations) and SB-m09 (the student's name in the Delete/Anonymize confirmation; removed demo students still listed in the browser-local student picker).
  - **Deferred:** merging a revision's grades with its original (S-M01 part). Students anonymized before the SB-B01 fix keep some mentions in free text; they exist only in review scratch databases.
- **Not tested in any review round, or not retested after the fixes (not passed):**
  - the Kiwi-linked path, which needs a Kiwi sign-in: verified identities, native AI import, the D5 host patches, the D1 staff mapping, a researcher override, verified-only viewer and researcher exports on a linked course, and R-B01 with a staff identity from a Kiwi token;
  - TA and researcher sign-in after the R-B01 fix (round 6 used the instructor key only);
  - `verify-integration.mjs`, the bridge SQL end to end against a running demo;
  - course package ZIP import, including S-M05 through an export and re-import, and a template Apply on a course that already has assignments;
  - editing or publishing a starter assignment, and mapping the starters to a template course's chapters (unit tests only);
  - two teacher tabs saving chapters at once (the `baseUpdatedAt` conflict path);
  - R-m01's other wording, "A new version of this homework is available:", while the original still accepts work;
  - per-student and per-class AI rate limits, sustained live AI use and a full class. Only a few live AI calls and the concurrency *busy* path ran;
  - Delete student and the instructor's case file after the fixes;
  - from round 7: real tab switching or window refocus (dispatched events were used); the `late_not_accepted`, `not_open_yet` and `max_attempts_reached` refusals; two D8 cases (a revision assigned to a different group than its original, an open revision of a past-due original); grading or releasing across a homework and its revision; SB-m06's *Mark to re-teach*, *Done* and *Revoke* buttons;
  - 320 px layouts (seen in one pass only, SB-m08), dark mode, keyboard-only use and a real screen reader;
  - `npm run demo:start` with a non-default `KIWI_API_PORT`, and the updated [set_up_for_agent.md](set_up_for_agent.md) end to end.
- **Deferred past v0.6.0** (each with a concrete blocker, [open questions › B](docs/handoff/v0.6.0-open-questions.md#b-deferred-past-v060-spec-20)):
  - scheduled native sync and Kiwi-side deletions;
  - RAG over Kiwi materials;
  - composable assignment modes;
  - merging revision grades;
  - encrypted name mapping;
  - `.qmd` question parsing and a cross-course question bank;
  - IRT calibration;
  - announcements;
  - grade passback (CSV only for now);
  - server-side R;
  - an official Kiwi chat-availability API;
  - production deployment.
- **Waiting for others** ([open questions › A and E](docs/handoff/v0.6.0-open-questions.md#e-what-only-the-user-can-do)):
  - the Kiwi maintainers: whether the bridge may return emails, the roster and consent; a class-bound service credential; grade passback; adopting the two D5 host patches upstream;
  - the owner: the SB-m10 ruling; the live-database migration (README › [Deploy v0.6.0 on this Mac](#deploy-v060-on-this-mac-upgrading-a-v051-install)); `npm run test:bridge` and `verify-integration.mjs` after the bridge reinstall; the Kiwi-linked walk-through; real AI calls with a key.
- **Dev-only `npm audit` advisories** (`@vitest/mocker`, `source-map-js`; [open questions › C](docs/handoff/v0.6.0-open-questions.md#c-dev-only-npm-audit-advisories-d7)). Production dependencies have none. Do not run `npm audit fix`; it would change the test toolchain.
- **Docs that disagree with the code (code wins):**
  - `VITE_KIWI_CONTEXT_PROMPT_ID` is unused;
  - `KIWI_STANDALONE_CLASS_IDS` accepts several classes, but the standalone UI always uses `local-r-class`.
- **Platforms.** Windows and Linux are untested; the Kiwi demo is macOS only.

Details and the questions for the Kiwi maintainers: [docs/handoff/v0.6.0-open-questions.md](docs/handoff/v0.6.0-open-questions.md).

## Further documentation

- [CHANGELOG.md](CHANGELOG.md): what changed in each version and why.
- [set_up_for_agent.md](set_up_for_agent.md): deterministic deployment runbook for Codex or Claude Code.
- [docs/local-kiwi-demo.md](docs/local-kiwi-demo.md): local Kiwi + CSS Lab demo (Chinese).
- [docs/architecture-v0.6.0.md](docs/architecture-v0.6.0.md): v0.6.0 design spec. Appendix B covers environment variables; Appendix E has the as-built notes and measured coverage.
- [docs/handoff/v0.6.0-decisions.md](docs/handoff/v0.6.0-decisions.md): owner decisions D1–D8, which override the spec.
- [docs/handoff/v0.6.0-open-questions.md](docs/handoff/v0.6.0-open-questions.md): deferred work, questions for Kiwi maintainers, what only the owner can do.
- [docs/handoff/](docs/handoff/): per-workstream handoff notes (foundation, assess, grade, airules, airun, telemetry, insights, people).
- [docs/reviews/](docs/reviews/): browser and engineering reviews of every version.

Theme and fonts follow `NYUSH-ML/kiwi-ui` commit `fbc29beab4c6063c07fcf273d89e7237fad850b7` (primary Purple 800 `#6A1B9A`; Montserrat, self-hosted).
