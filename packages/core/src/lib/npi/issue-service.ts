// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { issues, items } from '../db/schema/items'
import { programs } from '../db/schema/programs'
import { users } from '../db/schema/users'
import { lifecycleDefinitions } from '../db/schema/lifecycles'
import * as s from '../db/schema/npi'
import { ItemService } from '../items/services/ItemService'
import { DEFAULT_ITEM_LIFECYCLES } from '../items/default-lifecycles'
import { LIFECYCLE_IDS } from '../items/lifecycle-ids'
import { LifecycleInstanceService } from '../lifecycles/LifecycleInstanceService'
import '../items/registerItemTypes.server'
import { NpiError, dateValue, textValue, today } from './domain'
import {
  event,
  getActor,
  loadProject,
  owner,
  uuidValue,
  versionCheck,
} from './service'
import type { Actor } from './service'
import type { TransactionClient } from '../db'
import type { Issue } from '../items/types/issue'

const forbidden = () => {
  throw new NpiError('NPI_PERMISSION_DENIED', '无权处理此项目问题', 403)
}
const issueSelect = {
  link: s.npiIssueLinks,
  item: items,
  issue: issues,
  ownerName: users.name,
  projectName: programs.name,
}
const issueQuery = (run: TransactionClient | typeof db) =>
  run
    .select(issueSelect)
    .from(s.npiIssueLinks)
    .innerJoin(items, eq(items.id, s.npiIssueLinks.itemId))
    .innerJoin(issues, eq(issues.itemId, items.id))
    .innerJoin(programs, eq(programs.id, s.npiIssueLinks.programId))
    .leftJoin(users, eq(users.id, issues.assignedTo))
