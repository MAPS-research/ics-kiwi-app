# CSS Kiwi Lab v0.7.2

R practice, assignments, grading and Lab activity for SOCS-SH 190.

**`main` carries this SDK migration (v0.7), developed on `codex/kiwi-sdk-v0.7.0`.** The previous v0.6 implementation is on `codex/css-lab-v0.6.0`; its patched-host deployment is retired.

[Agent setup](set_up_for_agent.md) · [Integration contract](docs/architecture-v0.7.0.md) · [SDK feedback](docs/handoff/v0.7.0-sdk-feedback.md) · [Changelog](CHANGELOG.md) · [Browser review](docs/reviews/2026-11-02-v0.7.2.md)

v0.7.2 将教师 Chapters 页改为顶部搜索、显示筛选、排序和章节选择，下方一次只编辑一个章节。切换章节保留未保存内容；排序仅影响选择列表，实际教学顺序通过章节位置按钮调整后保存。课程进度设置收在可展开的 Course pacing 中。

v0.7.1 在 Kiwi 内只保留「作业、练习、课程大纲」三个 Lab 入口。聊天使用 Kiwi 悬浮窗，自由实验使用 Kiwi Scratchpad；每道题仍有独立的 **R editor**，用于保存代码、记录运行和提交答案。旧独立 R 草稿可从课程大纲恢复，原有作业和成绩保留。Scratchpad 的 R 选项需要课程开启 R 功能；SDK 目前不支持把其代码或运行结果自动关联到 Lab 题目。

## v0.7 接入规则

这是独立托管、嵌入 Kiwi 的 App。通过官方 SDK 完成握手、上下文与导航，通过官方 App token 和 JWKS 验证当前用户、课程与 App；AI 经过 Kiwi 已批准的 prompt。不会改 Kiwi 源码、注入 CSS Lab 专用入口、替换原生 IDE，或读写 Kiwi 数据库。

App 不获取 Kiwi 名单、姓名、邮箱或原生聊天/IDE/PDF 活动流。学生在 Lab 内使用匿名标签；Data Hub 记录 Lab 自身活动。原有作业、答案、成绩和历史记录保留，历史 Kiwi 导入标记为已停止的旧来源。

App token 不包含教师角色。课程授予 `class:info:read` 时，Lab 后端用调用者的 token 请求 Kiwi 的 `GET /api/kiwi-apps/ics-r-lab/me`，按 Kiwi 课程角色和权限（`canManageMaterials`、`canViewAnalytics`）确定 Lab 角色；教师和助教只需在 Kiwi 课程中维护。`KIWI_STAFF_BINDINGS` 仍可按课程 UUID、用户 UUID 覆盖；没有该接口的宿主只能靠它授权。前端的角色字段不作为权限依据。

AI 练习生成由 Kiwi 的 `contextual-chat` API 执行。Kiwi 内不再显示第二套 Lab 聊天；官方 SDK `updateContext` 仅向宿主聊天提供当前可见题目、学生草稿和当前代码的运行结果。Lab 不接收或使用 OpenAI key。独立模式保留明确标注的固定指导、本地题库和 R 草稿区。Kiwi 的模型、推理档位和输出长度由 Kiwi 管理。

SDK 目前不能关闭 Kiwi 自带的聊天面板，也不能强制它遵循 Lab 帮助级别。教师设置是建议；旧 Lab 聊天策略仍适用于独立模式。Lab 不向宿主聊天发送答案键、评分标准或教师评语，也不导入宿主聊天和 Scratchpad 的活动历史。

## Local quick start

Requires Node 20.19+ (or 22.12+), Python 3.10+, and a browser. The development servers listen on loopback; they are for this computer, not a class-wide deployment.

```bash
git clone https://github.com/MAPS-research/ics-kiwi-app.git
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

Use `main` for these instructions. The old v0.6 branch does not contain this SDK migration.

## Connect an unmodified Kiwi host

1. Use a Kiwi deployment with RS256 signing and `/.well-known/jwks.json`. The Lab accepts only RS256 App tokens for `ics-r-lab`, the current course and an unexpired caller. It does not accept a host signing secret or a browser-supplied teacher role.
2. Preview the registration document: `node scripts/register-kiwi-app.mjs --app-url https://lab.example.edu`. This prints the manifest and required scopes without changing anything.
3. A Kiwi administrator creates the whitelist entry for `ics-r-lab` and supplies its registration secret. Set `KIWI_REGISTRATION_SECRET` only in the registration process environment; invoke the same command with `--kiwi-api https://kiwi-api.example.edu --register` to call the official registration endpoint. No direct database fallback exists.
4. The administrator approves `lab-tutor` and enables the app and these scopes for the course: `context:student_learning:read`, `llm:prompt:lab-tutor`, `class:info:read`.
5. Set Lab `KIWI_API_ORIGIN`, `VITE_KIWI_ORIGIN` and `KIWI_CONTEXT_PROMPT_ID=lab-tutor`. Staff roles come from Kiwi through `GET /api/kiwi-apps/ics-r-lab/me`, which needs `class:info:read`: a Kiwi TA with material or analytics permission becomes a Lab TA, material permission makes an instructor, analytics permission alone a viewer. Other Kiwi course staff can open the Lab and get a role on Staff & roles. `KIWI_STAFF_BINDINGS` remains an operator override, and the only staff source on a host without that endpoint. Example binding: `{"course-uuid":{"teacher-user-uuid":"instructor"}}`. Supported Lab roles: `instructor`, `ta`, `viewer`, `researcher`. IDs must come from the authorized operator; there is no roster lookup.
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
