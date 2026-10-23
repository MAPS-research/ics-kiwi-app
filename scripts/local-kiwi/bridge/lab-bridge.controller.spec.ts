/** Jest spec for the CSS Lab bridge (runs inside .local/kiwi via scripts/local-kiwi/run-bridge-tests.mjs). Prisma is
 * mocked here; the raw SQL is validated end to end by verify-integration.mjs against `demo:start` (INTEGRATION-06). */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { LabBridgeController, MAX_ACTIONS, TYPES, effectiveTutoringMode, projectActions, projectContext } from './lab-bridge.controller';

const STUDENT = '00000000-0000-4000-8000-000000000192';

function sqlText(query: any): string {
  return String(query?.sql ?? query?.text ?? query?.strings?.join('?') ?? '');
}

function setup(overrides: { role?: string; analytics?: boolean } = {}) {
  const db: any = {
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'teacher@x.edu', systemRole: 'instructor' }) },
    instructorClass: { findUnique: jest.fn().mockResolvedValue({ isActive: true, permissions: { canManageMaterials: true, canViewAnalytics: overrides.analytics ?? true } }) },
    class: { findUnique: jest.fn().mockResolvedValue({ classMetadata: { className: 'CSS demo' } }) },
    kiwiApp: { findUnique: jest.fn().mockResolvedValue({ isActive: true }) },
    kiwiAppWhitelist: { findUnique: jest.fn().mockResolvedValue({ status: 'approved' }) },
    userInteraction: { findMany: jest.fn().mockResolvedValue([]) },
    classMaterial: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([{ userId: STUDENT, user: { email: 'demo@x.edu', consent: true } }]) },
    classKiwiApp: { findFirst: jest.fn().mockResolvedValue({ config: { tutoringMode: 'direct' }, app: { config: { tutoringMode: 'guidance' } } }) },
    $queryRaw: jest.fn(async (query: any) => {
      const text = sqlText(query);
      if (text.includes('COUNT(*)') && text.includes("LIKE 'app-ics-r-lab-%'")) return [{ n: 13 }];
      if (text.includes('COUNT(*)')) return [{ n: 4 }];
      return [];
    }),
  };
  const apps: any = {
    getUserClassRole: jest.fn().mockResolvedValue({ role: overrides.role ?? 'instructor' }),
    calculateEffectiveScopes: jest.fn().mockResolvedValue(['class:analytics:read']),
  };
  const req: any = { appContext: { appSlug: 'ics-r-lab', classId: 'local-css-demo', userId: 'teacher-1', scopes: ['class:analytics:read'] } };
  return { db, apps, req, controller: new LabBridgeController(db, apps) };
}

