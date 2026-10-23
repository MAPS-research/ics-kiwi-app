/** Upgrade the isolated demo integration; preserve course content, work and grades. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDemoDatabase, loadBackendEnvironment, projectRoot, backendRequire } from './backend-common.mjs';

export const APP_DESCRIPTION = 'R practice, assignments and teacher analytics.';
/** Courses whose ClassKiwiApp.config.tutoringMode overrides the app value (Kiwi applies the class value first). */
export function tutoringOverrideWarnings(bindings) {
  return bindings.filter(b => b.config && typeof b.config === 'object' && typeof b.config.tutoringMode === 'string'
    && b.config.tutoringMode !== 'guidance')
    .map(b => `Warning: course ${b.classId} overrides Kiwi's chat mode on CSS Lab pages with tutoringMode "${b.config.tutoringMode}" `
      + '(the course value wins over the app\'s "guidance"). Change it in Kiwi\'s course app settings if that is not intended.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();

async function main() {
loadBackendEnvironment();
const db = createDemoDatabase();
try {
  const credentials = JSON.parse(fs.readFileSync(`${projectRoot}/.local/demo-credentials.json`, 'utf8'));
  const bcrypt = backendRequire('bcryptjs');
  for (const account of [credentials.teacher, credentials.student]) {
    const user = await db.user.findUniqueOrThrow({ where: { id: account.id } });
    if (user.email !== account.email) throw new Error('Local account identity changed; no password was updated.');
    if (!user.passwordHash || !(await bcrypt.compare(account.password, user.passwordHash))) {
      const passwordSalt = await bcrypt.genSalt(10);
      await db.user.update({ where: { id: user.id }, data: { passwordSalt, passwordHash: await bcrypt.hash(account.password, passwordSalt) } });
      console.log('Restored a local demo account password from the retained credential file.');
    }
  }
  const scopes = ['class:materials:chunks:read', 'class:analytics:read'];
  const app = await db.kiwiApp.findUniqueOrThrow({ where: { slug: 'ics-r-lab' } });
  await db.kiwiAppWhitelist.update({ where: { slug: app.slug }, data: { maxScopes: scopes } });
  // v0.6 (§15.3, TELEMETRY-13/17): description without "Adaptive", Kiwi's own chat on Lab pages in guidance mode,
  // and the version from package.json. Existing app config keys are kept.
  await db.kiwiApp.update({ where: { id: app.id }, data: {
    version: JSON.parse(fs.readFileSync(`${projectRoot}/package.json`, 'utf8')).version,
    description: APP_DESCRIPTION,
    config: { ...(app.config && typeof app.config === 'object' ? app.config : {}), tutoringMode: 'guidance' },
  } });
  const bindings = await db.classKiwiApp.findMany({ where: { appId: app.id }, select: { classId: true, config: true } });
  for (const line of tutoringOverrideWarnings(bindings)) console.warn(line);
  const binding = await db.classKiwiApp.findUniqueOrThrow({ where: { classId_appId: { classId: 'local-css-demo', appId: app.id } } });
  await db.classKiwiApp.update({ where: { id: binding.id }, data: { enabledScopes: [...new Set([...binding.enabledScopes, ...scopes])] } });
  for (const uiSlug of ['student', 'teacher']) {
    const ui = await db.kiwiAppUI.findUniqueOrThrow({ where: { appId_uiSlug: { appId: app.id, uiSlug } } });
    await db.kiwiAppUI.update({ where: { id: ui.id }, data: { allowedRoles: [...new Set([...ui.allowedRoles, 'professor'])] } });
  }
  await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "lab_activity_class_time" ON "UserInteraction" ("classId", timestamp, id)');
  await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "lab_action_time" ON "ServerAction" (timestamp, id)');
  await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "lab_action_interaction" ON "ServerAction" ("interactionId", timestamp)');
  await db.classMaterial.updateMany({ where: { id: 'local-css-demo-context', classId: 'local-css-demo', materialType: 'text' }, data: { materialType: 'class materials' } });
  console.log('CSS Lab course binding, role entry points and activity read indexes upgraded.');
} finally { await db.$disconnect(); }
}
