# CSS Kiwi Lab v0.7.0

R practice, assignments, grading and Lab activity for SOCS-SH 190.

**Development branch: `codex/kiwi-sdk-v0.7.0`. This SDK migration is not merged into `main`.** The previous v0.6 implementation is on `codex/css-lab-v0.6.0`; its patched-host deployment is retired.

[Agent setup](set_up_for_agent.md) · [Integration contract](docs/architecture-v0.7.0.md) · [SDK feedback](docs/handoff/v0.7.0-sdk-feedback.md) · [Changelog](CHANGELOG.md) · [Browser review](docs/reviews/2026-10-29-v0.7.0.md)

## v0.7 接入规则

这是独立托管、嵌入 Kiwi 的 App。通过官方 SDK 完成握手、上下文与导航，通过官方 App token 和 JWKS 验证当前用户、课程与 App；AI 经过 Kiwi 已批准的 prompt。不会改 Kiwi 源码、注入 CSS Lab 专用入口、替换原生 IDE，或读写 Kiwi 数据库。

App 不获取 Kiwi 名单、姓名、邮箱或原生聊天/IDE/PDF 活动流。学生在 Lab 内使用匿名标签；Data Hub 记录 Lab 自身活动。原有作业、答案、成绩和历史记录保留，历史 Kiwi 导入标记为已停止的旧来源。

当前 App token 不包含教师角色。Lab 管理员必须在服务器的 `KIWI_STAFF_BINDINGS` 中按课程 UUID、用户 UUID 明确授权；前端的角色字段不作为权限依据。

`Ask Kiwi` 和 AI 练习生成由 Kiwi 的 `contextual-chat` API 执行。Lab 不接收或使用 OpenAI key。独立模式只有明确标注的固定指导与本地题库。Kiwi 的模型、推理档位和输出长度由 Kiwi 管理；Lab 教师规则作为任务数据发送，不宣称它们是独立的 system/developer 消息。

SDK 目前不能关闭 Kiwi 自带的聊天面板。“Ask Kiwi Off”只控制 Lab 内的功能。Lab 不向宿主聊天发送作业答案。

## Local quick start

Requires Node 20.19+ (or 22.12+), Python 3.10+, and a browser. The development servers listen on loopback; they are for this computer, not a class-wide deployment.

```bash
git clone --branch codex/kiwi-sdk-v0.7.0 https://github.com/MAPS-research/ics-kiwi-app.git
cd ics-kiwi-app
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm install
cp .env.example .env
```

Set a long random `KIWI_TEACHER_KEY` in `.env`, then:

```bash
npm run dev:all
```

Open `http://127.0.0.1:8100/entry`. Students can choose a local demo identity; teachers use the standalone key. `npm install` copies the webR runtime into `public/webr`. R executes in the Lab browser, including console output and errors.

Keep one API process per database. For isolated testing use `KIWI_DB_PATH` and a different API/UI port; export `KIWI_API_PORT` for both processes. `npm run dev:all` prefers `.venv/bin/python`; `KIWI_PYTHON` overrides it.

Use the named `codex/kiwi-sdk-v0.7.0` branch for these instructions. `main` and the old v0.6 branch do not contain this SDK migration.

## Connect an unmodified Kiwi host

1. Use a Kiwi deployment with RS256 signing and `/.well-known/jwks.json`. The Lab accepts only RS256 App tokens for `ics-r-lab`, the current course and an unexpired caller. It does not accept a host signing secret or a browser-supplied teacher role.
2. Preview the registration document: `node scripts/register-kiwi-app.mjs --app-url https://lab.example.edu`. This prints the manifest and required scopes without changing anything.
3. A Kiwi administrator creates the whitelist entry for `ics-r-lab` and supplies its registration secret. Set `KIWI_REGISTRATION_SECRET` only in the registration process environment; invoke the same command with `--kiwi-api https://kiwi-api.example.edu --register` to call the official registration endpoint. No direct database fallback exists.
4. The administrator approves `lab-tutor` and enables the app and these scopes for the course: `context:student_learning:read`, `llm:prompt:lab-tutor`.
5. Set Lab `KIWI_API_ORIGIN`, `VITE_KIWI_ORIGIN`, `KIWI_CONTEXT_PROMPT_ID=lab-tutor` and `KIWI_STAFF_BINDINGS`. Example binding: `{"course-uuid":{"teacher-user-uuid":"instructor"}}`. Supported Lab roles: `instructor`, `ta`, `viewer`, `researcher`. IDs must come from the authorized operator; there is no roster lookup.
6. Open the app using Kiwi's generic course tab or class admin app menu. The manifest uses `class-tab` and `class-admin-panel`; no host files are edited.

The Lab backend uses the documented REST form of the SDK's contextual-chat operation so it can apply assignment policies, persist conversations and validate output before returning it to a student. Only the caller's App token is forwarded to the configured Kiwi origin. Provider credentials, model selection, private-context assembly and billing remain on Kiwi. This is not the iframe-proxied SDK operation: the explicit SDK `getToken()` path authenticates this backend.

The API caps `userMessage` at 8,000 UTF-16 characters. Oversized assembled requests fail visibly; the adapter does not silently truncate them to fit this limit. Missing approval, scope or host connectivity never triggers a direct-provider fallback.

## Student and teacher workflows

Students can work on published assignments, save and resume answers, submit, see released feedback, practice from local templates or Kiwi-generated items, and run/debug R in the browser. Ask Kiwi shows whether an answer is fixed local guidance or comes from Kiwi.

Teachers can create assignments, preview them, publish, grade submissions, release grades, inspect Lab activity and student timelines, edit chapter rules, and export teaching/research data. In Kiwi-linked courses, names/emails are not fetched from Kiwi, and API displays and exports use anonymous labels. A student appears in the Lab population after a verified visit; counts do not claim to be a complete Kiwi enrollment roster.

For a graded assignment, the Lab applies its own access rules and checks AI replies for protected final answers. This does not prevent a student from opening other AI tools or Kiwi's independent host chat.

## Upgrade from v0.6

Stop the old Lab API before starting this version against the same SQLite file. Make a consistent SQLite backup while the service is stopped (include any WAL data, preferably with SQLite `.backup`). Keep the backup private.

The application data schema is preserved. The migration removes the host-patching scripts from this repository; it does not reset `.local/kiwi`, `.local/kiwi-ui`, Docker volumes, existing databases or already-running processes. An old patched host remains old until its operator replaces it with a clean official deployment. Do not use it as evidence of SDK compatibility.

`demo:setup`, `demo:start`, `demo:stop`, `demo:status` and `demo:seed` now fail with a retirement notice. The old bridge reinstall and native activity sync are unsupported. Historical imports are retained as historical evidence, not refreshed; any previously imported identity data in an existing database/backup requires the operator's retention handling. The Lab suppresses it in linked-course views and exports.

## Verification

```bash
npm run build
npm test
npm run test:scripts
.venv/bin/python -m unittest discover -s server -p 'test_*.py'
```

Each app version requires an independent agent to exercise the running student and teacher workflows in a real browser, with desktop/narrow screenshots and an explicit list of untested integrations. See `docs/reviews/` for observed results; a simulator or API fixture is not a live Kiwi/AI pass.
