# set_up_for_agent.md: deploy CSS Kiwi Lab 0.6.0 (runbook for coding agents)

This runbook is for a coding agent (Codex, Claude Code or similar) that deploys CSS Kiwi Lab 0.6.0 on a workstation for a human operator. Run the steps in order. Each step has the commands to run, what to **Expect**, and what to do **If it fails**. Re-running any step is safe. Human-facing documentation is in [README.md](README.md). Where this file and the code disagree, the code wins: report the difference to the human.

---

## 1. Purpose and scope

- **In scope.**
  - Install and start the app in one of two modes:
    - **standalone**: the app API and UI only, with a local teacher key;
    - **Kiwi-linked**: the full local Kiwi demo (Kiwi backend and UI, PostgreSQL, Redis and MinIO in Docker) with the app embedded in a Kiwi course.
  - Import an existing database.
  - Verify the install, stop it, roll it back, and report to the human.
- **Out of scope.**
  - Production or shared hosting. There is no HTTPS, data lives in one SQLite file, and everything binds to `127.0.0.1`, so only browsers on this computer can reach the app. Students on other devices cannot connect.
  - Windows. Linux is unverified for standalone mode. The Kiwi demo supports macOS only.
  - Changing source code.
- **One Kiwi demo per machine.** The Docker project name and volumes are fixed (§7), so only one checkout per machine can run Kiwi mode.
- **Version facts.**
  - The code is on branch `codex/css-lab-v0.6.0` of `https://github.com/MAPS-research/ics-kiwi-app.git` (draft PR #2). `main` is older. The repository is private.
  - `package.json` reports `"version": "0.6.0"`, and `GET /api/health` returns `"version": "0.6.0"`.
  - This runbook describes commit `28092f6` (`docs: add delivery README and agent setup runbook; final polish fixes`) or a later commit on that branch. The older commit `e8d819e` also reports version 0.6.0 but lacks this file and the rest of `28092f6` (75 files changed), so the version alone does not identify the code; §6.1 checks the commit.
  - If a fresh clone does not contain this file, or §6.1 reports that it does not contain `28092f6`, the branch on GitHub is older than this runbook (the human has not pushed it yet). Stop and tell the human; do not deploy the older code.

## 2. Hard rules for the agent

1. **Never commit or stage secrets or data.** This covers `.env`, `.local/`, `data/`, `*.sqlite3*` and logs. They are git-ignored; do not force-add them. Do not commit, push, stash, reset or switch branches unless the human asks.
2. **Never print secrets.**
   - Do not `cat`, `head`, `grep` (without `-c`), open or upload any of these:
     - `.env`;
     - `.local/infra.env`, `.local/kiwi/.env`, `.local/demo-credentials.json`, and `.local/app-access.json` if an older setup left one (it may hold a copy of the teacher key);
     - `.local/logs/*`;
     - the database.
   - Check whether a variable is set with the name-only commands in this file. They print `KIWI_DB_PATH` and `KIWI_API_PORT` values (a path and a number), never a key.
   - Never echo a key. Never put one in a URL, a commit, a report or a chat message.
   - If you must read a log, show only lines that match the error you are investigating.
3. **Never run the app on an existing database without a fresh, verified backup** (§8). The first v0.6.0 start migrates the file.
4. **Never stop, restart, kill or reuse a process this runbook did not start** without the human's explicit yes. The runbook's own processes are the ones recorded in `.local/standalone/*.pid`. This includes:
   - an app API the human started in this checkout (for example a v0.5.1 `python3 server/app.py`);
   - `npm run demo:stop`, which stops whatever an earlier `demo:start` recorded in `.local/services.json` (possibly the human's live instance), and then runs `docker compose stop` on the shared Docker project `css-kiwi-demo`, whichever checkout started it.
5. **Never bind a port that is already in use, and never start a second API on a database another API is serving** (§5.6). Ask the human which free ports to use instead.
6. **Never invent, guess, generate or borrow an AI key.** Ask the human whether AI is wanted. If yes, the human pastes the key into `.env` in their own editor. Do not ask them to paste it into chat, and do not copy keys from other projects on the machine.
7. **Do not sign in to Kiwi and do not type human passwords.** The human signs in. Do not open `.local/demo-credentials.json`; tell the human where it is.
8. **Do not delete data.**
   - Move files aside instead of deleting anything under `data/` or `.local/` (§9.3 has the commands).
   - Never run `docker compose down -v`, `docker volume rm` or `rm -rf`.
   - Use `rm -f` only on the literal pid-file paths given in this file, never on a path built from a variable.
9. **Do not change machine configuration.** Do not edit shell profiles, global npm or pip packages, Docker settings or system services. If Node, Python or Docker is missing or too old, stop and ask the human.
10. **Ask before running commands that write to a database the human uses.** These are `node scripts/local-kiwi/verify-integration.mjs`, `node scripts/register-kiwi-app.mjs` and `npm run demo:seed`.
11. **Stop when a step says "stop and ask".** Do not improvise a destructive fix.
12. **Report truthfully.** Never report an unrun step as passed.

## 3. Conventions used below

- **Shell.** The blocks are written for bash (macOS's `/bin/bash` 3.2 is enough) and also work in zsh 5.9. zsh is the default login shell on macOS, and some agent tools run their shell commands in the login shell (Claude Code's Bash tool does). In any other shell, or when you adapt a block, run it under bash: put the block between `bash <<'SH'` and a final line `SH`; the `<<'PY'` blocks inside still work. When you adapt a block, never loop over an unquoted variable (`for x in $var`): zsh does not split it into words, so the loop runs once with the whole multi-line value. Loop over `$(command)` or `command | while read -r x` instead; zsh splits those.
- **Working directory.** Run every block from the repository root. If your tool resets the working directory between calls, begin each block with `cd <absolute repo path>`.
- **Shell state.** Variables do not survive between tool calls. The chosen ports are saved once in `.local/standalone/ports.env`, and later blocks load that file with `. .local/standalone/ports.env`.
- **Run-state directory.** Standalone pid and log files go in `.local/standalone/`. It is git-ignored, and the demo scripts do not use it.
- **macOS has no `timeout` command.** The wait loops below use `curl` and `sleep` instead.
- **Git never prompts.** Run every networked `git` command with `GIT_TERMINAL_PROMPT=0`, so a missing credential fails at once instead of waiting for a username.
- **Placeholders.** `<…>` marks a value you fill in from section 4. Write it literally into the command; do not export secrets.

## 4. Inputs to collect from the human

Ask these questions in one message and wait for answers. Defaults are in brackets.

| # | Question | Default | Used in |
| --- | --- | --- | --- |
| Q1 | Mode: **standalone** (app only, teacher key) or **Kiwi-linked** (full local Kiwi demo, macOS + Docker)? | standalone | §6 or §7 |
| Q2 | Where is the code? An existing checkout (absolute path), or clone into which directory? Cloning needs GitHub access to the private repositories (§5.9). | clone into `./ics-kiwi-app` | §6.1 |
| Q3 | Ports for the app API and UI. Standalone: both can move. Kiwi mode: the UI (8100) and 3000, 3001, 5433, 6380, 9002, 9003 are fixed; only the app API can move off 8101 (§7.2). | API 8101, UI 8100 | §5.6, §6.2, §7.2 |
| Q4 | Do you want the AI tutor? If yes, you will paste an OpenAI key into `.env` yourself. Kiwi mode requires one. | no | §6.5, §7.2 |
| Q5 | Is there existing data to keep? An existing `data/kiwi-lab.sqlite3` in this checkout, or a database file elsewhere (absolute path)? For a file elsewhere: **copy it into** this checkout (preferred; the original stays untouched) or **use it in place** (the app migrates and writes that file)? | none; copy in | §8 |
| Q6 | If `.env` already has a teacher key shorter than 32 characters, may I replace it? (The old key will stop working.) | no | §6.4 |
| Q7 | May I stop services that belong to this checkout, including an older app API that is serving this checkout's database? I will list them first. If not, I deploy into a separate clone with a copy of the data. | no | §5.6, §7.6, §8.1 |

Message template:

> To deploy CSS Kiwi Lab 0.6.0 I need: (1) standalone or Kiwi-linked mode; (2) repo path or clone location (cloning needs your GitHub access to the private repositories); (3) ports (default API 8101 / UI 8100; in Kiwi mode only the API port can change); (4) AI tutor yes/no; you would paste the key into `.env` yourself; (5) any existing database to keep, and for a file elsewhere whether I copy it in (default) or use it in place; (6) may I replace a short teacher key; (7) may I stop running services of this checkout, such as an older app API on its database, after I show you what they are. I will not sign in to Kiwi or handle passwords; you do that. The app will be reachable from this computer only.

## 5. Preflight checks

Run all checks and collect the results before you change anything. Then report any FAIL to the human.

### 5.1 OS and architecture

```bash
uname -s -m
```

- **Expect:** `Darwin arm64` or `Darwin x86_64`. Kiwi mode needs Darwin. `Linux x86_64` is acceptable for standalone only; record it as an unverified platform.
- **If it fails:** on Windows (or anything else), stop and tell the human this platform is not supported.

### 5.2 Node.js and npm

```bash
node -v && npm -v
node -e 'const m=+process.versions.node.split(".")[0]; if(!([20,22].includes(m)||m>=24)){console.error("FAIL node "+process.versions.node); process.exit(1)} console.log("PASS node "+process.versions.node)'
```

- **Expect:** `PASS node 20.x`, `22.x` or `24.x` or later. Node 21 and 23 fail because vitest 4.1.11 does not support them.
- **If it fails:** stop and ask the human to install Node 20, 22 or 24 (for example through nvm). Do not install it yourself.

### 5.3 Python and SQLite features

```bash
python3 - <<'PY'
import sqlite3, sys
assert sys.version_info >= (3, 10), f"FAIL python {sys.version.split()[0]} (need 3.10+)"
con = sqlite3.connect(":memory:")
con.execute("SELECT json_extract('{\"a\": 1}', '$.a')")
con.execute("SELECT ROW_NUMBER() OVER () FROM (SELECT 1)")
print("PASS python", sys.version.split()[0], "sqlite", sqlite3.sqlite_version, "at", sys.executable)
if sqlite3.sqlite_version_info < (3, 45):
    print("WARN sqlite", sqlite3.sqlite_version, "is older than 3.45: npm run test:server fails its SQLite version check; the app was verified on 3.45 only")
PY
```

- **Expect:** `PASS python 3.x sqlite 3.y at <path>` and no WARN line. The app uses the Python standard library only, so there is nothing to `pip install`.
- **If it fails:**
  - An `AssertionError` or "no such function" means `python3` resolves to an old interpreter. Ask the human which Python 3.10+ to use.
  - On a WARN line, tell the human; standalone deployment can continue, but expect V1 (§12) to report one failure.
  - With conda, the human activates the environment, or you run `source "<conda base>/etc/profile.d/conda.sh" && conda activate <env>` in each block. The base directory varies (for example `/opt/anaconda3`, `$HOME/anaconda3` or `$HOME/miniconda3`); `conda info --base` prints it. If that fails in your tool's shell (a `conda` shell function inherited without its `CONDA_EXE` fails in zsh; `bash -c 'conda info --base'` may still work), ask the human for the path. Do not guess it.
  - All npm scripts call bare `python3`, so it must resolve correctly in every block.

### 5.4 Git, curl, lsof and optional tools

```bash
for t in git curl lsof pgrep; do command -v "$t" >/dev/null && echo "PASS $t" || echo "FAIL $t missing"; done
for t in sqlite3 openssl docker; do command -v "$t" >/dev/null && echo "ok   $t" || echo "info $t not installed"; done
```

- **Expect:** PASS for git, curl, lsof and pgrep. `sqlite3` is optional: §8 and §11 have Python fallbacks. `docker` is needed for Kiwi mode only.
- **If it fails:** stop and ask the human to install the missing tool.

### 5.5 Environment variables that would override `.env`

```bash
for v in KIWI_TEACHER_KEY OPEN_AI_TEST_KEY OPENAI_API_KEY KIWI_DB_PATH KIWI_API_PORT KIWI_CLASS_IDS KIWI_STANDALONE_CLASS_IDS KIWI_API_ORIGIN; do
  printenv "$v" >/dev/null && echo "WARN $v is set in the shell environment (it overrides .env)"
done; echo "env check done"
```

- **Expect:** only `env check done`. Real environment variables win over `.env`.
- **If it fails:** for each WARN, tell the human the variable name (never its value) and ask whether it is intended. Do not unset anything in their profile. In Kiwi mode, a shell `KIWI_API_PORT` wins over `.env` for `demo:start` too, so it must not be set in the shell (§7.2).

### 5.6 Ports and running services

#### (a) Ports

Standalone (fill in the ports from Q3):

```bash
for p in <API_PORT> <UI_PORT>; do
  pid=$(lsof -nP -tiTCP:$p -sTCP:LISTEN 2>/dev/null | head -1)
  if [ -z "$pid" ]; then echo "PASS $p free"; continue; fi
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  echo "BUSY $p pid=$pid program=$(ps -p "$pid" -o comm= | xargs basename) cwd=$cwd"
done
```

Kiwi mode:

```bash
for p in 3000 3001 8100 8101 5433 6380 9002 9003; do
  pid=$(lsof -nP -tiTCP:$p -sTCP:LISTEN 2>/dev/null | head -1)
  if [ -z "$pid" ]; then echo "PASS $p free"; continue; fi
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  echo "BUSY $p pid=$pid program=$(ps -p "$pid" -o comm= | xargs basename) cwd=$cwd"
done
```

#### (b) Running app APIs, on any port (every mode)

An app API that serves a database does not keep the file open between requests: it opens a new SQLite connection for each request and closes it afterwards (`server/db.py`, `connection()`). So `lsof <database>` prints nothing even while an API is serving that file, and a free port proves nothing about the database. This block finds every running API and the database it uses.

```bash
found=0
# WHY $(pgrep …) and not a variable: zsh does not split an unquoted $pids into words, so two APIs became one garbled line.
for pid in $(pgrep -f '[s]erver/app\.py'); do
  found=1
  cmd=$(ps -p "$pid" -o command= 2>/dev/null)
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  port=$(lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n.*://p' | head -1)
  db=$(python3 - "$cwd" "$cmd" <<'PY'
import os, re, sys
cwd, cmd = sys.argv[1], sys.argv[2]
if not cwd:   # WHY: joining "" would resolve to *your* directory and wrongly name this checkout's database
    print("unknown (cwd not readable; ask the human)")
    sys.exit(0)
m = re.search(r"(\S*)server/app\.py", cmd)
root = os.path.realpath(os.path.join(cwd, m.group(1) if m else "."))
value = None
try:
    with open(os.path.join(root, ".env")) as fh:   # prints only the KIWI_DB_PATH value (a path), never other lines
        for line in fh:
            hit = re.match(r"^\s*KIWI_DB_PATH\s*=(.*)$", line)
            if hit:
                value = hit.group(1).strip().strip("\"'"); break
except OSError:
    pass
print(os.path.realpath(os.path.join(cwd, value)) + " (KIWI_DB_PATH in its .env)" if value else os.path.join(root, "data", "kiwi-lab.sqlite3") + " (default)")
PY
)
  echo "API pid=$pid port=${port:-none} cwd=${cwd:-unknown} db=$db"
done
[ "$found" = 1 ] || echo "PASS no app API is running"
```

- **Expect:** one `API pid=… port=… cwd=… db=…` line per running API, each with a single pid, or `PASS no app API is running`. A line whose `pid=` value spans two lines means the block ran in a shell that did not split the pid list: re-run it under bash (§3).
- The `db=` value is what that API's `.env` implies. A `KIWI_DB_PATH` exported in the shell that started it cannot be seen (macOS does not show other processes' environments), so ask the human when in doubt.
- `db=unknown (cwd not readable; ask the human)` means `lsof` could not read that process's working directory (another user's process, or one that just exited). Treat it as possibly serving the database you will use, and ask the human which database it serves.

