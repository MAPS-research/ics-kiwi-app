#!/usr/bin/env node
/**
 * Register Kiwi R Lab with a LOCAL Kiwi instance and turn it on for a class.
 *
 * Three things have to line up before an app shows up as a class tab:
 *   1. KiwiAppWhitelist  — an admin-created entry with a bcrypt'd secret
 *   2. KiwiApp + KiwiAppUI — the app self-registers against that secret
 *   3. ClassKiwiApp      — an instructor enables it for one class
 *
 * Steps 1 and 3 are admin/instructor actions behind auth, so for local testing
 * this writes them straight to Kiwi's database. Step 2 goes through the real
 * public POST /api/kiwi-apps/register when the backend is up, and falls back to
 * a direct write when it isn't — so the flow works whether or not you have
 * `npm run start:dev` running in the kiwi repo.
 *
 * Prisma and bcryptjs are borrowed from the kiwi repo's node_modules rather
 * than duplicated here; point --kiwi-repo at it if it isn't ../kiwi.
 *
 * Usage:
 *   node scripts/register-kiwi-app.mjs --list-classes
 *   node scripts/register-kiwi-app.mjs --class <classId|name substring>
 *   node scripts/register-kiwi-app.mjs --class CS101 --app-url http://127.0.0.1:8100
 *   node scripts/register-kiwi-app.mjs --unregister
 */

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)

const KIWI_REPO = path.resolve(flag("kiwi-repo", path.join(process.cwd(), "..", "kiwi")))
const APP_URL = (flag("app-url", process.env.KIWI_R_LAB_BASE_URL || "http://127.0.0.1:8100")).replace(/\/$/, "")
const KIWI_API = (flag("kiwi-api", process.env.KIWI_URL || "http://localhost:3000")).replace(/\/$/, "")
const APP_SLUG = flag("slug", "ics-r-lab")
const CLASS_ARG = flag("class")
const LIST_CLASSES = has("list-classes")
const UNREGISTER = has("unregister")

// Any 32+ char string works; it only has to match between the whitelist row and
// the register call, both of which this script owns.
const REGISTRATION_SECRET =
  flag("secret", process.env.KIWI_REGISTRATION_SECRET) ||
  "ics-r-lab-local-dev-registration-secret-32+"

const log = (...a) => console.log(...a)
const die = (msg) => {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

// ── app definition ───────────────────────────────────────────────────────────
const APP = {
  slug: APP_SLUG,
  name: "Kiwi R Lab",
  description:
    "Adaptive R practice with browser-side execution and instructor learning history.",
  baseUrl: APP_URL,
  category: "plugin",
  version: "1.0.0",
  appType: "frontend_only",
  // LLM requests and scoped data ops use the Kiwi host bridge.
  capabilities: ["auth", "frontend-actions"],
  uis: [
    {
      uiSlug: "student",
      uiName: "Kiwi R Lab",
      uiUrl: `${APP_URL}/`,
      placement: "class-tab",
      allowedRoles: ["student", "ta", "instructor", "admin"],
      tabOrder: 0,
    },
  ],
  // Course material access; optional approved student context prompt.
  maxScopes: ["class:materials:chunks:read", ...(flag("context-prompt") ? ["context:student_learning:read", `llm:prompt:${flag("context-prompt")}`] : [])],
}

// ── borrow deps from the kiwi repo ───────────────────────────────────────────
async function loadKiwiDeps() {
  const prismaPath = path.join(KIWI_REPO, "node_modules", "@prisma", "client", "index.js")
  const bcryptPath = path.join(KIWI_REPO, "node_modules", "bcryptjs", "index.js")
  const envPath = path.join(KIWI_REPO, ".env")

  for (const [what, p] of [
    ["@prisma/client", prismaPath],
    ["bcryptjs", bcryptPath],
    [".env", envPath],
  ]) {
    if (!fs.existsSync(p)) {
      die(
        `Cannot find ${what} at ${p}.\n` +
          `  Point --kiwi-repo at your kiwi checkout, and make sure you have run\n` +
          `  \`npm install && npx prisma generate\` there.`
      )
    }
  }

  // Prisma reads DATABASE_URL from the environment; this script runs from a
  // different directory, so lift it out of the kiwi repo's .env.
  if (!process.env.DATABASE_URL) {
    const line = fs
      .readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("DATABASE_URL="))
    if (!line) die(`No DATABASE_URL in ${envPath}`)
    process.env.DATABASE_URL = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")
  }

  const { PrismaClient } = await import(pathToFileURL(prismaPath).href)
  const bcrypt = (await import(pathToFileURL(bcryptPath).href)).default
  return { prisma: new PrismaClient(), bcrypt }
}