const mapped = (r: {
  link: typeof s.npiIssueLinks.$inferSelect
  item: typeof items.$inferSelect
  issue: typeof issues.$inferSelect
  ownerName: string | null
  projectName: string
}) => ({
  ...r.link,
  id: r.item.id,
  title: r.item.name || r.item.itemNumber,
  number: r.item.itemNumber,
  description: r.issue.description || '',
  severity: r.issue.severity || 'Medium',
  state: r.item.state,
  ownerId: r.issue.assignedTo,
  ownerName: r.ownerName || '未分配',
  projectName: r.projectName,
  modifiedAt: r.item.modifiedAt,
  createdAt: r.item.createdAt,
  overdue:
    !['Closed', 'Cancelled'].includes(r.item.state) &&
    r.link.targetDate < today(),
  deleted: !!r.item.isDeleted,
})
async function access(
  run: TransactionClient | typeof db,
  actor: Actor,
  id: string,
  edit = false,
): Promise<Awaited<ReturnType<typeof issueQuery>>[number]> {
  const [r] = await issueQuery(run).where(
    eq(s.npiIssueLinks.itemId, uuidValue(id)),
  )
  if (!r || r.item.isDeleted || r.issue.programId !== r.link.programId)
    throw new NpiError('ISSUE_NOT_FOUND', '项目问题不存在或归属已变化', 404)
  if (actor.role === 'procurement') {
    if (r.issue.assignedTo !== actor.id) return forbidden()
    const query = run
      .select()
      .from(s.npiProjects)
      .where(eq(s.npiProjects.programId, r.link.programId))
    const [p] = edit ? await query.for('update') : await query
    if (!p) throw new NpiError('PROGRAM_NOT_FOUND', '项目不存在', 404)
    if (edit && p.currentNpiStage === 'completed')
      throw new NpiError('INVALID_STATE_TRANSITION', '已完成项目为只读', 400)
  } else await loadProject(run, r.link.programId, actor, edit)
  if (edit) {
    // The issue was read before waiting for the project serialization lock.
    // Re-read assignment, deletion and scope while holding that lock.
    const current = await access(run, actor, id)
    if (current.link.programId !== r.link.programId) return forbidden()
    return current
  }
  return r
}
async function relation(
  tx: TransactionClient,
  programId: string,
  input: Record<string, unknown>,
) {
  const trackingItemId = input.trackingItemId
    ? uuidValue(input.trackingItemId)
    : null
  const bomItemId = input.bomItemId ? uuidValue(input.bomItemId) : null
  if (trackingItemId && bomItemId)
    throw new NpiError('VALIDATION_ERROR', '只能关联一个物料或制造节点')
  if (trackingItemId) {
    const [r] = await tx
      .select()
      .from(s.npiTrackingItems)
      .where(
        and(
          eq(s.npiTrackingItems.id, trackingItemId),
          eq(s.npiTrackingItems.programId, programId),
        ),
      )
    if (!r) throw new NpiError('VALIDATION_ERROR', '关联跟踪项不属于此项目')
  }
  if (bomItemId) {
    const [r] = await tx
      .select({ id: s.npiBomItems.id })
      .from(s.npiBomItems)
      .innerJoin(
        s.npiBomImports,
        eq(s.npiBomImports.id, s.npiBomItems.importId),
      )
      .where(
        and(
          eq(s.npiBomItems.id, bomItemId),
          eq(s.npiBomImports.programId, programId),
        ),
      )
    if (!r) throw new NpiError('VALIDATION_ERROR', '关联BOM物料不属于此项目')
  }
  return { trackingItemId, bomItemId }
}
function severity(value: unknown) {
  if (!['Medium', 'High', 'Critical'].includes(String(value)))
    throw new NpiError('VALIDATION_ERROR', '请选择一般、重要或重大')
  return value as 'Medium' | 'High' | 'Critical'
}
function unchanged(
  r: Awaited<ReturnType<typeof access>>,
  input: Record<string, unknown>,
) {
  versionCheck(r.link.version, input.expectedVersion)
  if (input.expectedModifiedAt !== r.item.modifiedAt.toISOString())
    throw new NpiError('VERSION_CONFLICT', '问题已更新，请刷新后核对', 409)
}
async function seedIssueLifecycle() {
  const def = DEFAULT_ITEM_LIFECYCLES.find((d) => d.id === LIFECYCLE_IDS.issue)!
  await db
    .insert(lifecycleDefinitions)
    .values({
      id: def.id,
      name: def.name,
      version: def.version,
      workflowType: 'strict',
      lifecycleType: def.lifecycleType,
      definition: def.definition,
      isActive: true,
    })
    .onConflictDoNothing()
}
export async function createIssue(
  userId: string,
  projectId: string,
  input: Record<string, unknown>,
) {
  // Seed the native default only when absent. Existing lifecycle policy wins.
  const actor = await getActor(userId)
  await loadProject(db, projectId, actor, true)
  await seedIssueLifecycle()
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true)
    const project = await loadProject(tx, projectId, a, true)
    const assignee = await owner(tx, input.ownerId, [
      'technical',
      'manufacturing',
      'procurement',
    ])
    if (
      !['admin', 'procurement'].includes(assignee.role) &&
      ![project.technicalOwnerId, project.manufacturingOwnerId].includes(
        assignee.id,
      )
    )
      throw new NpiError(
        'VALIDATION_ERROR',
        '技术和制造问题责任人须为此项目负责人',
      )
    const linked = await relation(tx, projectId, input)
    const issue = await ItemService.create<Issue>(
      'Issue',
      {
        name: textValue(input.title, '问题标题', 200),
        description: textValue(input.description, '问题说明', 10000),
        severity: severity(input.severity),
        assignedTo: assignee.id,
        reportedBy: a.id,
        reportedDate: new Date(),
        programId: projectId,
      } as Issue,
      a.id,
      { tx },
    )
    if (!issue.id) throw new Error('Native Issue creation returned no ID')
    await tx.insert(s.npiIssueLinks).values({
      itemId: issue.id,
      programId: projectId,
      targetDate: dateValue(input.targetDate, '计划关闭日期')!,
      ...linked,
    })
    await event(tx, a, projectId, issue.id, 'ISSUE_CREATED', {
      title: issue.name,
      severity: issue.severity,
      targetDate: input.targetDate,
      ...linked,
    })
    return { id: issue.id }
  })
}
export async function listIssues(userId: string, projectId?: string) {
  const a = await getActor(userId)
  if (projectId) await loadProject(db, projectId, a)
  else if (a.role !== 'procurement') return forbidden()
  const rows = await issueQuery(db)
    .where(
      projectId
        ? eq(s.npiIssueLinks.programId, projectId)
        : eq(issues.assignedTo, a.id),
    )
    .orderBy(desc(items.createdAt))
  return rows
    .filter((r) => !r.item.isDeleted && r.issue.programId === r.link.programId)
    .map(mapped)
}
export async function issueDetail(userId: string, id: string) {
  const a = await getActor(userId),
    r = await access(db, a, id)
  const workflow = await LifecycleInstanceService.getInstanceByItemId(id)
  const history = workflow
    ? await LifecycleInstanceService.getHistory(workflow.id)
    : []
  const notes = await db
    .select({ event: s.npiEvents, actorName: users.name })
    .from(s.npiEvents)
    .innerJoin(users, eq(users.id, s.npiEvents.actorId))
    .where(
      and(
        eq(s.npiEvents.objectId, id),
        eq(s.npiEvents.programId, r.link.programId),
      ),
    )
    .orderBy(asc(s.npiEvents.createdAt))
  let relatedLabel = '整个项目'
  if (r.link.trackingItemId) {
    const [related] = await db
      .select({ name: s.npiTrackingItems.name })
      .from(s.npiTrackingItems)
      .where(eq(s.npiTrackingItems.id, r.link.trackingItemId))
    relatedLabel = related?.name || '原跟踪项'
  } else if (r.link.bomItemId) {
    const [related] = await db
      .select({ row: s.npiBomItems.row })
      .from(s.npiBomItems)
      .where(eq(s.npiBomItems.id, r.link.bomItemId))
    relatedLabel = related
      ? `${related.row.materialCode} · ${related.row.materialName}`
      : '原BOM物料'
  }
  return {
    ...mapped(r),
    relatedLabel,
    history,
    notes: notes.map((n) => ({ ...n.event, actorName: n.actorName })),
    transitions:
      a.role === 'supervisor'
        ? []
        : (await LifecycleInstanceService.getAvailableFreeTransitions(id))
            .transitions,
  }
}
export async function updateIssue(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true)
    if (!['admin', 'technical', 'manufacturing'].includes(a.role))
      return forbidden()
    const r = await access(tx, a, id, true)
    unchanged(r, input)
    if (['Closed', 'Cancelled'].includes(r.item.state))
      throw new NpiError(
        'INVALID_STATE_TRANSITION',
        '已关闭问题请先通过生命周期重新打开',
        400,
      )
    const reason = textValue(input.reason, '修改原因', 2000)
    const assignee = await owner(tx, input.ownerId, [
      'technical',
      'manufacturing',
      'procurement',
    ])
    const project = await loadProject(tx, r.link.programId, a, true)
    if (
      !['admin', 'procurement'].includes(assignee.role) &&
      ![project.technicalOwnerId, project.manufacturingOwnerId].includes(
        assignee.id,
      )
    )
      throw new NpiError(
        'VALIDATION_ERROR',
        '技术和制造问题责任人须为此项目负责人',
      )
    const targetDate = dateValue(input.targetDate, '计划关闭日期')!
    await ItemService.update<Issue>(
      id,
      {
        name: textValue(input.title, '问题标题', 200),
        description: textValue(input.description, '问题说明', 10000),
        severity: severity(input.severity),
        assignedTo: assignee.id,
      },
      a.id,
      { tx },
    )
    await tx
      .update(s.npiIssueLinks)
      .set({ targetDate, version: r.link.version + 1 })
      .where(eq(s.npiIssueLinks.itemId, id))
    await event(tx, a, r.link.programId, id, 'ISSUE_UPDATED', {
      reason,
      before: mapped(r),
      after: {
        title: input.title,
        description: input.description,
        severity: input.severity,
        ownerId: assignee.id,
        targetDate,
      },
    })
    return { id }
  })
}
export async function addIssueNote(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true),
      r = await access(tx, a, id, true)
    const message = textValue(input.message, '处理记录', 5000)
    const requestId =
      input.requestId === undefined
        ? undefined
        : uuidValue(input.requestId).toLowerCase()
    // access(edit=true) holds the project lock, serializing lookup + append.
    // Scope the retry identity to the current actor and project, not just text.
    if (requestId) {
      const [existing] = await tx
        .select()
        .from(s.npiEvents)
        .where(
          and(
            eq(s.npiEvents.programId, r.link.programId),
            eq(s.npiEvents.actorId, a.id),
            eq(s.npiEvents.action, 'ISSUE_NOTE'),
            sql`${s.npiEvents.detail}->>'requestId' = ${requestId}`,
          ),
        )
        .limit(1)
      if (existing) {
        if (
          existing.objectId !== r.item.id ||
          (existing.detail as { message?: unknown }).message !== message
        )
          throw new NpiError(
            'VERSION_CONFLICT',
            '此提交编号已用于另一条处理记录，请核对后重新提交',
            409,
          )
        return { id: r.item.id }
      }
    }
    await event(tx, a, r.link.programId, r.item.id, 'ISSUE_NOTE', {
      message,
      ...(requestId ? { requestId } : {}),
    })
    return { id }
  })
}
export async function transitionIssue(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  // Serialize NPI requests with the project lock, but do not hold an item row
  // lock: the native lifecycle owns its own state/history transaction.
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true),
      initial = await access(tx, a, id, true)
    // Procurement access is narrower than project access; still share the
    // same project serialization lock with imports and manager edits.
    if (a.role === 'procurement')
      await tx
        .select()
        .from(s.npiProjects)
        .where(eq(s.npiProjects.programId, initial.link.programId))
        .for('update')
    const r = await access(tx, a, id, true)
    unchanged(r, input)
    const comments = textValue(input.comments, '处理说明', 5000)
    return LifecycleInstanceService.transitionFreeItem(
      id,
      textValue(input.toState, '目标状态', 100),
      a.id,
      comments,
    )
  })
}
export type NpiIssue = Awaited<ReturnType<typeof listIssues>>[number]
export type NpiIssueDetail = Awaited<ReturnType<typeof issueDetail>>