#### (c) Kiwi Docker project (Kiwi mode only)

The project name `css-kiwi-demo` is the same for every checkout. Decide ownership from the container label, not from the name:

```bash
REPO=$(pwd -P)
docker ps -a --filter label=com.docker.compose.project=css-kiwi-demo --format '{{.Names}} {{.State}} {{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | while read -r name state dir; do
  [ "$dir" = "$REPO/scripts/local-kiwi" ] && owner="THIS CHECKOUT" || owner="OTHER CHECKOUT"
  echo "container $name $state working_dir=$dir ($owner)"
done
docker volume ls --filter name=css-kiwi-demo_ --format 'volume {{.Name}}' 2>/dev/null
[ -f .local/infra.env ] && echo "this checkout has .local/infra.env" || echo "this checkout has no .local/infra.env"
```

`docker compose ls` shows the same thing: the project belongs to this checkout only when its `ConfigFiles` is `<repo>/scripts/local-kiwi/compose.yaml`.

#### Reading the results

- **Expect:** `PASS <port> free` for every port; `PASS no app API is running`, or only APIs whose `db=` is not a database this deployment will use; in Kiwi mode, no `css-kiwi-demo` container and no `css-kiwi-demo_*` volume (fresh install), or containers marked `THIS CHECKOUT` (existing demo).
- **If it fails:**
  - **An API serves the database you will use.** Its `db=` is this checkout's `data/kiwi-lab.sqlite3`, or the Q5 file you would use in place, or `unknown` until the human tells you otherwise. This applies on any port, even when the ports you chose are free. Do **not** start a second API against that file: the v0.6.0 API would migrate it while the other API keeps writing, and those later writes would be missing from every backup. Ask Q7:
    - **yes:** stop that pid after the human confirms it (`kill <pid>`, then re-run (b)), and continue with §8;
    - **no:** leave it running and deploy into a separate fresh clone (§6.1), importing a copy of the database (§8 with **Copy it in**).
  - **Standalone, a busy port that is not such an API:** pick other free ports. Re-run (a) with candidates (for example 8401 and 8421) and confirm them with the human. Never stop the busy process.
  - **Kiwi mode, owned by this checkout:** a BUSY line whose `cwd` is this checkout or its `.local/kiwi*`, or a Docker port (`com.docker.backend`) whose containers are marked `THIS CHECKOUT` in (c), belongs to an existing demo of this checkout. Ask Q7. With a yes, go to §7.6 (existing demo).
  - **Kiwi mode, another checkout owns the project:** a container marked `OTHER CHECKOUT`, or `css-kiwi-demo_*` volumes while this checkout has no `.local/infra.env`. Stop and ask. Do not run `demo:setup`, `demo:start` or `demo:stop` here: setup would reuse the other checkout's volumes with a newly generated password, and `demo:stop` would stop the other checkout's containers.
  - **Kiwi mode, anything else on the ports:** stop and ask. The demo cannot change its ports, with one exception: when only 8101 is busy, and the holder is not an app API serving the database you will use, the human may choose to move the app API to a free port instead (§7.2). Check the candidate with block (a) first.

### 5.7 Docker (Kiwi mode only)

```bash
docker info --format 'PASS docker server {{.ServerVersion}}' && docker compose version
```

- **Expect:** `PASS docker server <version>` and `Docker Compose version v2.x`.
- **If it fails:** ask the human to start Docker Desktop, then re-run. Compose v1 (`docker-compose`) is not supported.

### 5.8 Disk space

```bash
df -h .
```

- **Expect:** at least 1 GB free for standalone and at least 5 GB for Kiwi mode. Measured on one Mac: `node_modules` 278 MB and `public/webr` 47 MB; the Kiwi checkouts, runtime and cache about 2.1 GB; Docker images about 0.9 GB.
- **If it fails:** stop and tell the human how much space is free.

### 5.9 Network and repository access

```bash
curl -sS -o /dev/null -w 'npm registry %{http_code}\n' https://registry.npmjs.org/
curl -sS -o /dev/null -w 'github %{http_code}\n' https://github.com/
for r in MAPS-research/ics-kiwi-app NYUSH-ML/kiwi NYUSH-ML/kiwi-ui; do
  GIT_TERMINAL_PROMPT=0 git ls-remote "https://github.com/$r.git" HEAD >/dev/null 2>&1 && echo "PASS $r readable" || echo "FAIL $r not readable"
done
```

- **Expect:**
  - HTTP 200 for both, or another 2xx/3xx code. Kiwi setup also downloads from `https://nodejs.org` and Docker Hub.
  - All three repositories are private. `MAPS-research/ics-kiwi-app` must be readable when you clone (§6.1). `NYUSH-ML/kiwi` and `NYUSH-ML/kiwi-ui` must be readable for Kiwi mode, unless `.local/kiwi` and `.local/kiwi-ui` already exist (setup clones only missing checkouts).
- **If it fails:**
  - For network errors, ask the human about proxy settings (`http_proxy` / `https_proxy`). Do not edit their profile.
  - For a needed repository that is not readable, stop and ask the human to authenticate (`gh auth login`, or a credential helper) and, for the Kiwi repositories, to get access to the `NYUSH-ML` organization. Do not enter credentials yourself. Re-run this block afterwards.

### 5.10 Existing data

Run this inside an existing checkout; for a fresh clone, run it after §6.1.

```bash
ls -la data/ 2>/dev/null || echo "no data/ directory"
ls -la data/backups/ 2>/dev/null || echo "no data/backups/"
```

- **Expect:** `no data/ directory` on a fresh checkout.
- **If it fails:** if `data/kiwi-lab.sqlite3` exists, treat Q5 as "existing data" and do §8 before any start, even if the human said "none". Tell them.

## 6. Standalone mode

### 6.1 Get the code

Fresh clone (the repository is private; §5.9 must show it readable):

```bash
GIT_TERMINAL_PROMPT=0 git clone --branch codex/css-lab-v0.6.0 https://github.com/MAPS-research/ics-kiwi-app.git ics-kiwi-app
cd ics-kiwi-app
```

Existing checkout:

```bash
git status --short --branch | head -5
git rev-parse --abbrev-ref HEAD
```

Both:

