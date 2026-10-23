/** Course-scoped CSS Lab bridge (v0.6, `native-projection-v3`). Installed in the pinned Kiwi backend by backend-patches.mjs
 * and reinstall-bridge.mjs. Spec: docs/architecture-v0.6.0.md §15.1. */
import { Controller, Get, Req, Query, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { DatabaseService } from 'src/common/database/database.service';
import { KiwiAppService } from './kiwi-app.service';
import { getAppContext } from '../mcp/utils/scope-check';

const SCOPE = 'class:analytics:read';
export const TYPES = [
  'frontend-interaction-chat', 'frontend-interaction-chat-exercise', 'exercise_chat', 'chat-query',
  'frontend-interaction-ide-runcode', 'frontend-interaction-ide-movecodetochat',
  'frontend-interaction-ide-checkanswer', 'frontend-interaction-pdf-change',
  // v0.6: feedback on Kiwi lecture AI replies and scratchpad file actions (strings from kiwi-ui Feedback.tsx / IDE).
  'frontend-interaction-thumbs', 'frontend-interaction-feedback-flag',
  'frontend-interaction-ide-uploadfile', 'frontend-interaction-ide-switchtab',
  'frontend-interaction-ide-savecodetofile', 'frontend-interaction-ide-addfile',
];
export const MAX_ACTIONS = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Change = { at: Date; key: string; interactionId: string };
type Count = { n: number | bigint };

const text = (value: unknown, limit = 100000) => typeof value === 'string' ? value.slice(0, limit) : '';
const tooLong = (value: unknown, limit = 100000) => typeof value === 'string' && value.length > limit;

/** Context fields the Lab imports (§15.1 item 3); everything else in UserInteraction.context stays in Kiwi. */
export function projectContext(raw: unknown) {
  const context = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const content = context.content;
  const rawPrompt = typeof content === 'string' ? content : content?.prompt || context.prompt || context.message;
  const thumbs = typeof context.thumbsValue === 'number' ? context.thumbsValue
    : typeof context.value === 'number' ? context.value : undefined;
  // Kiwi fills uniqueID with the message's list index (kiwi-ui Feedback.tsx:29): an index, not a stable id.
  const index = context.chatMessage?.uniqueID ?? context.messages?.uniqueID;
  const projected = {
    content: { prompt: text(rawPrompt) }, userCode: text(context.userCode || context.code),
    outputCode: text(context.outputCode || context.output), success: context.success,
    error: text(context.error), resultVersion: context.resultVersion, language: context.language,
    ...(thumbs !== undefined ? { thumbsValue: thumbs } : {}),
    ...(typeof index === 'number' ? { targetMessageIndex: index } : {}),
    ...(typeof context.messages?.reply === 'string' ? { flagReply: text(context.messages.reply, 4000) } : {}),
    ...((context.fileName ?? context.file?.name) ? { fileName: text(context.fileName ?? context.file?.name, 300) } : {}),
  };
  const truncated = [rawPrompt, context.userCode || context.code, context.outputCode || context.output, context.error]
    .some(v => tooLong(v)) || tooLong(context.messages?.reply, 4000);
  return { context: projected, truncated };
}

/** Every non-intermediate reply, oldest first, capped at 20 with `actionsTruncated` (§15.1 item 2). */
export function projectActions(actions: { id: string; type: string; botResponse: string; timestamp: Date; engineChoice?: string | null }[]) {
  const kept = actions.slice(0, MAX_ACTIONS).map(action => ({ ...action, botResponse: text(action.botResponse) }));
  return { serverActions: kept, actionsTruncated: actions.length > MAX_ACTIONS,
    truncated: actions.slice(0, MAX_ACTIONS).some(action => tooLong(action.botResponse)) };
}

/** App config merge as Kiwi applies it (kiwi-app.service.ts resolveChatApp): class config overrides the app config. */
export function effectiveTutoringMode(appConfig: unknown, classConfig: unknown) {
  const app = (appConfig && typeof appConfig === 'object' ? appConfig : {}) as Record<string, unknown>;
  const course = (classConfig && typeof classConfig === 'object' ? classConfig : {}) as Record<string, unknown>;
  if (typeof course.tutoringMode === 'string') return { tutoringMode: course.tutoringMode, source: 'class_override' as const };
  if (typeof app.tutoringMode === 'string') return { tutoringMode: app.tutoringMode, source: 'app' as const };
  return { tutoringMode: null, source: null };
}

@Controller('api/kiwi-apps/ics-r-lab/lab')
export class LabBridgeController {
  constructor(private readonly db: DatabaseService, private readonly apps: KiwiAppService) {}

  private async identity(req: Request) {
    const app = getAppContext(req);
    if (!app || app.appSlug !== 'ics-r-lab' || !app.classId) {
      throw new ForbiddenException('A class-scoped CSS Lab app token is required');
    }
    // Recheck membership and the enabled app on every request, including cached JWTs.
    const [membership, scopes, user, instructor, course, binding, whitelist] = await Promise.all([
      this.apps.getUserClassRole(app.userId, app.classId),
      this.apps.calculateEffectiveScopes(app.appSlug, app.classId),
      this.db.user.findUnique({ where: { id: app.userId }, select: { email: true, systemRole: true } }),
      this.db.instructorClass.findUnique({ where: { userId_classId: { userId: app.userId, classId: app.classId } } }),
      this.db.class.findUnique({ where: { id: app.classId }, select: { classMetadata: true } }),
      this.db.kiwiApp.findUnique({ where: { slug: app.appSlug }, select: { isActive: true } }),
      this.db.kiwiAppWhitelist.findUnique({ where: { slug: app.appSlug }, select: { status: true } }),
    ]);
    if (!membership.role || !user || !course || !binding?.isActive || whitelist?.status !== 'approved') throw new ForbiddenException('An active app and course membership are required');
    const admin = user.systemRole === 'admin';
    const permissions = instructor?.isActive ? instructor.permissions as Record<string, unknown> : {};
    const hasAnalyticsScope = app.scopes.includes(SCOPE) && scopes.includes(SCOPE);
    return {
      classId: app.classId, userId: app.userId, username: user.email, userRole: membership.role,
      className: (course.classMetadata as any)?.className || app.classId,
      canTeach: admin || Boolean(instructor?.isActive),
      canManageCourse: admin || permissions?.canManageMaterials === true,
      canViewAnalytics: (admin || permissions?.canViewAnalytics === true) && hasAnalyticsScope,
    };
  }

  @Get('context')
  context(@Req() req: Request) { return this.identity(req); }

  /** Metadata counts (§15.1 item 5a): records the main query skips by design, and records of users no longer enrolled. */
  private async metadataCounts(classId: string) {
    const [byDesign, notEnrolled, binding] = await Promise.all([
      this.db.$queryRaw<Count[]>(Prisma.sql`
        SELECT COUNT(*)::int AS n FROM "UserInteraction" i WHERE i."classId"=${classId}
        AND i.type IN (${Prisma.join(TYPES)}) AND i."stringTag" LIKE 'app-ics-r-lab-%'
        AND EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."classId"=i."classId" AND e."userId"=i."userId" AND e.role='student')`),
      this.db.$queryRaw<Count[]>(Prisma.sql`
        SELECT COUNT(*)::int AS n FROM "UserInteraction" i WHERE i."classId"=${classId}
        AND i.type IN (${Prisma.join(TYPES)})
        AND NOT EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."classId"=i."classId" AND e."userId"=i."userId" AND e.role='student')
        AND NOT EXISTS (SELECT 1 FROM "InstructorClass" c WHERE c."classId"=i."classId" AND c."userId"=i."userId" AND c."isActive")`),
      this.db.classKiwiApp.findFirst({ where: { classId, app: { slug: 'ics-r-lab' } }, select: { config: true, app: { select: { config: true } } } }),
    ]);
    return { excludedByDesign: Number(byDesign[0]?.n ?? 0), excludedNotEnrolled: Number(notEnrolled[0]?.n ?? 0),
      appConfig: effectiveTutoringMode(binding?.app?.config, binding?.config) };
  }

  @Get('activity')
  async activity(@Req() req: Request, @Query('cursor') encoded?: string, @Query('snapshot') snapshotValue?: string,
    @Query('metadata') metadata?: string, @Query('userId') userIdFilter?: string) {
    const identity = await this.identity(req);
    if (!identity.canViewAnalytics) throw new ForbiddenException('Course analytics permission and app scope are required');
    let cursor = { at: '1970-01-01T00:00:00.000Z', key: '' };
    if (encoded && encoded.length>2048) throw new BadRequestException('Invalid activity cursor');
    try { if (encoded) cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
    catch { throw new BadRequestException('Invalid activity cursor'); }
    if (!cursor || !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.key !== 'string' || cursor.key.length > 100) {
      throw new BadRequestException('Invalid activity cursor');
    }
    // Per-user backfill (§15.1 item 5): both streams restricted to one student; the cursor protocol is unchanged.
    if (userIdFilter !== undefined && !UUID.test(userIdFilter)) throw new BadRequestException('Invalid userId');
    const userClause = userIdFilter ? Prisma.sql`AND i."userId"=${userIdFilter}` : Prisma.empty;
    const snapshot = snapshotValue ? new Date(snapshotValue) : new Date(Date.now() - 2000);
    if (!Number.isFinite(snapshot.getTime()) || snapshot.getTime() > Date.now()) throw new BadRequestException('Invalid snapshot');
    const after = new Date(cursor.at), classId = identity.classId;
    // Two indexed append streams: a late AI answer changes its original interaction,
    // rather than being missed because its question was exported earlier.
    const changes = await this.db.$queryRaw<Change[]>(Prisma.sql`
      SELECT * FROM (
        (SELECT i.timestamp AS at, 'i:' || i.id AS key, i.id AS "interactionId"
         FROM "UserInteraction" i WHERE i."classId"=${classId} ${userClause}
         AND EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."classId"=i."classId" AND e."userId"=i."userId" AND e.role='student')
         AND i.type IN (${Prisma.join(TYPES)}) AND i."stringTag" NOT LIKE 'app-ics-r-lab-%'
         AND i.timestamp<=${snapshot} AND (i.timestamp,'i:' || i.id)>(${after},${cursor.key})
         ORDER BY i.timestamp,i.id LIMIT 201)
        UNION ALL
        (SELECT a.timestamp AS at, 'a:' || a.id AS key, i.id AS "interactionId"
         FROM "ServerAction" a JOIN "UserInteraction" i ON i.id=a."interactionId"
         WHERE i."classId"=${classId} ${userClause} AND i.type IN (${Prisma.join(TYPES)})
         AND EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."classId"=i."classId" AND e."userId"=i."userId" AND e.role='student')
         AND i."stringTag" NOT LIKE 'app-ics-r-lab-%'
         AND a.timestamp<=${snapshot} AND (a.timestamp,'a:' || a.id)>(${after},${cursor.key})
         ORDER BY a.timestamp,a.id LIMIT 201)
      ) changes ORDER BY at,key LIMIT 201`);
    const page = changes.slice(0, 200), ids = [...new Set(page.map(c => c.interactionId))];
    const records = await this.db.userInteraction.findMany({
      where: { id: { in: ids }, classId },
      select: { id: true, userId: true, sessionId: true, timestamp: true, type: true, context: true,
        pdfId: true, pdfPage: true, pdfMaterialType: true, stringTag: true, conversationId: true,
        user: { select: { email: true, consent: true } }, conversation: { select: { title: true, source: true } },
        serverActions: { where: { timestamp: { lte: snapshot }, botResponse: { not: '' }, type: { not: 'agent-loop-step' } },
          orderBy: [{ timestamp: 'asc' }, { id: 'asc' }], take: MAX_ACTIONS + 1,
          select: { id: true, type: true, botResponse: true, timestamp: true, engineChoice: true } },
      },
    });
    const last = page[page.length - 1];
    const nextCursor = last ? Buffer.from(JSON.stringify({ at: last.at.toISOString(), key: last.key })).toString('base64url') : encoded || null;
    const withMetadata = metadata === 'true' && !userIdFilter;
    const materials = withMetadata ? await this.db.classMaterial.findMany({
      where: { classId }, orderBy: { id: 'asc' }, take: 1001,
      select: { id: true, title: true, materialType: true,
        documents: { select: { id: true, fileName: true } } },
    }) : undefined;
    // Emails and consent are returned per the current trust model (§14.6 open question for the Kiwi maintainers).
    const roster = withMetadata ? await this.db.enrollment.findMany({
      where: { classId, role: 'student' }, orderBy: { userId: 'asc' }, take: 10001,
      select: { userId: true, user: { select: { email: true, consent: true } } },
    }) : undefined;
    const counts = withMetadata ? await this.metadataCounts(classId) : undefined;
    // Metadata truncation is explicit; activity itself always has a next cursor.
    const activity = records.map(record => {
      const { context, truncated } = projectContext(record.context);
      const actions = projectActions(record.serverActions);
      return { ...record, context, truncated: truncated || actions.truncated,
        serverActions: actions.serverActions, ...(actions.actionsTruncated ? { actionsTruncated: true } : {}) };
    });
    return { classId, records: activity, nextCursor, hasMore: changes.length > 200,
      snapshot: snapshot.toISOString(), materials: materials?.slice(0, 1000), roster: roster?.slice(0, 10000),
      metadataTruncated: Boolean((materials?.length || 0)>1000 || (roster?.length || 0)>10000),
      ...(counts ?? {}) };
  }
}
