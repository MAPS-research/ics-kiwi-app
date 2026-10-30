# CSS Kiwi Lab v0.7.0 agent setup

Work branch: `codex/kiwi-sdk-v0.7.0`; not merged into `main`. This replaces the v0.6 deployment runbook, including its host-patching exceptions.

Read [AGENTS.md](AGENTS.md), [README.md](README.md), and [the integration contract](docs/architecture-v0.7.0.md) first.

## Boundaries

Use an unmodified Kiwi deployment. Never clone-and-patch Kiwi as an installation step, copy a Lab controller/component into it, query its database, replace its IDE, extend token lifetime, or install login/health/SMTP patches. Existing `.local` checkouts, Docker volumes and user data must be preserved.

The official SDK handles handshake, context and navigation. Its explicit `getToken()` authenticates Lab API requests. The Lab verifies signatures using the configured host's public JWKS; no host secret is shared. Do not trust an unsigned payload, iframe role, query parameter or unverified token as an identity.

No Kiwi names/emails, roster or native activity feed are requested. App-local anonymous labels identify students. Host token scopes are not teacher-role grants. Explicit server-side `KIWI_STAFF_BINDINGS` grants are required for teacher access.

## Standalone setup

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm install
```

Create `.env` from `.env.example` only if none exists. Keep existing secrets out of logs. Set a long `KIWI_TEACHER_KEY`; do not use a public default. Then `npm run dev:all` and open `http://127.0.0.1:8100/entry`.

Standalone mode uses local templates/guidance. Setting an OpenAI key has no effect. Do not claim a local reply came from Kiwi AI.

## Kiwi registration

```bash
node scripts/register-kiwi-app.mjs --app-url https://lab.example.edu
```

This is a read-only preview. The manifest defines generic class-tab and class-admin-panel UIs and an approval-required `lab-tutor` prompt. Required scopes are printed beside it.

A Kiwi administrator must whitelist `ics-r-lab` using the normal management UI/API and supply its registration secret. With that secret in `KIWI_REGISTRATION_SECRET`, registration is:

```bash
node scripts/register-kiwi-app.mjs --app-url https://lab.example.edu --kiwi-api https://kiwi-api.example.edu --register
```

The script does not whitelist, enable, approve, query class members or access a database. Prompt approval and course enablement remain Kiwi administrator actions. Do not send messages to maintainers unless the user asks.

Configure the Lab with the public API/UI origins, `KIWI_CONTEXT_PROMPT_ID=lab-tutor` and explicit course/user UUID role bindings. RS256 keys belong to the Kiwi operator; the Lab only reads JWKS. If a host still signs HS256, explain that it needs the official RS256 configuration; never copy its symmetric secret.

The direct REST contextual-chat request is the documented server counterpart to the SDK operation. It keeps policy checking and persistence on the Lab server. It requires `context:student_learning:read` plus `llm:prompt:lab-tutor`. The host retains model/provider configuration and its private learning context. The Lab requests relevant material context only and receives the model output, not raw history.

## Review without touching user data

Use a fresh `KIWI_DB_PATH`, a unique test teacher key, and unused ports. For example export `KIWI_API_PORT=8411` for both `.venv/bin/python server/app.py` and `npx vite --host 127.0.0.1 --port 8410 --strictPort`. Do not run two APIs against the same database.

After implementation, a separate agent must use a real browser for student practice/continuation, R success/error, answer persistence/submission, Ask Kiwi, and teacher creation/publication/grading plus Data Hub/history. Use clearly named Review work. Capture desktop and narrow layouts, report severity and limitations in `docs/reviews/`, and retest blockers. Mocked upstream responses and standalone fallbacks must be labeled as such.

Run build, frontend tests, script contract tests and Python tests from the virtual environment. Preserve actual failed checks in the report until repaired; do not substitute v0.6 results.

## Existing v0.6 installation

The retired demo commands no longer start or patch a host. Existing running services are not stopped by this change. The operator should stop the old Lab API, back up SQLite consistently, and deploy against a clean official host. Preserve old data/volumes; do not reset or delete them as part of setup.

No new data migration is needed for assignments/grades. Legacy native imports and identity fields can remain in old private databases/backups; linked-course displays/exports suppress identity fields. Discuss any irreversible retention cleanup separately rather than deleting user records during installation.