```bash
node -p 'require("./package.json").version'
git log -1 --format='%h %s'
git merge-base --is-ancestor 28092f6889e9fe2451fca2ac29689b56a7fddc83 HEAD 2>/dev/null && echo "PASS commit 28092f6 or later" || echo "FAIL this checkout does not contain commit 28092f6"
```

- **Expect:** `0.6.0`, the commit line (`28092f6 docs: add delivery README and agent setup runbook; final polish fixes`, or a later commit), then `PASS commit 28092f6 or later`. An existing checkout should already be on `codex/css-lab-v0.6.0`.
- **If it fails:**
  - On `FAIL … does not contain commit 28092f6`, typically with `e8d819e fix: resolve PR #2 known minor issues` as the commit line, the branch was not pushed after this runbook was written: the code differs from what this runbook and its expected numbers (§12) describe. Stop and tell the human that the branch must be pushed first. Do not continue with the older code. (The check also fails in a `--depth` clone that does not reach `28092f6`; the clone command above is not shallow.)
  - `fatal: could not read Username` or `Repository not found`: no access to the private repository. Stop and ask the human to authenticate (§5.9); do not enter credentials yourself.
  - If an existing checkout is on another branch or has local changes, stop and ask. Do not switch branches or discard changes.
  - If the directory already exists, skip the clone; do not re-clone over it.

### 6.2 Record the chosen ports

Use the ports confirmed in §5.6.

```bash
mkdir -p .local/standalone
printf 'API_PORT=%s\nUI_PORT=%s\n' <API_PORT> <UI_PORT> > .local/standalone/ports.env
. .local/standalone/ports.env && echo "API_PORT=$API_PORT UI_PORT=$UI_PORT"
git check-ignore -q .local/standalone/ports.env && echo "PASS ignored by git"
```

- **Expect:** the two ports, then `PASS ignored by git`.
- **If it fails:** if the file is not ignored, stop. `.gitignore` must contain `.local/`.

### 6.3 Install dependencies

`npm ci` deletes and reinstalls `node_modules`, which breaks any Vite already running from this checkout. In an existing checkout, check first:

```bash
[ -d node_modules ] && npm ls --depth=0 >/dev/null 2>&1 && echo "SKIP npm ci: node_modules matches package.json" || echo "RUN npm ci"
```

If it prints `RUN npm ci` (always the case on a fresh clone):

```bash
npm ci
```

Then, in both cases:

```bash
ls -l public/webr/webr-worker.js public/webr/R.wasm || npm run prepare:webr
```

- **Expect:**
  - `npm ci` ends with `added <n> packages …` and an audit summary. On 2026-10-23 it read `5 vulnerabilities (3 moderate, 2 high)`. These are dev-only advisories in the test toolchain: `npm audit --omit=dev` reports `found 0 vulnerabilities` (see `docs/handoff/v0.6.0-open-questions.md` § C and decision D7). On a fast network `npm ci` took about 2 s with a warm cache.
  - Both webR files are listed (`R.wasm` is about 18 MB). This listing is the proof that the `postinstall` step (`npm run prepare:webr`) ran: npm 10 hides lifecycle-script output, so the `Copied webR runtime to …` line usually does not appear.
- **Do not run `npm audit fix`** (with or without `--force`). It rewrites `package-lock.json` and changes the test toolchain.
- **Before you run `npm ci` in an existing checkout:** if §5.6 showed a process whose `cwd` is this checkout, ask the human first.
- **If it fails:**
  - If `npm ci` reports that the lockfile and `package.json` disagree, report it. Do not fall back to `npm install` without the human's agreement, because that rewrites `package-lock.json`.
  - If `public/webr` is missing (for example after `--ignore-scripts`), the block above runs `npm run prepare:webr`.
  - For network errors, see §5.9.

### 6.4 Create `.env` and the teacher key without printing it

#### (a) Teacher key

```bash
[ -f .env ] || cp .env.example .env
chmod 600 .env
python3 - <<'PY'
import os, re, secrets
from pathlib import Path
env = Path(".env")
lines = env.read_text().splitlines()
def line_numbers(name):
    pat = re.compile(rf"^\s*{name}\s*=")
    return [i + 1 for i, line in enumerate(lines) if pat.match(line)]
# WHY: the API (load_dotenv) and the demo scripts (config.mjs readEnv) both use the first line of a name and only warn
# about the others, so a key appended below an empty line would be ignored; one line each makes the intent clear.
dups = {n: line_numbers(n) for n in ("KIWI_TEACHER_KEY", "OPENAI_API_KEY", "OPEN_AI_TEST_KEY", "KIWI_DB_PATH", "KIWI_API_PORT", "KIWI_CLASS_IDS", "VITE_KIWI_ORIGIN")}
dups = {n: l for n, l in dups.items() if len(l) > 1}
if dups:
    raise SystemExit("STOP: .env has more than one line for " + "; ".join(f"{n} (lines {l})" for n, l in dups.items()) + ". Ask the human which to keep.")
pattern = re.compile(r"^\s*KIWI_TEACHER_KEY\s*=(.*)$")
hits = [i for i, line in enumerate(lines) if pattern.match(line)]
current = pattern.match(lines[hits[0]]).group(1).strip().strip("\"'") if hits else ""
replace = os.environ.get("REPLACE_TEACHER_KEY") == "1"
if len(current) >= 32 and not replace:
    print("KIWI_TEACHER_KEY: already set (32+ characters); left unchanged.")
elif current and not replace:
    print("KIWI_TEACHER_KEY: set but shorter than 32 characters; left unchanged. Ask the human (Q6).")
else:
    new = "KIWI_TEACHER_KEY=" + secrets.token_hex(24)
    if hits:
        lines[hits[0]] = new
    else:
        lines.append(new)
    env.write_text("\n".join(lines) + "\n")
    print("KIWI_TEACHER_KEY: generated (48 hex characters) and written to .env; value not shown.")
PY
grep -c '^KIWI_TEACHER_KEY=' .env
ls -l .env | cut -c1-10
```

If the human answered yes to Q6, re-run the same block with the Python line changed to `REPLACE_TEACHER_KEY=1 python3 - <<'PY'`. The API reads the key once at start, so if it is already running, restart it afterwards (§9.1, then §6.6).

- **Expect:**
  - one of the three `KIWI_TEACHER_KEY:` messages, then `1`, then `-rw-------`.
- **Why one line matters:** the API (`server/app.py`, `load_dotenv`) and the demo scripts (`scripts/local-kiwi/config.mjs`, `readEnv`) both use the **first** line of a name and ignore the later ones. Both print `Warning: .env sets <names> on more than one line; the first line of each is used.` (names only). An empty first `KIWI_TEACHER_KEY=` line therefore means "no key", even if a real key follows on a later line. A duplicate usually means someone appended a value that never takes effect, so the script stops and asks, and it edits the key line in place instead of appending.
- **If it fails:**
  - On `STOP: … more than one line`, ask the human which line to keep. Show the names and line numbers only.
  - If `.env.example` is missing, the checkout is incomplete; return to §6.1.

#### (b) Name-only `.env` report (run every time)

Run this now and again after any `.env` change. It prints whether each key is set, and the values of `KIWI_DB_PATH` and `KIWI_API_PORT`, which are a path and a number.

```bash
python3 - <<'PY'
import re
from pathlib import Path
vals, counts = {}, {}
for line in Path(".env").read_text().splitlines():
    m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$", line)
    if m:
        counts[m.group(1)] = counts.get(m.group(1), 0) + 1
        vals.setdefault(m.group(1), m.group(2).strip().strip("\"'"))   # first occurrence wins, as in the API and the demo scripts
for k in ("KIWI_TEACHER_KEY", "OPENAI_API_KEY", "OPEN_AI_TEST_KEY"):
    print(f"{k}:", "set" if vals.get(k) else "not set")
for k in ("KIWI_DB_PATH", "KIWI_API_PORT"):
    if vals.get(k): print(f"NOTE {k}={vals[k]} is set in .env")
for k in ("KIWI_CLASS_IDS", "KIWI_STANDALONE_CLASS_IDS", "KIWI_API_ORIGIN"):
    if vals.get(k): print(f"NOTE {k} is set in .env (name only shown)")
for k, n in sorted(counts.items()):
    if n > 1: print(f"WARN {k} appears on {n} lines")
PY
```

- **Expect:** `KIWI_TEACHER_KEY: set`; the AI keys as wanted (Q4); no WARN line. A `.env` copied from `.env.example` also prints `NOTE KIWI_CLASS_IDS …` and `NOTE KIWI_API_ORIGIN …`: those are the example's defaults (`local-css-demo` and `http://localhost:3000`) and are expected.
- **Notes:**
  - If `KIWI_API_PORT` is set in `.env`, the API uses it unless the shell sets another value. §6.6 always sets it in the shell. In Kiwi mode it is allowed only as described in §7.2.
  - If `KIWI_DB_PATH` is set in `.env`, that file is the database: use it as `<DB>` in §8.
  - On a WARN line, ask the human which line to keep.

### 6.5 AI key (only if Q4 = yes)

Ask the human:

> Please open `.env` in your editor and put your OpenAI key after `OPEN_AI_TEST_KEY=` (one line, no quotes needed). Save the file and tell me when you are done. Do not paste the key here.

Then re-run the name-only report (§6.4 (b)).

- **Expect:** `OPEN_AI_TEST_KEY: set` or `OPENAI_API_KEY: set`, and no WARN line. If both are set, the API uses `OPENAI_API_KEY` and `demo:setup` uses `OPEN_AI_TEST_KEY`.
- **If it fails:** if both say `not set`, ask the human again. Do not continue to a Kiwi setup without a key.

### 6.6 Start the API and UI in the background

The block skips any process that is already running from an earlier run.

```bash
. .local/standalone/ports.env
mkdir -p .local/standalone
running() { pid=$(cat "$1" 2>/dev/null) && [ -n "$pid" ] && ps -p "$pid" -o command= | grep -qE "$2"; }
if running .local/standalone/api.pid 'server/app.py'; then echo "api: already running"; else
  if lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "STOP: port $API_PORT is busy"; else
    nohup env KIWI_API_PORT="$API_PORT" python3 server/app.py >> .local/standalone/api.log 2>&1 < /dev/null &
    echo $! > .local/standalone/api.pid; echo "api: started pid $(cat .local/standalone/api.pid)"
  fi
fi
if running .local/standalone/ui.pid 'vite/bin/vite.js'; then echo "ui: already running"; else
  if lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "STOP: port $UI_PORT is busy"; else
    nohup env KIWI_API_PORT="$API_PORT" BROWSER=none node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$UI_PORT" --strictPort >> .local/standalone/ui.log 2>&1 < /dev/null &
    echo $! > .local/standalone/ui.pid; echo "ui: started pid $(cat .local/standalone/ui.pid)"
  fi
fi
```

