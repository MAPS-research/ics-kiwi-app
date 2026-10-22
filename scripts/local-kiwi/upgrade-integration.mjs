/** Upgrade the isolated demo integration; preserve course content, work and grades. */
import fs from 'node:fs';
import { createDemoDatabase, loadBackendEnvironment, projectRoot, backendRequire } from './backend-common.mjs';
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
  await db.kiwiApp.update({ where: { id: app.id }, data: {
    version: JSON.parse(fs.readFileSync(`${projectRoot}/package.json`, 'utf8')).version,
  } });
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