const className = (c) => {
  const meta = c.classMetadata || {}
  return meta.className || meta.name || "(unnamed class)"
}

async function pickClass(prisma) {
  const classes = await prisma.class.findMany({
    select: { id: true, classMetadata: true, createdDate: true },
    orderBy: { createdDate: "desc" },
  })
  if (classes.length === 0) {
    die("No classes exist in this Kiwi database yet. Create one in the Kiwi admin UI first.")
  }
  if (!CLASS_ARG) {
    if (classes.length === 1) return classes[0]
    log("\nSeveral classes exist — pick one with --class <id or name substring>:\n")
    for (const c of classes) log(`  ${c.id}  ${className(c)}`)
    log("")
    process.exit(1)
  }
  const needle = CLASS_ARG.toLowerCase()
  const matches = classes.filter(
    (c) => c.id === CLASS_ARG || className(c).toLowerCase().includes(needle)
  )
  if (matches.length === 0) {
    log("\nAvailable classes:\n")
    for (const c of classes) log(`  ${c.id}  ${className(c)}`)
    die(`No class matched "${CLASS_ARG}".`)
  }
  if (matches.length > 1) {
    log("\nAmbiguous — matched several classes:\n")
    for (const c of matches) log(`  ${c.id}  ${className(c)}`)
    die("Re-run with an exact class id.")
  }
  return matches[0]
}

async function backendUp() {
  try {
    // Any HTTP response means the server is listening. Don't check res.ok:
    // GET /api/kiwi-apps is auth-guarded and answers 401 to an anonymous probe,
    // which would otherwise read as "backend down".
    await fetch(`${KIWI_API}/api/kiwi-apps`, { signal: AbortSignal.timeout(2500) })
    return true
  } catch {
    return false
  }
}