- **Expect:** `api: started pid N` and `ui: started pid M`, or `already running`. Both processes bind `127.0.0.1` only. `KIWI_API_PORT` is passed to Vite too, so its `/api` proxy points at the right port.
- **Before you start:** §5.6 (b) must show no other API serving this database. **On an existing database, do not start until §8.1–8.3 are done.** The v0.6.0 API binds its port first and opens the database only after that: when the port is taken, it exits with code 1 and leaves the file untouched. That does not make a second API safe. An older API serving the same file on another port keeps writing to it while v0.6.0 migrates it, and a v0.5.1 API opens and initializes the database *before* it binds, even when its port is taken.
- **If it fails:** on `STOP: port … is busy`, return to §5.6.

### 6.7 Wait until ready

```bash
. .local/standalone/ports.env
ok=""; for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$UI_PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] && echo "READY" || { echo "NOT READY after 60 s"; tail -n 20 .local/standalone/api.log; tail -n 20 .local/standalone/ui.log; }
```

- **Expect:** `READY` within a few seconds (on the first poll in testing). On an empty database the first start creates `data/kiwi-lab.sqlite3` and runs 13 migrations, with no backup.
- **If it fails:** use the log lines printed. They contain no secrets: the API logs `METHOD /path STATUS` without query strings.

  | Log | Message | Meaning |
  | --- | --- | --- |
  | `api.log` | `Kiwi Lab API did not start: port <API_PORT> on 127.0.0.1 is already in use. … the database was not opened.` | The API port was taken; the API exited before opening the database, so nothing was migrated. Go back to §5.6. |
  | `api.log` | `Kiwi Lab API did not start: cannot listen on 127.0.0.1:<API_PORT> (…)` | Another listen error; the text in parentheses says which. The database was not opened. Report it, or pick another port (§5.6, §6.2). |
  | `api.log` | `Warning: .env sets <names> on more than one line; the first line of each is used.` | Not fatal, but §6.4 (b) should have caught it. Ask the human which line to keep, then restart (§9.1, §6.6). |
  | `api.log` | `Kiwi Lab API did not start: Could not back up the database before …` | `data/backups` is not writable or the disk is full. Fix the cause; no data was changed. |
  | `api.log` | `ValueError: invalid literal for int() with base 10: …` | `KIWI_API_PORT` is not a number (in `ports.env`, the shell or `.env`; an empty `KIWI_API_PORT=` line counts). |
  | `ui.log` | `KIWI_API_PORT must be a port number, got "…"` | The same problem, reported by `vite.config.ts`. |
  | `ui.log` | `Port <UI_PORT> is already in use` | The UI port was taken (`--strictPort`). Go back to §5.6. |

  `Kiwi Lab API: http://127.0.0.1:<port>` is printed after the port is bound and the migrations have run, right before the API starts serving. The `curl` checks above remain the readiness test, because they also cover the UI and its proxy.

**Then make sure the data directory is private.** Since the commit that follows `28092f6`, the API creates a new `data/` as 0700 and a new `data/kiwi-lab.sqlite3` as 0600 (its backups were already 0600 in a 0700 directory). It does not change a directory or database that already existed, for example one copied in (§8.3) or created by an older version, which may be 0755/0644 and so readable by other users of this computer. Run this every time you reach this point (the restart after §8.3 included); it changes nothing when the modes are already right. Changing the modes while the API runs is safe, and SQLite gives a new `-wal`/`-shm` file the mode of the database file.

```bash
chmod 700 data
for f in data/kiwi-lab.sqlite3 data/kiwi-lab.sqlite3-wal data/kiwi-lab.sqlite3-shm; do [ -e "$f" ] && chmod 600 "$f"; done
ls -ld data data/kiwi-lab.sqlite3 | cut -c1-10
```

- **Expect:** `drwx------`, then `-rw-------`.
- **With `KIWI_DB_PATH`:** run the same `chmod 600` on that file and its `-wal`/`-shm`. Ask the human before changing the mode of a directory outside this checkout.
- This is a gap in the app, not in your setup: `server/db.py` (`connection()`) creates the directory and the file without setting a mode. Mention it in the report (§13).

### 6.8 Health check

```bash
. .local/standalone/ports.env
curl -s "http://127.0.0.1:$UI_PORT/api/health" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True and d.get("runtime")=="browser-webR" and d.get("version")=="0.6.0", d; print("PASS health", d)'
# WHY: every v0.6.0 API returns the same health body, so prove that the UI proxy reaches *this* checkout's API:
# send an unknown path through the UI and look for it in this API's log (the API logs paths, never query strings).
PROBE="agent-probe-$(date +%s)-$$"
curl -s -o /dev/null -w 'probe through the UI -> HTTP %{http_code}\n' "http://127.0.0.1:$UI_PORT/api/$PROBE"
sleep 1
grep -q "GET /api/$PROBE 404" .local/standalone/api.log && echo "PASS the UI proxy reaches this checkout's API on port $API_PORT" || echo "FAIL the UI proxy reaches some other API"
```

- **Expect:** `PASS health {'ok': True, 'runtime': 'browser-webR', 'aiAvailable': <bool>, 'version': '0.6.0'}`, `probe through the UI -> HTTP 404`, then `PASS the UI proxy reaches this checkout's API on port <API_PORT>`.
  - `aiAvailable` is `True` only when an AI key is set; it does not prove the key works.
  - The health request goes through the UI proxy, so it checks both processes. The probe proves which API the proxy reaches: `vite.config.ts` sends `/api` to `KIWI_API_PORT`, or to 8101 when that is unset, and 8101 may be the human's live API. The probe is a read-only `GET` that answers 404 on any API.
- **If it fails:**
  - If `version` is missing, an older API answered. Some other v0.5.1 process is on that port; stop and ask.
  - A connection error means a process died; return to §6.7 and read the log lines.
  - On `FAIL the UI proxy reaches some other API`, the UI was started without the right `KIWI_API_PORT`. Do not run §6.9: its writes would land in that other API's database. Stop this checkout's UI (§9.1 stops both; then start again with §6.6) and re-run this block. If it fails again, stop and ask.

### 6.9 Smoke test with curl

Run it only after §6.8 printed `PASS the UI proxy reaches this checkout's API`. The key is read into a shell variable and never printed. The key, the demo token and the session token reach `curl` on its standard input (`-H @-`, `--data-binary @-`, curl 7.55 or later), never as command-line arguments, which other users of this computer could read with `ps`; `printf` is a shell builtin, so it does not show up there either. Sub-step (c) creates one roster entry named `agent-smoke-test`. On an imported database, ask the human before running (c) and (d).

```bash
. .local/standalone/ports.env
B="http://127.0.0.1:$UI_PORT/api"; C="classId=local-r-class"
KEY=$(python3 -c 'import re,pathlib; print(next(m.group(1).strip().strip("\"\x27") for l in pathlib.Path(".env").read_text().splitlines() if (m:=re.match(r"^\s*KIWI_TEACHER_KEY\s*=(.*)$", l))))')
# (a) teacher key accepted, wrong key refused
printf 'X-Teacher-Key: %s\n' "$KEY" | curl -s -X POST -H @- "$B/teacher/verify?$C"; echo
curl -s -o /dev/null -w 'wrong key -> HTTP %{http_code}\n' -X POST -H "X-Teacher-Key: not-the-key" "$B/teacher/verify?$C"
# (b) course read (public)
curl -s "$B/course?$C" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("course:", d["title"], "|", len(d["units"]), "chapters")'
# (c) teacher creates a demo link for a test student
LINK=$(printf 'X-Teacher-Key: %s\n' "$KEY" | curl -s -X POST -H @- -H 'Content-Type: application/json' -d '{"studentId":"agent-smoke-test"}' "$B/teacher/demo-links?$C" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["url"].split("#demo=",1)[1])')
[ -n "$LINK" ] && echo "demo link: created (token not shown)"
# (d) the student exchanges the link for a session and makes read-only requests
SESSION=$(printf '{"token":"%s"}' "$LINK" | curl -s -X POST -H 'Content-Type: application/json' --data-binary @- "$B/demo/session?$C" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
printf 'X-Demo-Session: %s\n' "$SESSION" | curl -s -H @- "$B/me?$C" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("student me:", d["kind"], d["role"], d["userId"])'
printf 'X-Demo-Session: %s\n' "$SESSION" | curl -s -o /dev/null -w 'student work list -> HTTP %{http_code}\n' -H @- "$B/work?$C"
curl -s -o /dev/null -w 'anonymous work list -> HTTP %{http_code}\n' "$B/work?$C"
```

- **Expect** (verified on a fresh database):

  ```
  {"ok": true, "role": "instructor"}
  wrong key -> HTTP 401
  course: Introduction to Computational Social Science | 5 chapters
  demo link: created (token not shown)
  student me: demo student agent-smoke-test
  student work list -> HTTP 200
  anonymous work list -> HTTP 401
  ```

  On an imported database, the course title and chapter count are the stored ones.
- **If it fails:**
  - `503 … teacher_key_not_configured`: the API started before the key existed, or the first key line is empty. Fix it with §6.4, then restart (§9.1, then §6.6).
  - `401` on (a): the key does not match. Re-check §6.4 and §5.5 (a shell `KIWI_TEACHER_KEY` overrides `.env`).
  - `429`: 10 wrong keys from this address within 60 s. Every key, the correct one included, is then refused until a minute has passed since the oldest failure. Wait 60 s.
  - `403 "Demo links are only for standalone courses"`: `local-r-class` is Kiwi-linked (it is in `KIWI_CLASS_IDS`, or a Kiwi token was used for it). Stop and ask.
  - `404 unknown_course` on student writes: not expected here, because (d) is read-only.

### 6.10 Hand over to the human

Tell the human, filling in the ports:

- **Reach:** these URLs open only in a browser on this computer (everything binds `127.0.0.1`). Students on their own devices cannot connect.
- **Workspace selection:** `http://127.0.0.1:<UI_PORT>/entry`.
- **Teacher:** `http://127.0.0.1:<UI_PORT>/teacher/home`. Paste the teacher key into **Local demo or staff access key** and click **Open local demo workspace**. The key is the `KIWI_TEACHER_KEY=` line in `<repo>/.env`. The human can show it with `grep '^KIWI_TEACHER_KEY=' .env`; you do not show it.
- **Student:** `http://127.0.0.1:<UI_PORT>/student/assignments`. Pick **Demo student**, or use a link from Students › Roster › edit student › **Create demo link**. To test both roles in one browser, use `127.0.0.1` for one and `localhost` for the other, so their storage stays separate.
- **Logs:** `.local/standalone/api.log` and `.local/standalone/ui.log`. **Stop:** §9.1.
- **Test student:** the roster now has `agent-smoke-test`. The human can set its status to *Dropped* in Students › Roster.
- **Next steps:** README › *First-time setup for a course* (course info, schedule, the SOCS-SH 190 template, roster import, staff keys).

## 7. Kiwi-linked mode (full local Kiwi demo, macOS only)

The demo uses fixed ports: Kiwi API 3000, Kiwi UI 3001, app UI 8100, PostgreSQL 5433, Redis 6380, MinIO 9002 and 9003. The app API uses 8101 unless `.env` sets `KIWI_API_PORT` (§7.2). All bind `127.0.0.1`. It does not touch other Docker projects or the human's own 5432, 6379 or 9000.

