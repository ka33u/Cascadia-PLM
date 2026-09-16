// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { projects } from '../db/schema/projects'
import { users } from '../db/schema/users'
import * as s from '../db/schema/npi'
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
const forbidden = (): never => {
  throw new NpiError('NPI_PERMISSION_DENIED', '无权处理此项目问题', 403)
}
const nextStates: Record<string, string[]> = {
  Open: ['InProgress', 'Cancelled'],
  InProgress: ['Pending', 'Resolved', 'Cancelled'],
  Pending: ['InProgress', 'Resolved', 'Cancelled'],
  Resolved: ['Verified', 'InProgress'],
  Verified: ['Closed', 'InProgress'],
  Closed: ['InProgress'],
  Cancelled: ['Open'],
}
const issueQuery = (run: TransactionClient | typeof db) =>
  run
    .select({
      issue: s.npiIssues,
      ownerName: users.name,
      projectName: projects.name,
    })
    .from(s.npiIssues)
    .innerJoin(projects, eq(projects.id, s.npiIssues.programId))
    .innerJoin(users, eq(users.id, s.npiIssues.ownerId))
const mapped = (r: Awaited<ReturnType<typeof issueQuery>>[number]) => ({
  ...r.issue,
  ownerName: r.ownerName,
  projectName: r.projectName,
  overdue:
    !['Closed', 'Cancelled'].includes(r.issue.state) &&
    r.issue.targetDate < today(),
})
async function access(
  run: TransactionClient | typeof db,
  actor: Actor,
  id: string,
  edit = false,
): Promise<Awaited<ReturnType<typeof issueQuery>>[number]> {
  const [r] = await issueQuery(run).where(eq(s.npiIssues.id, uuidValue(id)))
  if (!r) throw new NpiError('ISSUE_NOT_FOUND', '项目问题不存在', 404)
  if (actor.role === 'procurement') {
    if (r.issue.ownerId !== actor.id) return forbidden()
    const q = run
      .select()
      .from(s.npiProjects)
      .where(eq(s.npiProjects.programId, r.issue.programId))
    const [p] = edit ? await q.for('update') : await q
    if (!p) throw new NpiError('PROGRAM_NOT_FOUND', '项目不存在', 404)
    if (edit && p.currentNpiStage === 'completed')
      throw new NpiError('INVALID_STATE_TRANSITION', '已完成项目为只读', 400)
  } else await loadProject(run, r.issue.programId, actor, edit)
  if (edit) {
    const current = await access(run, actor, id)
    if (current.issue.programId !== r.issue.programId) return forbidden()
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
  versionCheck(r.issue.version, input.expectedVersion)
  if (input.expectedModifiedAt !== r.issue.modifiedAt.toISOString())
    throw new NpiError('VERSION_CONFLICT', '问题已更新，请刷新后核对', 409)
}
async function assignee(
  tx: TransactionClient,
  p: typeof s.npiProjects.$inferSelect,
  input: Record<string, unknown>,
) {
  const a = await owner(tx, input.ownerId, [
    'technical',
    'manufacturing',
    'procurement',
  ])
  if (
    !['admin', 'procurement'].includes(a.role) &&
    ![p.technicalOwnerId, p.manufacturingOwnerId].includes(a.id)
  )
    throw new NpiError(
      'VALIDATION_ERROR',
      '技术和制造问题责任人须为此项目负责人',
    )
  return a
}
export async function createIssue(
  userId: string,
  projectId: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const actor = await getActor(userId, tx, true),
      p = await loadProject(tx, projectId, actor, true)
    const person = await assignee(tx, p, input),
      linked = await relation(tx, projectId, input)
    const [issue] = await tx
      .insert(s.npiIssues)
      .values({
        programId: projectId,
        number: 'ISS-' + randomUUID(),
        title: textValue(input.title, '问题标题', 200),
        description: textValue(input.description, '问题说明', 10000),
        severity: severity(input.severity),
        ownerId: person.id,
        createdBy: actor.id,
        targetDate: dateValue(input.targetDate, '计划关闭日期')!,
        ...linked,
      })
      .returning()
    await event(tx, actor, projectId, issue!.id, 'ISSUE_CREATED', {
      title: issue!.title,
      severity: issue!.severity,
      targetDate: issue!.targetDate,
      ...linked,
    })
    return { id: issue!.id }
  })
}
export async function listIssues(userId: string, projectId?: string) {
  const actor = await getActor(userId)
  if (projectId) await loadProject(db, projectId, actor)
  else if (actor.role !== 'procurement') return forbidden()
  const rows = await issueQuery(db)
    .where(
      projectId
        ? eq(s.npiIssues.programId, projectId)
        : eq(s.npiIssues.ownerId, actor.id),
    )
    .orderBy(desc(s.npiIssues.createdAt))
  return rows.map(mapped)
}
export async function issueDetail(userId: string, id: string) {
  const actor = await getActor(userId),
    r = await access(db, actor, id)
  const history = await db
    .select()
    .from(s.npiIssueHistory)
    .where(eq(s.npiIssueHistory.issueId, id))
    .orderBy(asc(s.npiIssueHistory.timestamp))
  const notes = await db
    .select({ event: s.npiEvents, actorName: users.name })
    .from(s.npiEvents)
    .innerJoin(users, eq(users.id, s.npiEvents.actorId))
    .where(
      and(
        eq(s.npiEvents.objectId, id),
        eq(s.npiEvents.programId, r.issue.programId),
      ),
    )
    .orderBy(asc(s.npiEvents.createdAt))
  let relatedLabel = '整个项目'
  if (r.issue.trackingItemId) {
    const [item] = await db
      .select()
      .from(s.npiTrackingItems)
      .where(eq(s.npiTrackingItems.id, r.issue.trackingItemId))
    relatedLabel = item?.name || '原跟踪项'
  } else if (r.issue.bomItemId) {
    const [item] = await db
      .select()
      .from(s.npiBomItems)
      .where(eq(s.npiBomItems.id, r.issue.bomItemId))
    relatedLabel = item
      ? item.row.materialCode + ' · ' + item.row.materialName
      : '原BOM物料'
  }
  const [p] = await db
    .select()
    .from(s.npiProjects)
    .where(eq(s.npiProjects.programId, r.issue.programId))
  return {
    ...mapped(r),
    relatedLabel,
    history,
    notes: notes.map((n) => ({ ...n.event, actorName: n.actorName })),
    transitions:
      actor.role === 'supervisor' || p?.currentNpiStage === 'completed'
        ? []
        : (nextStates[r.issue.state] || []).map((state) => ({
            id: r.issue.state + '-' + state,
            toStateId: state,
            toStateName: state,
          })),
  }
}
export async function updateIssue(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const actor = await getActor(userId, tx, true)
    if (!['admin', 'technical', 'manufacturing'].includes(actor.role))
      return forbidden()
    const r = await access(tx, actor, id, true)
    unchanged(r, input)
    if (['Closed', 'Cancelled'].includes(r.issue.state))
      throw new NpiError(
        'INVALID_STATE_TRANSITION',
        '已关闭问题请先重新打开',
        400,
      )
    const reason = textValue(input.reason, '修改原因', 2000),
      p = await loadProject(tx, r.issue.programId, actor, true),
      person = await assignee(tx, p, input)
    const after = {
      title: textValue(input.title, '问题标题', 200),
      description: textValue(input.description, '问题说明', 10000),
      severity: severity(input.severity),
      ownerId: person.id,
      targetDate: dateValue(input.targetDate, '计划关闭日期')!,
    }
    await tx
      .update(s.npiIssues)
      .set({ ...after, version: r.issue.version + 1, modifiedAt: new Date() })
      .where(eq(s.npiIssues.id, id))
    await event(tx, actor, r.issue.programId, id, 'ISSUE_UPDATED', {
      reason,
      before: mapped(r),
      after,
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
            eq(s.npiEvents.programId, r.issue.programId),
            eq(s.npiEvents.actorId, a.id),
            eq(s.npiEvents.action, 'ISSUE_NOTE'),
            sql`${s.npiEvents.detail}->>'requestId' = ${requestId}`,
          ),
        )
        .limit(1)
      if (existing) {
        if (
          existing.objectId !== r.issue.id ||
          (existing.detail as { message?: unknown }).message !== message
        )
          throw new NpiError(
            'VERSION_CONFLICT',
            '此提交编号已用于另一条处理记录，请核对后重新提交',
            409,
          )
        return { id: r.issue.id }
      }
    }
    await event(tx, a, r.issue.programId, r.issue.id, 'ISSUE_NOTE', {
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
  return db.transaction(async (tx) => {
    const actor = await getActor(userId, tx, true),
      r = await access(tx, actor, id, true)
    unchanged(r, input)
    const toState = textValue(input.toState, '目标状态', 100),
      comments = textValue(input.comments, '处理说明', 5000)
    if (!(nextStates[r.issue.state] || []).includes(toState))
      throw new NpiError('INVALID_STATE_TRANSITION', '不允许此状态流转', 400)
    await tx
      .update(s.npiIssues)
      .set({
        state: toState,
        version: r.issue.version + 1,
        modifiedAt: new Date(),
      })
      .where(eq(s.npiIssues.id, id))
    await tx.insert(s.npiIssueHistory).values({
      issueId: id,
      fromState: r.issue.state,
      toState,
      comments,
      actorId: actor.id,
    })
    return { id, state: toState }
  })
}
export type NpiIssue = Awaited<ReturnType<typeof listIssues>>[number]
export type NpiIssueDetail = Awaited<ReturnType<typeof issueDetail>>