describe('LabBridgeController v0.6 (native-projection-v3)', () => {
  it('projects new types', async () => {
    expect(TYPES).toEqual(expect.arrayContaining([
      'frontend-interaction-thumbs', 'frontend-interaction-feedback-flag', 'frontend-interaction-ide-uploadfile',
      'frontend-interaction-ide-switchtab', 'frontend-interaction-ide-savecodetofile', 'frontend-interaction-ide-addfile',
    ]));
    const thumbs = projectContext({ value: 1, chatMessage: { uniqueID: 3 } });
    expect(thumbs.context).toMatchObject({ thumbsValue: 1, targetMessageIndex: 3 });
    const flag = projectContext({ messages: { uniqueID: 2, reply: 'x'.repeat(5000) } });
    expect(flag.context).toMatchObject({ targetMessageIndex: 2 });
    expect(flag.context.flagReply).toHaveLength(4000);
    expect(flag.truncated).toBe(true);
    expect(projectContext({ file: { name: 'data.csv' } }).context.fileName).toBe('data.csv');
    expect(projectContext({ error: 'e'.repeat(100001) }).truncated).toBe(true);

    const { controller, db, req } = setup();
    const at = new Date('2026-10-20T01:00:00.000Z');
    db.$queryRaw.mockImplementationOnce(async () => [{ at, key: 'i:r1', interactionId: 'r1' }]);
    const actions = Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => ({
      id: `a${i}`, type: 'chat', botResponse: `reply ${i}`, timestamp: new Date(at.getTime() + i * 1000), engineChoice: 'gpt' }));
    db.userInteraction.findMany.mockResolvedValue([{ id: 'r1', userId: STUDENT, sessionId: 's', timestamp: at, type: 'frontend-interaction-thumbs',
      context: { value: -1, chatMessage: { uniqueID: 5 } }, pdfId: null, pdfPage: null, pdfMaterialType: null, stringTag: '', conversationId: 'conv-1',
      user: { email: 'demo@x.edu', consent: true }, conversation: { title: 'Thread', source: 'chat' }, serverActions: actions }]);
    const page = await controller.activity(req, undefined, '2026-10-20T01:05:00.000Z', 'false');
    const record = page.records[0];
    expect(record.context).toMatchObject({ thumbsValue: -1, targetMessageIndex: 5 });
    expect(record.serverActions).toHaveLength(MAX_ACTIONS);
    expect(record.actionsTruncated).toBe(true);
    expect(record.serverActions[0]).toMatchObject({ id: 'a0', engineChoice: 'gpt' });
    const select = db.userInteraction.findMany.mock.calls[0][0].select;
    expect(select.serverActions.where).toEqual({ timestamp: { lte: expect.any(Date) }, botResponse: { not: '' }, type: { not: 'agent-loop-step' } });
    expect(select.serverActions.take).toBe(MAX_ACTIONS + 1);
    expect(projectActions(actions.slice(0, 3)).actionsTruncated).toBe(false);
  });

  it('returns consent', async () => {
    const { controller, db, req } = setup();
    const page = await controller.activity(req, undefined, undefined, 'true');
    expect(page.roster).toEqual([{ userId: STUDENT, user: { email: 'demo@x.edu', consent: true } }]);
    expect(db.enrollment.findMany.mock.calls[0][0].select.user.select).toEqual({ email: true, consent: true });
    expect(db.userInteraction.findMany.mock.calls[0][0].select.user.select).toEqual({ email: true, consent: true });
  });

  it('counts excluded records', async () => {
    const { controller, req } = setup();
    const page = await controller.activity(req, undefined, undefined, 'true');
    expect(page).toMatchObject({ excludedByDesign: 13, excludedNotEnrolled: 4, appConfig: { tutoringMode: 'direct', source: 'class_override' } });
    expect(effectiveTutoringMode({ tutoringMode: 'guidance' }, {})).toEqual({ tutoringMode: 'guidance', source: 'app' });
    expect(effectiveTutoringMode({}, null)).toEqual({ tutoringMode: null, source: null });
    const plain = await controller.activity(req, undefined, undefined, 'false');
    expect(plain).not.toHaveProperty('excludedByDesign');
  });

  it('filters by userId', async () => {
    const { controller, db, req } = setup();
    await controller.activity(req, undefined, undefined, 'true', STUDENT);
    const query = db.$queryRaw.mock.calls[0][0];
    expect(query.values).toContain(STUDENT);
    expect(sqlText(query)).toContain('"userId"=');
    expect(db.enrollment.findMany).not.toHaveBeenCalled(); // no metadata pass during a per-user backfill
    await expect(controller.activity(req, undefined, undefined, 'false', 'not-a-uuid')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates the cursor and requires analytics permission', async () => {
    const { controller, req } = setup();
    await expect(controller.activity(req, 'not-base64-json')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.activity(req, 'x'.repeat(3000))).rejects.toBeInstanceOf(BadRequestException);
    const cursor = Buffer.from(JSON.stringify({ at: 'nope', key: '' })).toString('base64url');
    await expect(controller.activity(req, cursor)).rejects.toBeInstanceOf(BadRequestException);
    const denied = setup({ analytics: false });
    await expect(denied.controller.activity(denied.req)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