**Only one checkout per machine can run Kiwi mode.** The Docker project name (`name: css-kiwi-demo` in `scripts/local-kiwi/compose.yaml`) and its volumes `css-kiwi-demo_db-data`, `css-kiwi-demo_redis-data` and `css-kiwi-demo_oss-data` are the same for every checkout. `.local/infra.env` holds the passwords those volumes were initialised with, and a second checkout's setup would generate different ones. `demo:stop` runs `docker compose stop` on that one shared project. §5.6 (c) decides which checkout owns it.

### 7.1 Prerequisites

1. §5.1 must show Darwin, §5.7 must pass, and §5.8 must show at least 5 GB free.
2. §5.6 (c) must show no `css-kiwi-demo` container and no `css-kiwi-demo_*` volume (fresh install), or containers marked `THIS CHECKOUT` (existing demo: go to §7.6).
3. For a fresh install, all eight ports must be free (§5.6 (a)), and §5.9 must show `NYUSH-ML/kiwi` and `NYUSH-ML/kiwi-ui` readable.
4. Do §6.1 (code) and §6.3 (`npm ci`).

### 7.2 `.env` for the demo

Do §6.4 (teacher key; needed only for standalone access next to the demo) and §6.5 (AI key, **required**).

- **Expect:** the §6.4 (b) report shows `OPEN_AI_TEST_KEY: set` or `OPENAI_API_KEY: set`, and no `NOTE KIWI_API_PORT` line (unless the human moved the app API, below).
- **App API port.** Keep the default 8101 and leave `KIWI_API_PORT` unset, unless §5.6 showed 8101 busy and the human chose to move the app API.
  - `demo:start`, `demo:status`, `demo:seed` and `verify-integration.mjs` take `KIWI_API_PORT` from the shell, then `.env`, then 8101 (`scripts/local-kiwi/config.mjs`, `apiPort`). `demo:start` runs the app API on that port, polls its readiness there and gives Vite the same value, so the UI's `/api` proxy follows. The UI stays on 8100, because the Kiwi app registration points there; Kiwi stays on 3000 and 3001.
  - To move it, put exactly one `KIWI_API_PORT=<port>` line in `.env`, with the port the human confirmed and that §5.6 (a) showed free. Never set it in the shell: a later `demo:start` from another shell would not see it. Use this block, which prints only the port:

```bash
python3 - <PORT> <<'PY'
import re, sys
from pathlib import Path
port = sys.argv[1]
if not re.fullmatch(r"\d{2,5}", port):
    raise SystemExit("STOP: the port must be 2-5 digits")
env = Path(".env")
lines = env.read_text().splitlines()
hits = [i for i, line in enumerate(lines) if re.match(r"^\s*KIWI_API_PORT\s*=", line)]
if len(hits) > 1:
    raise SystemExit("STOP: .env has more than one KIWI_API_PORT line. Ask the human which to keep.")
if hits:
    lines[hits[0]] = f"KIWI_API_PORT={port}"
else:
    lines.append(f"KIWI_API_PORT={port}")
env.write_text("\n".join(lines) + "\n")
print(f"KIWI_API_PORT={port} written to .env")
PY
```

Then re-run the §6.4 (b) report. **Expect:** `NOTE KIWI_API_PORT=<port> is set in .env`. From here on, read 8101 in §5.6 (a), §7.4 and §7.5 as that port. A non-default port is covered by `npm run test:scripts` only and has not been run against a live Kiwi demo, so say so in the report (§13).

- **If it fails:** setup stops with `Add OPEN_AI_TEST_KEY to the project .env before running demo:setup.` Ask the human to add the key.

Tell the human: `demo:setup` rewrites `.env`. It removes blank lines, drops any `VITE_KIWI_ORIGIN=` line, appends `VITE_KIWI_ORIGIN=http://localhost:3001` and sets mode 0600. Comments and other values, `KIWI_API_PORT` included, are kept. The AI key is also copied into `.local/kiwi/.env` for Kiwi. The teacher key is not copied anywhere (§7.3, item 3).

### 7.3 Install the demo (`demo:setup`)

```bash
npm run demo:setup
```

Setup runs its `git clone` and `git checkout` with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` itself (`scripts/local-kiwi/config.mjs`, `gitEnv`), so a missing GitHub access fails at once and never waits for a password prompt.

What it downloads and creates:

1. **Kiwi source.** It clones the private repositories `https://github.com/NYUSH-ML/kiwi.git` at `2fe8d2d331dc619a1e22fe2fa61df2758ba7b353` into `.local/kiwi`, and `https://github.com/NYUSH-ML/kiwi-ui.git` at `fbc29beab4c6063c07fcf273d89e7237fad850b7` into `.local/kiwi-ui`. A checkout that already exists is not cloned again. This is the first step, so a missing GitHub access stops setup before the Node download, the config files and Docker.
2. **Node runtime.** It downloads Node 24.21.0 from `https://nodejs.org/dist/v24.21.0/`, checks it against SHASUMS256 and unpacks it into `.local/runtime/`.
3. **Private config.**
   - `.local/infra.env` (database and MinIO passwords) is created once and reused on every later run.
   - `.local/kiwi/.env` and `.local/stack-manifest.json` are rewritten on every run. Existing secrets in `.local/kiwi/.env` are kept; the AI key and model are refreshed.
   - The teacher key is not copied anywhere; the API reads it from `.env`. Setups before 2026-10-23 wrote a copy to `.local/app-access.json`, which nothing reads. If that file exists, setup prints `.local/app-access.json is no longer used and may hold an old copy of the teacher key; you can delete it (rm .local/app-access.json).` Do not open, print or delete it; tell the human, who may delete it.
   - If `KIWI_TEACHER_KEY` is not set, setup prints `KIWI_TEACHER_KEY is not set: the standalone teacher workspace stays closed (Kiwi-linked courses are not affected).` That is expected when the human only wants Kiwi mode.
4. **Docker services.** It pulls `pgvector/pgvector:0.7.2-pg16`, `redis:7.2.5-alpine` and `minio/minio:RELEASE.2024-12-18T13-15-44Z`, then starts them with `docker compose … up -d --wait`.
5. **Kiwi backend.** It runs `npm ci` (cache in `.local/npm-cache`), applies the local backend patches and the Lab bridge controller, runs `prisma migrate deploy` and `nest build`.
6. **Demo seed.** It creates the demo teacher and student accounts, with random passwords in `.local/demo-credentials.json` (mode 0600). It creates the class `local-css-demo` and registers the `ics-r-lab` app with base URL `http://127.0.0.1:8100`, enabled for that class. It also uploads a demo PDF.
7. **Integration upgrade and UI.** It runs `upgrade-integration`, applies the UI patches, writes `.local/kiwi-ui/.env.local` and runs `npm ci` for the UI.

- **Duration:** not measured. It depends on the network and Docker image cache. Record the actual time for the report.
- **Expect:** the output includes these lines, in order:
  - `Local Kiwi configuration ready (<model>); credentials stay in .local/.`
  - `Local Kiwi backend dependencies, schema and build are ready.`
  - `Local teacher, student, class local-css-demo, course context and ics-r-lab app are ready.`
  - `CSS Lab course binding, role entry points and activity read indexes upgraded.`
  - `Setup complete. Run npm run demo:start to launch Kiwi and the CSS App.`

  Re-running setup is safe: it keeps passwords, secrets and data.
- **If it fails:**

  | Message | Action |
  | --- | --- |
  | `This demo bootstrap currently supports macOS arm64/x64.` | Unsupported platform. Stop. |
  | `Add OPEN_AI_TEST_KEY to the project .env…` | §7.2 |
  | `cannot access NYUSH-ML/kiwi — check GitHub access (sign in with gh auth login or add an SSH key, and make sure your account can open https://github.com/NYUSH-ML/kiwi), then run npm run demo:setup again.` (or `NYUSH-ML/kiwi-ui`), after git's own `fatal: could not read Username …` or `Repository not found` line | No access to a private Kiwi repository (git exit code 128). Stop and ask the human to authenticate and get `NYUSH-ML` access (§5.9), then re-run. |
  | `git clone of NYUSH-ML/<repo> failed (exit <n>).` | git failed for another reason (disk, network). Report the lines git printed above it, then re-run once. |
  | `Warning: .env sets <names> on more than one line; the first line of each is used.` | Not fatal. Ask the human which line to keep (§6.4 (b)), then re-run setup. |
  | `.local/app-access.json is no longer used …` | Information only (§7.3, item 3). Tell the human. |
  | `Docker demo services failed. Is Docker Desktop running?` or a compose error | §5.7. If a port conflict is shown, go to §5.6. |
  | `<name> is on a different commit…` | `.local/kiwi*` holds another checkout. Stop and ask; setup never discards it. |
  | `Kiwi upstream changed: review local patch…` / `Kiwi UI compatibility patch no longer matches…` | A patch anchor moved. Stop and ask; do not edit `.local/kiwi*` yourself. |
  | `Node checksum mismatch.` / download errors | Network problem. Re-run once, then ask. |

### 7.4 Start the demo (`demo:start`)

```bash
npm run demo:start
```

- **Expect:**
  - `kiwi-api: ready`, `kiwi-ui: ready`, `app-api: ready`, `app-ui: ready` (or `already running` for reused services);
  - `Two demonstration assignments and the student roster are ready in local-css-demo.`;
  - the URLs: Kiwi login `http://localhost:3001/login`, student app `http://localhost:3001/local-css-demo/app/ics-r-lab`, teacher app `http://localhost:3001/admin/app/ics-r-lab/class/local-css-demo`, and `Login accounts: .local/demo-credentials.json`.

  The services run detached and keep running after the terminal closes. Logs go to `.local/logs/<name>.log`, and pids go to `.local/services.json`. Each service gets up to 25 s to become ready.

  Then run the *make the data directory private* block from §6.7: the app API creates `data/kiwi-lab.sqlite3` here too.
- **If it fails:**
  - `<name> is not ready. Private log: .local/logs/<name>.log`: show only the last error lines with `tail -n 30 .local/logs/<name>.log | grep -iE 'error|fail|exception|did not start|warning' | head -20`. The log may contain secrets, so never print it whole.
    - For `app-api`, `Kiwi Lab API did not start: port <port> on 127.0.0.1 is already in use … the database was not opened.` means another process holds the API port. Nothing was migrated. Go back to §5.6; moving the API is described in §7.2.
    - `KIWI_API_PORT must be a port number, got "…"` (printed by `demo:start` itself) means the `KIWI_API_PORT` line in `.env`, or a shell value, is not 2–5 digits; an empty `KIWI_API_PORT=` line counts. Fix it as in §7.2. `demo:stop` still works with a broken value.
  - `Run npm run demo:setup first.`: go back to §7.3.
  - **"already running" is a trap:** an older app API already on the API port, or a Vite already on 8100, is reused, not restarted. §7.5 catches this.

### 7.5 Status checks

```bash
npm run demo:status
curl -s http://127.0.0.1:8101/api/health; echo        # or the KIWI_API_PORT of §7.2
curl -s http://localhost:3000/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print("kiwi-api", d.get("status"))'
python3 -c 'import json; d=json.load(open(".local/stack-manifest.json")); print("app", d["appSlug"], "class", d["classId"], "model", d["model"])'
```

