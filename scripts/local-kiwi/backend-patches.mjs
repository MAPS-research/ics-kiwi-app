import fs from 'node:fs';
import path from 'node:path';
import { backendRoot } from './backend-common.mjs';

function replace(relative, original, replacement) {
  const file = path.join(backendRoot, relative);
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes(replacement)) return;
  if (!content.includes(original)) throw new Error(`Kiwi upstream changed: review local patch for ${relative} before setup.`);
  fs.writeFileSync(file, content.replace(original, replacement));
}

/** Copy the bridge controller and its Jest spec into the Kiwi backend (also used by reinstall-bridge.mjs). */
export function installBridgeController(root = backendRoot) {
  for (const name of ['lab-bridge.controller.ts', 'lab-bridge.controller.spec.ts']) {
    fs.copyFileSync(new URL(`./bridge/${name}`, import.meta.url), path.join(root, 'src/kiwi-app', name));
  }
}

export function applyBackendPatches() {
  installBridgeController();
  replace('src/kiwi-app/kiwi-app.module.ts',
    "import { AppDataController } from './app-data.controller';",
    "import { AppDataController } from './app-data.controller';\nimport { LabBridgeController } from './lab-bridge.controller';");
  replace('src/kiwi-app/kiwi-app.module.ts', '    AppDataController,', '    AppDataController,\n    LabBridgeController,');
  replace('src/main.ts', 'await app.listen(port);', "await app.listen(port, '127.0.0.1');");
  replace('src/auth/auth.constants.ts',
    'accessToken: 60, // 60 seconds',
    'accessToken: 3600, // Isolated local demo: match the one-hour browser session.');
  replace('src/interaction/interaction.interceptor.ts',
    "if (request.url === '/student/chat') {",
    "if (/^\\/auth(?:\\/|$)/.test(request.url) || request.url.split('?')[0] === '/student/chat' || request.url.split('?')[0] === '/student/chat/v2' || String(request.headers?.accept || '').includes('text/event-stream')) {");
  replace('src/interaction/interaction.interceptor.ts',
    'request: request.body,',
    "request: { method: request.method, path: request.path || request.url.split('?')[0] },");
  replace('src/interaction/interaction.interceptor.ts',
    'interactionAction.context.response = data;',
    'interactionAction.context.response = { sent: true };');
  replace('src/interaction/interaction.interceptor.ts',
    'response: null,',
    'response: null as Record<string, unknown> | null,');
  replace('src/common/llm/llm.service.ts',
    'isReasoningModel: true,',
    "isReasoningModel: /^(?:gpt-[56](?:[.-]|$)|o[1-9])/.test(this.configService.get<string>('LLM_CHAT_MODEL') || ''),");
  replace('src/email/email.service.ts',
    '// Verify transporter configuration\n    this.transporter.verify((error) => {',
    '// Do not contact SMTP services during the local email test mode.\n    if (!emailConfig.testMode) this.transporter.verify((error) => {');

  const controller = `import { Controller, Get } from '@nestjs/common';
import { Public } from 'src/auth/auth.decorator';
import { DatabaseService } from 'src/common/database/database.service';
import { RedisService } from 'src/common/redis/redis.service';

// Local demo readiness: validate our own dependencies, without an external ping.
@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService, private readonly redis: RedisService) {}

  @Get()
  @Public()
  async check() {
    await this.database.$queryRaw\`SELECT 1\`;
    await this.redis.get('css-kiwi-demo:health');
    const dependencies = { postgres: { status: 'up' }, redis: { status: 'up' } };
    return { status: 'ok', info: dependencies, error: {}, details: dependencies };
  }
}
`;
  fs.writeFileSync(path.join(backendRoot, 'src/health/health.controller.ts'), controller);
  replace('src/health/health.module.ts',
    "import { HealthController } from './health.controller';",
    "import { HealthController } from './health.controller';\nimport { DatabaseModule } from 'src/common/database/database.module';\nimport { RedisModule } from 'src/common/redis/redis.module';");
  replace('src/health/health.module.ts',
    'imports: [TerminusModule, HttpModule],',
    'imports: [TerminusModule, HttpModule, DatabaseModule, RedisModule],');
}