async function registerViaApi() {
  const res = await fetch(`${KIWI_API}/api/kiwi-apps/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slug: APP.slug,
      registrationSecret: REGISTRATION_SECRET,
      name: APP.name,
      description: APP.description,
      baseUrl: APP.baseUrl,
      category: APP.category,
      version: APP.version,
      appType: APP.appType,
      capabilities: APP.capabilities,
      uis: APP.uis,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`register returned ${res.status}: ${body.slice(0, 400)}`)
  }
  return res.json()
}

async function registerViaDb(prisma) {
  const app = await prisma.kiwiApp.upsert({
    where: { slug: APP.slug },
    update: {
      name: APP.name,
      description: APP.description,
      baseUrl: APP.baseUrl,
      category: APP.category,
      version: APP.version,
      appType: APP.appType,
      capabilities: APP.capabilities,
      isActive: true,
    },
    create: {
      slug: APP.slug,
      name: APP.name,
      description: APP.description,
      baseUrl: APP.baseUrl,
      category: APP.category,
      version: APP.version,
      appType: APP.appType,
      capabilities: APP.capabilities,
      isActive: true,
    },
  })
  for (const ui of APP.uis) {
    await prisma.kiwiAppUI.upsert({
      where: { appId_uiSlug: { appId: app.id, uiSlug: ui.uiSlug } },
      update: {
        uiName: ui.uiName,
        uiUrl: ui.uiUrl,
        placement: ui.placement,
        allowedRoles: ui.allowedRoles,
        tabOrder: ui.tabOrder,
        isEnabled: true,
      },
      create: { appId: app.id, ...ui },
    })
  }
  return app
}

async function unregister(prisma) {
  const app = await prisma.kiwiApp.findUnique({ where: { slug: APP.slug } })
  if (app) {
    // ClassKiwiApp and KiwiAppUI cascade from KiwiApp.
    await prisma.kiwiApp.delete({ where: { id: app.id } })
    log(`✓ Removed registered app "${APP.slug}" (and its UIs / class enablements)`)
  } else {
    log(`· No registered app "${APP.slug}"`)
  }
  const wl = await prisma.kiwiAppWhitelist.findUnique({ where: { slug: APP.slug } })
  if (wl) {
    await prisma.kiwiAppWhitelist.delete({ where: { slug: APP.slug } })
    log(`✓ Removed whitelist entry "${APP.slug}"`)
  } else {
    log(`· No whitelist entry "${APP.slug}"`)
  }
}

async function main() {
  const { prisma, bcrypt } = await loadKiwiDeps()
  try {
    if (LIST_CLASSES) {
      const classes = await prisma.class.findMany({
        select: { id: true, classMetadata: true, createdDate: true },
        orderBy: { createdDate: "desc" },
      })
      log(`\n${classes.length} class(es) in this Kiwi database:\n`)
      for (const c of classes) log(`  ${c.id}  ${className(c)}`)
      log("")
      return
    }

    if (UNREGISTER) {
      await unregister(prisma)
      return
    }

    const klass = await pickClass(prisma)

    // 1. Whitelist ------------------------------------------------------------
    const hashed = await bcrypt.hash(REGISTRATION_SECRET, 10)
    await prisma.kiwiAppWhitelist.upsert({
      where: { slug: APP.slug },
      update: {
        registrationSecret: hashed,
        baseUrl: APP.baseUrl,
        status: "approved",
        description: APP.description,
        maxScopes: APP.maxScopes,
      },
      create: {
        slug: APP.slug,
        registrationSecret: hashed,
        baseUrl: APP.baseUrl,
        status: "approved",
        description: APP.description,
        maxScopes: APP.maxScopes,
        approvedBy: "register-kiwi-app.mjs (local dev)",
      },
    })
    log(`✓ Whitelisted "${APP.slug}" (approved, scopes: ${APP.maxScopes.length ? APP.maxScopes.join(", ") : "none"})`)

    // 2. Register -------------------------------------------------------------
    let app
    if (await backendUp()) {
      try {
        await registerViaApi()
        app = await prisma.kiwiApp.findUnique({ where: { slug: APP.slug } })
        log(`✓ Registered via POST ${KIWI_API}/api/kiwi-apps/register`)
      } catch (e) {
        log(`! API registration failed (${e.message}); writing directly to the database instead`)
        app = await registerViaDb(prisma)
      }
    } else {
      log(`· Kiwi backend not reachable at ${KIWI_API} — writing directly to the database`)
      app = await registerViaDb(prisma)
    }
    if (!app) die("App did not appear in the database after registration")
    log(`  UI: ${APP.uis[0].uiUrl}  (placement: ${APP.uis[0].placement})`)

    // 3. Enable for the class -------------------------------------------------
    await prisma.classKiwiApp.upsert({
      where: { classId_appId: { classId: klass.id, appId: app.id } },
      update: { isEnabled: true, tabLabel: APP.name, enabledScopes: APP.maxScopes },
      create: {
        classId: klass.id,
        appId: app.id,
        isEnabled: true,
        tabOrder: 0,
        tabLabel: APP.name,
        enabledScopes: APP.maxScopes,
        enabledBy: "register-kiwi-app.mjs (local dev)",
      },
    })
    log(`✓ Enabled for class ${klass.id} — ${className(klass)}`)

    log(`\nOpen it at:  http://localhost:3001/${klass.id}/app/${APP.slug}\n`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => die(e?.stack || e?.message || String(e)))