- **Expect:**
  - four lines `<name>: ready (<url>)`; the `app-api` URL shows the API port in use;
  - health includes `"version": "0.6.0"`;
  - `kiwi-api ok`;
  - `app ics-r-lab class local-css-demo model <model>`. `stack-manifest.json` contains no secrets.
- **If it fails:**
  - If `version` is missing, a pre-0.6.0 API is still serving. Ask the human (Q7), stop that process, run `npm run demo:start` again and re-check.
  - If a service is offline, see §7.4.

### 7.6 Existing demo: upgrade or reinstall the bridge

Use this when this checkout already had a demo (§5.6 (c) shows containers marked `THIS CHECKOUT`, `.local/kiwi*` exists, maybe a v0.5.1 database). It needs the human's yes to Q7. Stop first, then back up, so that no write lands between the backup and the stop.

1. **Stop the demo.**

   ```bash
   npm run demo:stop
   ```

   It stops only the processes that `demo:start` recorded, after checking that each pid still belongs to this repo, then runs `docker compose stop` on `css-kiwi-demo`; volumes are kept. **Expect:** lines like `app-api: stopped`, then `Demo stopped. Database volumes and local App data are retained.`
2. **Make sure no API still serves the database.** Re-run §5.6 (b). An API that `demo:stop` did not record (for example `npm run dev:all` or `python3 server/app.py` started by hand) shows up here, and its port stays busy. Ask the human to stop it, or to allow you to stop that one pid.
3. **Back up the app database** (§8.1–8.2).
4. **Teacher key.** Run §6.4. v0.6.0 has no built-in default teacher key. A key shorter than 32 characters (such as the 15-character `kiwi-local-demo`, the old public default) keeps working but should be replaced if the human agrees (Q6).
5. **Reinstall the bridge and start.**

   ```bash
   node scripts/local-kiwi/reinstall-bridge.mjs --dry-run
   node scripts/local-kiwi/reinstall-bridge.mjs
   npm run demo:start
   ```

   - `reinstall-bridge.mjs` re-applies the backend patches and the bridge controller and runs `nest build`. It starts only the demo database container and runs `upgrade-integration`.
   - `demo:start` re-applies the UI patches. On the first v0.6.0 start, the app API migrates `data/kiwi-lab.sqlite3`.

- **Expect:**
  - `reinstall-bridge.mjs`: the dry run prints `Would copy the bridge controller…`; the real run prints `Bridge reinstalled. Next: npm run demo:start…`.
  - Then §7.5 passes, and §8.4 shows one `kiwi-lab.pre-0.6.0-001-columns-<timestamp>.sqlite3` if the database was v0.5.1.
- **If it fails:**
  - If `demo:stop` prints `<name>: no owned process remains` but the port is still busy (§5.6), see step 2.
  - `Kiwi is still running on port 3000…`: run `demo:stop` first.
  - If the API exits with `Could not back up the database…`, fix permissions or space on `data/backups`. No data was changed.

### 7.7 What the human must do: sign in

Tell the human:

> 1. Open `.local/demo-credentials.json` yourself (do not share or screen-record it). It has `teacher.password` and `student.password`.
> 2. Sign in at `http://localhost:3001/login` as `demo.teacher@css-kiwi.local`, then open `http://localhost:3001/admin/app/ics-r-lab/class/local-css-demo` (or **Open CSS Lab · teaching & analytics** on the course card). No teacher key is needed inside Kiwi.
> 3. In a different browser or profile, sign in as `demo.student@css-kiwi.local` and open `http://localhost:3001/local-css-demo/app/ics-r-lab` (or **Open CSS Lab**).
> 4. Optional walk-through, from `docs/handoff/v0.6.0-open-questions.md` § E, item 3. Check that:
>    - CSS Lab opens from the course card;
>    - a sync does not reset the activity explorer;
>    - research consent is synced from Kiwi;
>    - Kiwi's native thumbs appear on the thread;
>    - Kiwi's side panel is hidden on a homework with Ask Kiwi Off, and returns afterwards;
>    - Staff & roles lists the demo teacher, and a researcher override works (D3);
>    - the global teacher link returns to the Lab after `/login`;
>    - a viewer's or researcher's per-type export contains Kiwi-verified rows only.

You (the agent) do not open that file, do not type the passwords and do not drive the Kiwi sign-in.

### 7.8 Linking a course in a different local Kiwi (non-demo)

Only on the human's explicit request. `scripts/register-kiwi-app.mjs` writes directly to that Kiwi's database (`DATABASE_URL`, taken from `<kiwi repo>/.env` by default) and has no localhost guard. It was not exercised in the v0.6.0 review.

```bash
node scripts/register-kiwi-app.mjs --kiwi-repo <path-to-kiwi> --list-classes
node scripts/register-kiwi-app.mjs --kiwi-repo <path-to-kiwi> --class <classId-or-name> --app-url http://127.0.0.1:8100
```

- **Expect:** a class list, then a confirmation that prints `http://localhost:3001/<classId>/app/ics-r-lab`.
- **If it fails:** report the error message. Do not edit the Kiwi database by hand.
- **After it succeeds:** set `KIWI_API_ORIGIN` and `VITE_KIWI_ORIGIN` in `.env` (one line each) to that Kiwi's API and UI origins, then restart the app.

## 8. Importing existing data

Do this before the first v0.6.0 start on any database that already exists. In the standalone flow, do §8.1–8.3 after §6.5 and before §6.6, then continue with §6.6–6.8, run §8.4, and only then the smoke test (§6.9). In Kiwi mode, do §8.1–8.3 before §7.4 (`demo:setup` does not touch the app database); for an existing demo, §7.6 says where they go.

**Empty run first, import afterwards** (for example when the human wants to see the app on an empty database before importing): run §6 through §6.9 on the empty database, then do §8.1 and §8.2 (your own API on the empty `data/kiwi-lab.sqlite3` is expected in §8.1; it does not serve `<DB>`), then §8.3 **Copy it in**, whose step 1 stops this checkout's API and UI and moves the empty database aside. Then re-run §5.6 (b), start again with §6.6–6.8 (with the §6.7 file-mode block), run §8.4, and only then §6.9. The `agent-smoke-test` entry from the empty run stays in the moved-aside file; on the imported database (c) and (d) of §6.9 need the human's yes.

### 8.1 Locate the file and make sure no API is serving it

- If Q5 names a file elsewhere, `<DB>` is its absolute path.
- Otherwise `<DB>` is `data/kiwi-lab.sqlite3`, or the `KIWI_DB_PATH` from §6.4 (b).

```bash
ls -la <DB> <DB>-wal <DB>-shm 2>/dev/null
```

Then re-run §5.6 (b).

- **Expect:** the file is listed, and no `API … db=` line names `<DB>`.
- **Do not rely on `lsof <DB>`.** It prints nothing even while an API is serving the file, because the API opens and closes a connection for each request (§5.6 (b)).
- **If it fails:**
  - If an API serves `<DB>`, follow §5.6 › *An API serves the database you will use* (Q7). Never migrate a file that another API is serving.
  - If the human chose to leave that API running, continue only with **Copy it in** (§8.3) into a separate clone, and run §8.2 with `SOURCE_IDLE=0`.

### 8.2 Back up, verify and record row counts

Write `SOURCE_IDLE=1` only when §8.1 showed that no API serves `<DB>`; otherwise write `SOURCE_IDLE=0`.

```bash
mkdir -p data/backups .local/standalone && chmod 700 data data/backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SOURCE_IDLE=<1|0> python3 - <DB> "data/backups/kiwi-lab.manual-pre-0.6.0-$STAMP.sqlite3" .local/standalone/counts-before.json <<'PY'
import json, os, sqlite3, sys
from pathlib import Path
src_path, dst_path, counts_path = sys.argv[1], sys.argv[2], sys.argv[3]
if Path(dst_path).exists():
    raise SystemExit(f"STOP: {dst_path} already exists")
wal = Path(src_path + "-wal")
# WHY: immutable=1 reads without creating -wal/-shm next to the source. It is safe only when nothing writes the file
# (SOURCE_IDLE=1) and no -wal holds committed changes; otherwise open read-only, which may leave -wal/-shm behind.
idle = os.environ.get("SOURCE_IDLE") == "1" and not (wal.exists() and wal.stat().st_size > 0)
uri = f"file:{src_path}?immutable=1" if idle else f"file:{src_path}?mode=ro"
src = sqlite3.connect(uri, uri=True)
dst = sqlite3.connect(dst_path)
src.backup(dst)                                 # online backup: includes committed changes still in <DB>-wal
src.close()
dst.execute("PRAGMA journal_mode=DELETE")       # one self-contained file; the API switches the live file back to WAL
dst.close()
os.chmod(dst_path, 0o600)                       # student data: owner-only, like the API's own backups
con = sqlite3.connect(dst_path)
print("source opened with", uri.split("?", 1)[1])
print("backup:", dst_path, "integrity:", con.execute("PRAGMA integrity_check").fetchone()[0])
names = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
counts = {n: con.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0] for n in names}
con.close()
with open(counts_path, "w") as fh:
    json.dump(counts, fh, indent=1, sort_keys=True)
core = ("courses", "assignments", "submissions", "events", "chat_turns", "roster")
print(len(counts), "tables;", {k: counts[k] for k in core if k in counts})
PY
ls -l data/backups/
```

The counts come from the backup, which is exactly what will be migrated.

- **Expect:**
  - `source opened with immutable=1` (or `mode=ro` when an API may write, or the `-wal` is not empty);
  - `backup: data/backups/kiwi-lab.manual-pre-0.6.0-<stamp>.sqlite3 integrity: ok`;
  - the file listed with mode `-rw-------` and a non-zero size;
  - a table count line:
    - **13 tables** for a v0.5.1 database (it has no `schema_migrations`);
    - **14 tables** for a restored automatic `pre-0.6.0-001-columns` backup (the API creates an empty `schema_migrations` before it takes that backup);
    - **46 tables** for a database that is already v0.6.0.
- **Side files.** With `mode=ro`, SQLite may leave `-wal`/`-shm` files next to a WAL-mode source. The main file is not modified, and the side files are harmless; tell the human if they appear in a directory of theirs.
- **If it fails:**
  - If integrity is not `ok`, or the backup is missing or empty, **stop**. Do not start the app on this database; report to the human.
  - On `STOP: … already exists`, wait a second and re-run (the stamp changes).
  - If the script fails with `unable to open database file`, check the path and that the directory is readable (§8.1). Do not retry without `immutable=1` or `mode=ro`.

### 8.3 Point the app at the database

- **Default location:** if the database is this checkout's `data/kiwi-lab.sqlite3`, there is nothing to do.
- **A file from another checkout or machine:** do what the human chose in Q5.
  - **Copy it in (preferred).** Copy the verified backup from §8.2, never the raw `<DB>`: a `<DB>-wal` file next to it can hold committed changes that a plain `cp` would miss. From now on, `<DB>` in §8.4 means `data/kiwi-lab.sqlite3`.
    1. If `data/kiwi-lab.sqlite3` already exists, stop this checkout's API and UI (§9.1 stops both) and move the file aside first. Do that only if **this session** created it (an earlier §6.6–6.7 start on an empty database). Otherwise it is someone's data: stop and ask.

       ```bash
       mkdir -p data/replaced && chmod 700 data/replaced
       ASIDE=$(date -u +%Y%m%dT%H%M%SZ)   # names the moved-aside files only; it is not the §8.2 backup stamp
       for f in data/kiwi-lab.sqlite3 data/kiwi-lab.sqlite3-wal data/kiwi-lab.sqlite3-shm; do
         [ -e "$f" ] && mv -n "$f" "data/replaced/$(basename "$f" | sed "s/^kiwi-lab/kiwi-lab.$ASIDE/")" && echo "moved aside: $f"
       done
       ls -l data/replaced/
       ```

    2. Copy the backup in. `<stamp>` is the one in the backup name that §8.2 printed (`backup: data/backups/kiwi-lab.manual-pre-0.6.0-<stamp>.sqlite3`), not the time of step 1; `ls data/backups/` lists it.

       ```bash
       cp -n data/backups/kiwi-lab.manual-pre-0.6.0-<stamp>.sqlite3 data/kiwi-lab.sqlite3 && chmod 600 data/kiwi-lab.sqlite3
       ```

  - **Use it in place.** Set exactly one line `KIWI_DB_PATH=<absolute path>` in `.env`, and make sure no other `KIWI_DB_PATH=` line exists. The API then migrates and writes that file, and writes its migration backup next to it, in `<dir>/backups/`, which must be writable. Every other API that serves that file must be stopped (§8.1).
- **`.env` on a new machine.**
  - The teacher key lives only in `.env`, so it does not have to match the old machine's; §6.4 can generate a new one.
  - Staff keys are stored (hashed) in the database. They keep working as long as any `KIWI_TEACHER_KEY` is set.
  - The AI key is entered by the human (§6.5).
  - Server secrets for demo sessions and research ids live inside the database, so research ids stay stable. Demo links signed on the old machine stay valid until they expire.

```bash
grep -c '^KIWI_DB_PATH=' .env || true
ls -l data/kiwi-lab.sqlite3 2>/dev/null
```

- **Expect:** `0` (default path) or `1` (explicit path). The target file is listed.
- **If it fails:** if there is more than one `KIWI_DB_PATH=` line, ask the human which to keep.

### 8.4 First start (migration) and verification

Start with §6.6 and §6.7 (standalone) or §7.4 (Kiwi mode). Run this check right after the start, before the smoke test (§6.9), which adds a roster row. Replace `data/` with the database's own directory if you use `KIWI_DB_PATH`, and `<DB>` with the path in use.

```bash
ls -l data/backups/ | grep -E 'pre-0\.6\.0-001-columns' || echo "no automatic pre-0.6.0 backup"
python3 - <DB> .local/standalone/counts-before.json .local/standalone/counts-after.json <<'PY'
import json, sqlite3, sys
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
n = con.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0]
print("schema_migrations:", n, "integrity:", con.execute("PRAGMA integrity_check").fetchone()[0])
names = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
after = {t: con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in names}
con.close()
with open(sys.argv[3], "w") as fh:
    json.dump(after, fh, indent=1, sort_keys=True)
with open(sys.argv[2]) as fh:
    before = json.load(fh)
core = ["assignments", "chat_turns", "courses", "events", "generation_policies", "kiwi_links", "kiwi_materials",
        "roster", "submission_requests", "submissions"]
dropped = [f"{t}: {before[t]} -> {after.get(t)}" for t in core if t in before and after.get(t, -1) < before[t]]
for t in sorted(before):
    if after.get(t) != before[t]:
        print(f"changed {t}: {before[t]} -> {after.get(t)}")
print(f"new tables: {len(set(after) - set(before))}; tables now: {len(after)}")
print("FAIL: rows dropped in " + "; ".join(dropped) if dropped else "PASS: no core table lost rows")
PY
```

The pass criterion is the last line, `PASS: no core table lost rows`, together with `integrity: ok`. The other lines describe what the migration did.

- **Expect:**
  - **From v0.5.1** (13 tables in §8.2):
    - exactly one `kiwi-lab.pre-0.6.0-001-columns-<UTC yyyymmddTHHMMSS>.sqlite3` (mode 0600, in a 0700 directory);
    - `schema_migrations: 13 integrity: ok`;
    - `changed` lines for derived or backfilled tables are normal. On 2026-10-23, two real v0.5.1 files gave `changed learning_sessions: 75 -> 95` (re-indexed; 61 -> 81 on the other), `changed roster: 2 -> 4` (students seen in activity are added to the roster, so the new count is never lower) and `changed telemetry_meta: 2 -> 4`;
    - `new tables: 33; tables now: 46`;
    - `PASS: no core table lost rows`.
  - **From a restored `pre-0.6.0-001-columns` backup** (14 tables in §8.2): the same, plus `changed schema_migrations: 0 -> 13`, and `new tables: 32; tables now: 46`.
  - **Already v0.6.0:** no new backup, `schema_migrations: 13`, `new tables: 0; tables now: 46`, PASS.
  - In Kiwi mode, `demo:start` also seeds two demonstration assignments and the demo roster through the app API, so more `changed` lines (more rows) are normal there.
  - On a Kiwi-linked database, the first Kiwi sync may add a `…pre-native-projection-v3-<ts>.sqlite3` backup later.
- **If it fails:**
  - On `FAIL: rows dropped`, stop the app (§9) and roll back (§11). Report the table names to the human.
  - If there is no automatic backup and the database had data, report it. The manual backup from §8.2 is the fallback.
  - If health in §6.8 shows no `version`, an old API served the request (§7.5).

## 9. Stopping and cleanup

### 9.1 Standalone

```bash
for name in ui api; do
  pid=$(cat ".local/standalone/$name.pid" 2>/dev/null || true)
  [ -n "$pid" ] || { echo "$name: no pid file"; continue; }
  cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$cmd" in
    *server/app.py*|*vite/bin/vite.js*) kill "$pid" && echo "$name: stopped (pid $pid)";;
    "") echo "$name: not running";;
    *) echo "$name: pid $pid now belongs to another program; not touched";;
  esac
done
rm -f .local/standalone/ui.pid .local/standalone/api.pid
. .local/standalone/ports.env
for p in "$API_PORT" "$UI_PORT"; do   # a stopping process can hold its port for a moment: wait up to 10 s
  for i in 1 2 3 4 5 6 7 8 9 10; do lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
  holder=$(lsof -nP -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null | head -1)
  [ -n "$holder" ] && echo "$p still busy after 10 s (pid $holder)" || echo "$p free"
done
```

- **Expect:**
  - `ui: stopped`, `api: stopped` (or `not running`), then both ports `free`;
  - `-wal`/`-shm` files next to the database are normal (they can remain after a stop, for example after the read-only checks in §8). They hold committed data: never delete them, and never copy the main file without them; use §8.2 to copy a database.
- **If it fails:** on `still busy after 10 s (pid N)`, compare N with the pids the block printed as `stopped (pid …)`.
  - The same pid: that process ignores SIGTERM. Ask the human before using `kill -9`.
  - Another pid: another process holds the port. Do not kill it; report it.

### 9.2 Kiwi mode

```bash
npm run demo:stop
```

- **Expect:**
  - `<name>: stopped` for each managed service;
  - `Demo stopped. Database volumes and local App data are retained.`
- **Note:** this also runs `docker compose stop` on the shared project `css-kiwi-demo`, whichever checkout started it. Run it only in the checkout that owns the project (§5.6 (c)).
- **If it fails:**
  - On `<name>: no owned process remains` while the port is busy, the process was not started by `demo:start`. Report it.
  - If the Docker stop fails, Docker Desktop is not running; nothing else is needed.

### 9.3 Cleanup

Run this only after §9.1 or §9.2, and only with the human's agreement. Nothing is deleted: optional files move into one folder, which the human may delete later (`rm -rf` is not allowed for you, hard rule 8).

```bash
OLD=".local/standalone/old-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$OLD"
for f in .local/standalone/api.log .local/standalone/ui.log .local/standalone/counts-before.json .local/standalone/counts-after.json .local/verify-r-engine.mjs; do
  [ -e "$f" ] && mv -n "$f" "$OLD/" && echo "moved $f"
done
for d in dist coverage; do [ -d "$d" ] && mv -n "$d" "$OLD/$d" && echo "moved $d/"; done
ls -la "$OLD"
```

Files this runbook creates:

| Path | Created by | Keep? |
| --- | --- | --- |
| `.env` | §6.4 | keep |
| `node_modules/`, `public/webr/` | §6.3 | keep |
| `.local/standalone/ports.env` | §6.2 | keep while the app may be restarted |
| `.local/standalone/api.pid`, `ui.pid` | §6.6 | removed by §9.1 |
| `.local/standalone/api.log`, `ui.log` | §6.6 | optional (moved by the block above) |
| `.local/standalone/counts-before.json`, `counts-after.json` | §8.2, §8.4 | optional; table names and row counts only |
| `data/kiwi-lab.sqlite3` (+ `-wal`/`-shm`) | first start | keep |
| `data/backups/kiwi-lab.manual-pre-0.6.0-*.sqlite3`, `data/backups/kiwi-lab.pre-0.6.0-001-columns-*.sqlite3` | §8.2, first v0.6.0 start | keep; student data, the human decides when to delete |
| `data/replaced/` | §8.3, §11 | keep; the human decides |
| `dist/` | V4 (§12) | optional |
| `coverage/` | `npm run coverage` | optional |
| `.local/verify-r-engine.mjs` | V5 (§12) | optional |
| `.local/v0.6-integration-check.json` | V7 (§12) | keep (evidence for the report) |
| roster entry `agent-smoke-test` | §6.9 | the human may set it to *Dropped* |
| Kiwi mode: `.local/kiwi*`, `.local/runtime/`, `.local/npm-cache/`, `.local/infra.env`, `.local/demo-credentials.json`, `.local/stack-manifest.json`, `.local/logs/`, `.local/services.json`, the Docker volumes | §7 | keep |
| `.local/app-access.json` | not created any more; only an older setup left it | the human may delete it (it may hold an old teacher key); you do not open or delete it |

- **Full removal of the demo:** only on an explicit request, and done by the human (it destroys the Kiwi demo data):

  ```bash
  docker compose --env-file .local/infra.env -f scripts/local-kiwi/compose.yaml down -v
  ```

## 10. Troubleshooting decision table

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `503 teacher_key_not_configured` / gate says "Set KIWI_TEACHER_KEY on the server…" | No key, an empty first `KIWI_TEACHER_KEY=` line, or the API started before the key was written | §6.4, then restart the API (§9.1, then §6.6) |
| `401 Teacher key is incorrect` | Wrong key, or a shell `KIWI_TEACHER_KEY` overrides `.env` | §5.5, then §6.4 |
| `429 rate_limited` on teacher verify | 10 wrong keys from one address within 60 s; every key, the correct one included, is refused until a minute has passed since the oldest failure | Wait 60 s |
| `401 Open this course's CSS Lab from Kiwi…` on `local-r-class` | The class became Kiwi-linked (`KIWI_CLASS_IDS`, or a Kiwi token was used) | Stop and ask. Un-linking needs a manual database change, which this runbook does not do. |
| `Kiwi Lab API did not start: port … is already in use … the database was not opened.` in `api.log` | Port taken; the API exited before opening the database, so nothing was migrated | §5.6, pick new ports, §6.2 |
| `Warning: .env sets <names> on more than one line; the first line of each is used.` | A name repeats in `.env`; the API and the demo scripts use the first line | Ask the human which line to keep (§6.4 (b)), then restart |
| `ValueError: invalid literal for int()` in `api.log` | `KIWI_API_PORT` is not a number (an empty `KIWI_API_PORT=` line counts) | Fix `ports.env`, the shell or `.env` (§6.4 (b)) |
| `KIWI_API_PORT must be a port number` in `ui.log`, or from a `demo:` command | Same, seen by Vite or by `scripts/local-kiwi/config.mjs` | Same; in Kiwi mode see §7.2 |
| Vite serves on another port | Started without `--strictPort` | Use the §6.6 command |
| UI loads, every `/api` call answers HTTP 500 with an empty body; `ui.log` shows `http proxy error … ECONNREFUSED` | API down, or the proxy points at the wrong port | §6.7. Pass `KIWI_API_PORT` in the shell to both processes. |
| R never starts; `/webr/R.wasm` returns 404 | `public/webr` missing | `npm run prepare:webr`, then restart the UI |
| `Kiwi Lab API did not start: Could not back up the database…` | Backup directory not writable, or disk full | Fix permissions or space. No data was changed. |
| Health has no `version` key | An older (v0.5.1) API answered | Find the process (§5.6 (b)), ask the human, stop it, restart |
| An older API keeps serving the database on a port you did not choose | Started by the human before the upgrade | §5.6 › *An API serves the database you will use* |
| `demo:start` prints `already running` but the version is old | `demo:start` reuses any healthy API or Vite | Same as above |
| `<name> is not ready. Private log: …` | That service failed to start within 25 s (for `app-api`: often its port is taken) | Filtered `tail` of that log (§7.4); §5.6, §7.2 |
| `cannot access NYUSH-ML/kiwi — check GitHub access …` during `demo:setup`, or a manual clone waits for a username | Private repository, no access | The human authenticates (§5.9); run your own git commands with `GIT_TERMINAL_PROMPT=0` (setup already does) |
| `css-kiwi-demo` containers marked `OTHER CHECKOUT` | Another checkout owns the Kiwi demo | Stop and ask (§5.6 (c)) |
| `Docker demo services failed…` | Docker Desktop not running | §5.7 |
| `Run npm run demo:setup first.` | The demo is not installed | §7.3 |
| `Add OPEN_AI_TEST_KEY to the project .env…` | No AI key | §6.5 |
| `… is on a different commit` / `Kiwi upstream changed…` | Drift in `.local/kiwi*` | Stop and ask |
| `Kiwi requires Node 24.15 or later…` | A demo script ran with the system Node | Use the npm scripts only |
| Ask Kiwi answers "Local guidance" | No AI key; this is by design | Add the key (§6.5), restart the API |
| `503 ai_busy` / `429 Too many AI requests…` | Capacity or rate limits | Wait, or raise `KIWI_AI_CONCURRENCY` / `KIWI_AI_QUEUE_WAIT_S` / `KIWI_AI_PER_IP_PER_MINUTE` (with the human's agreement) |
| `npm ci` fails on the lockfile | `package-lock.json` and `package.json` disagree | Report it. Do not run `npm install` without agreement. |
| `npm ci` prints `… vulnerabilities … npm audit fix` | Known dev-only advisories (§6.3) | Nothing. Do not run `npm audit fix`. |

## 11. Rollback

Go back to the state before this deployment:

1. **Stop the app** (§9.1 or §9.2).
2. **Restore the database.** This is only needed when an existing database was migrated. Move the current file aside, then copy the backup back:

   ```bash
   mkdir -p data/replaced && chmod 700 data/replaced
   STAMP=$(date -u +%Y%m%dT%H%M%SZ)
   for f in data/kiwi-lab.sqlite3 data/kiwi-lab.sqlite3-wal data/kiwi-lab.sqlite3-shm; do
     [ -e "$f" ] && mv -n "$f" "data/replaced/$(basename "$f" | sed "s/^kiwi-lab/kiwi-lab.$STAMP/")" && echo "moved aside: $f"
   done
   cp -n data/backups/kiwi-lab.pre-0.6.0-001-columns-<timestamp>.sqlite3 data/kiwi-lab.sqlite3 && chmod 600 data/kiwi-lab.sqlite3
   python3 -c 'import sqlite3; print(sqlite3.connect("data/kiwi-lab.sqlite3").execute("PRAGMA integrity_check").fetchone()[0])'
   ```

   Use the automatic `pre-0.6.0-001-columns` backup, or the manual one from §8.2. Use the database's own directory if you set `KIWI_DB_PATH`. (`sqlite3 data/kiwi-lab.sqlite3 "PRAGMA integrity_check;"` gives the same answer where the CLI is installed.)
   - **Expect:** `ok`.
   - **If it fails:** do not start anything. Report to the human; the moved-aside files are still in `data/replaced/`.
3. **Return to the previous code**, only if the human asks. v0.5.1 is on branch `codex/css-lab-v0.5.1` (commit `04a7aeb`). After the human approves the branch switch, run `git checkout codex/css-lab-v0.5.1 && npm ci`. v0.5.1 ran on a restored `pre-0.6.0-001-columns` backup in testing. v0.5.1 on a migrated v0.6.0 file (ignoring the new tables) is described in the earlier docs but untested.
4. **Kiwi demo.** Restart it with `npm run demo:start`. The bridge files in `.local/kiwi` stay at the v0.6.0 state. The docs describe that state as compatible with the old app; this is untested.
5. **`.env`.** The generated teacher key, and a `KIWI_API_PORT` line written in §7.2, stay in `.env`. If `demo:setup` ran, it removed blank lines and set `VITE_KIWI_ORIGIN`. Tell the human; do not try to restore the old file from memory.

## 12. Verification

Run these after the deployment works. The suites use temporary databases and clear the AI keys, so they do not touch `data/`.

| # | Command | Expected | Needed? |
| --- | --- | --- | --- |
| V1 | `npm run test:server` | `Ran 529 tests` … `OK (skipped=2)` on a fresh clone (about 4 minutes; 234 s on 2026-10-23). Both skips are migration-snapshot tests that need `.local/*.sqlite3` snapshots or `KIWI_SNAPSHOT_DBS`; a checkout that has snapshots shows `skipped=1` or `0`. | recommended |
| V2 | `npm test` | `Test Files  51 passed (51)`, `Tests  1301 passed (1301)` (a few seconds) | recommended |
| V3 | `npx tsc --noEmit -p tsconfig.json` | no output, exit 0 | recommended |
| V4 | `npm run build` | `✓ built in …`; a chunk-size warning is normal. Writes `dist/`. | optional |
| V5 | `node scripts/verify-r-capture.mjs` | `Real R capture passed: …` (verified on a fresh clone, 2026-10-23). Writes `.local/verify-r-engine.mjs`. | optional |
| V6 | `npm run test:bridge` (Kiwi mode) | `PASS …` lines for the UI bridge tests and the controller spec; without `.local/kiwi*` it prints `Skipped bridge tests…` and exits 0 | Kiwi mode: recommended |
| V7 | `node scripts/local-kiwi/verify-integration.mjs` (Kiwi mode, ask first: it writes one native sync and one rejected event to the app database) | prints `{"passed": N, …, "repeatedSyncStable": true}` and writes `.local/v0.6-integration-check.json` | Kiwi mode: optional, with consent |
| V8 | Browser check by the human: teacher sign-in, a student opens R workspace and runs `mean(c(60, 75, 90))` → `[1] 75` | as described | recommended |
| V9 | `npm run test:scripts` | `# tests 7`, `# pass 7`, `# fail 0` (under a second). Tests the demo script helpers in temporary directories; it never reads this checkout's `.env` or `.local/`. | recommended |

The expected numbers were recorded on 2026-10-23 on the working tree that became commit `28092f6` (the known-minors fixes on top of `e8d819e`), and a fresh clone of `28092f6` reproduced V1–V5 and V9 the same day. Counts can change with later commits. Report the numbers you actually see. A failing suite is a finding to report; do not edit tests or code to make it pass.

## 13. Report to give the human at the end

Fill in every field. Write "not run" or "skipped (reason)" where that applies.

```markdown
## CSS Kiwi Lab 0.6.0 deployment report

- Mode: standalone | Kiwi-linked
- Repo: <absolute path> · branch <branch> · commit <short sha> · package version <0.6.0>
- Platform: <uname -s -m> · Node <v> · npm <v> · Python <v> (<path>) · SQLite <v> · Docker <v or n/a>

### What ran
| Step | Result | Notes |
| --- | --- | --- |
| Preflight (§5) | pass / issues | <ports, running APIs and their databases, Docker project owner, env overrides, repository access, disk> |
| Install (§6.3) | pass / fail | <duration> |
| .env + teacher key (§6.4) | generated / kept / short key kept | value not shown |
| AI key (§6.5) | set by human / not set | |
| Data import (§8) | none / copied in / in place | backup: <path>; tables before/after; counts: PASS/FAIL |
| demo:setup / demo:start (§7) | pass / fail / n.a. | <duration> |
| Health (§6.8 / §7.5) | version 0.6.0, aiAvailable <bool> | |
| Smoke test (§6.9) | pass / fail | test student agent-smoke-test created: yes/no |
| Verification (§12) | V1 … V9 results | |
| Cleanup (§9.3) | not done / moved to <folder> | |

### How to use it
- Reach: this computer only (127.0.0.1); students on other devices cannot connect.
- Workspace selection: http://127.0.0.1:<UI_PORT>/entry
- Teacher (standalone): http://127.0.0.1:<UI_PORT>/teacher/home. The key is the KIWI_TEACHER_KEY line in <repo>/.env (run `grep '^KIWI_TEACHER_KEY=' .env` yourself).
- Student (standalone): http://127.0.0.1:<UI_PORT>/student/assignments
- Kiwi (if Kiwi-linked): http://localhost:3001/login. The accounts and passwords are in <repo>/.local/demo-credentials.json (open it yourself).
- Logs: .local/standalone/{api,ui}.log | .local/logs/*.log
- Stop: <the §9 command>. Start again: <the §6.6 block or npm run demo:start>

### Not done / needs you
- <for example: Kiwi sign-in and the walk-through (§7.7); verify-integration not run (needs consent); weak teacher key kept (Q6 = no); an older API left running on the original database (Q7 = no); app API moved off 8101 in Kiwi mode (§7.2, not run against a live Kiwi before); an old `.local/app-access.json` the human may delete>

### Problems and deviations
- <every failure, workaround and difference between docs and code you noticed>
```
