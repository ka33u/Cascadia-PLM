// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  issues as nativeIssues,
  items as nativeItems,
} from '../db/schema/items'
import { programMembers, programs } from '../db/schema/programs'
import { roles, userRoles, users } from '../db/schema/users'
import * as s from '../db/schema/npi'
import {
  NpiError,
  dateValue,
  itemStatus,
  kitStatus,
  nodeNames,
  promiseChange,
  quantity,
  stages,
  textValue,
  today,
} from './domain'
import {
  bomDiff,
  bomLocations,
  bomTree,
  defaultTemplate,
  validateTemplate,
} from './bom'
import { previewExcel } from './excel'
import { confirmMother } from './mother-confirmation'
import { prepareProjectProfile, readProjectProfile } from './project-profile'
import { dashboardMetrics } from './project-dashboard'
import {
  businessDayRange,
  promiseChangeCounts,
  todayActivity,
} from './activity'
import type { TrackingBomReference } from './tracking-reference'
import type { NodeType, NpiStage } from './domain'
import type { BomRow, ImportTemplate } from './bom'
import type { TransactionClient } from '../db'

type Tx = TransactionClient
type Role = typeof s.npiUserRoles.$inferSelect.role
export type Actor = { id: string; name: string; role: Role }
type Project = typeof s.npiProjects.$inferSelect
type Track = typeof s.npiTrackingItems.$inferSelect
export const uuidValue = (v: unknown) => {
  if (
    typeof v !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v,
    )
  )
    throw new NpiError('VALIDATION_ERROR', '对象编号无效')
  return v
}
const denied = () => {
  throw new NpiError('NPI_PERMISSION_DENIED', '无权执行此操作', 403)
}
export const versionCheck = (
  actual: number,
  expected: unknown,
  code = 'VERSION_CONFLICT',
) => {
  if (actual !== expected)
    throw new NpiError(code, '记录已改变，请重新打开最新记录再提交', 409)
}
const flag = (v: unknown, fallback = true) => {
  if (v === undefined) return fallback
  if (typeof v !== 'boolean')
    throw new NpiError('VALIDATION_ERROR', '开关值必须是布尔值')
  return v
}
export const event = async (
  tx: Tx,
  actor: Actor,
  programId: string | null,
  objectId: string,
  action: string,
  detail: unknown,
) => {
  await tx
    .insert(s.npiEvents)
    .values({ actorId: actor.id, programId, objectId, action, detail })
}
export async function getActor(
  userId: string,
  tx: Tx | typeof db = db,
  lock = false,
): Promise<Actor> {
  const userQuery = tx.select().from(users).where(eq(users.id, userId))
  const [user] = lock ? await userQuery.for('share') : await userQuery
  if (!user?.active) return denied()
  const memberships = await tx
    .select({ name: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId))
  const [mapping] = await tx
    .select()
    .from(s.npiUserRoles)
    .where(eq(s.npiUserRoles.userId, userId))
  const role = memberships.some((r) => r.name === 'Administrator')
    ? 'admin'
    : mapping?.role
  if (!role) return denied()
  return { id: userId, name: user.name || user.email, role }
}
export async function loadProject(
  tx: Tx | typeof db,
  id: string,
  actor: Actor,
  // 'plan' authorizes supervisor planning only; ordinary writes still use true.
  edit: boolean | 'plan' = false,
) {
  uuidValue(id)
  const query = tx
    .select()
    .from(s.npiProjects)
    .where(eq(s.npiProjects.programId, id))
  const [p] = edit ? await query.for('update') : await query
  if (!p) throw new NpiError('PROGRAM_NOT_FOUND', '新品项目不存在', 404)
  const isOwner = [p.technicalOwnerId, p.manufacturingOwnerId].includes(
    actor.id,
  )
  if (!(
    actor.role === 'admin' ||
    ((!edit || edit === 'plan') && actor.role === 'supervisor') ||
    (isOwner && ['technical', 'manufacturing'].includes(actor.role))
  ))
    return denied()
  if (edit && p.currentNpiStage === 'completed')
    throw new NpiError('INVALID_STATE_TRANSITION', '已完成项目为只读', 400)
  return p
}
export async function owner(tx: Tx, id: unknown, accepted: Array<Role>) {
  const a = await getActor(uuidValue(id), tx, true)
  if (!accepted.includes(a.role) && a.role !== 'admin')
    throw new NpiError('VALIDATION_ERROR', '责任人岗位不符合要求')
  return a
}
export async function metadata(userId: string) {
  const actor = await getActor(userId)
  if (actor.role === 'procurement')
    return { actor, users: [], templates: [], recentProcurementOwnerId: null }
  const people = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      active: users.active,
      role: s.npiUserRoles.role,
    })
    .from(users)
    .leftJoin(s.npiUserRoles, eq(users.id, s.npiUserRoles.userId))
    .where(eq(users.active, true))
  const [recent] = await db
    .select({ ownerId: users.id })
    .from(s.npiEvents)
    .innerJoin(
      users,
      sql`${users.id}::text = ${s.npiEvents.detail}->>'ownerId'`,
    )
    .innerJoin(s.npiUserRoles, eq(s.npiUserRoles.userId, users.id))
    .where(
      and(
        eq(s.npiEvents.actorId, actor.id),
        eq(s.npiEvents.action, 'EXTERNAL_CREATED'),
        sql`${s.npiEvents.detail}->>'trackingType' = 'purchase'`,
        eq(users.active, true),
        eq(s.npiUserRoles.role, 'procurement'),
      ),
    )
    .orderBy(desc(s.npiEvents.createdAt), desc(s.npiEvents.id))
    .limit(1)
  return {
    actor,
    recentProcurementOwnerId: recent?.ownerId || null,
    users: people,
    templates: await db
      .select({
        id: s.npiImportTemplates.id,
        name: s.npiImportTemplates.name,
        config: s.npiImportTemplates.config,
        version: s.npiImportTemplates.version,
        enabled: s.npiImportTemplates.enabled,
      })
      .from(s.npiImportTemplates),
  }
}
export async function createProject(
  userId: string,
  input: Record<string, unknown>,
) {
  return db.transaction((tx) => createProjectInTransaction(tx, userId, input))
}
export async function createProjectInTransaction(
  tx: Tx,
  userId: string,
  input: Record<string, unknown>,
) {
  const actor = await getActor(userId, tx, true)
  if (!['technical', 'admin'].includes(actor.role)) return denied()
  const tech = await owner(tx, input.technicalOwnerId, ['technical'])
  const mfg = await owner(tx, input.manufacturingOwnerId, ['manufacturing'])
  const name = textValue(input.name, '名称', 200),
    model = textValue(input.motorModel, '电机型号', 150)
  const code = input.code
    ? textValue(input.code, '项目编号', 50)
    : `NPI-${today().slice(0, 4)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
  const requiredKitDate = dateValue(input.requiredKitDate, '要求齐套日期')!,
    prototypeRequiredDate = dateValue(
      input.prototypeRequiredDate,
      '样机要求日期',
    )!
  if (requiredKitDate > prototypeRequiredDate)
    throw new NpiError('VALIDATION_ERROR', '要求齐套日期不得晚于样机要求日期')
  if (
    (
      await tx
        .select({ id: programs.id })
        .from(programs)
        .where(eq(programs.code, code))
    ).length
  )
    throw new NpiError('DUPLICATE_PROJECT_CODE', '项目编号已存在', 409)
  const profile = prepareProjectProfile(
    { customer: null, description: null, attributes: { npi: true } },
    input,
  )
  const [p] = await tx
    .insert(programs)
    .values({
      name,
      code,
      createdBy: actor.id,
      updatedBy: actor.id,
      targetEndDate: new Date(`${prototypeRequiredDate}T00:00:00+08:00`),
      attributes: { npi: true },
      ...profile.patch,
    })
    .returning()
  if (!p) throw new Error('Program creation failed')
  await tx.insert(programMembers).values(
    [...new Set([actor.id, tech.id, mfg.id])].map((memberId) => ({
      programId: p.id,
      userId: memberId,
      role: memberId === tech.id ? 'lead' : 'engineer',
      invitedBy: actor.id,
    })),
  )
  await tx.insert(s.npiProjects).values({
    programId: p.id,
    technicalOwnerId: tech.id,
    manufacturingOwnerId: mfg.id,
    motorModel: model,
    requiredKitDate,
    prototypeRequiredDate,
  })
  const [plan] = await tx
    .insert(s.npiManufacturingPlan)
    .values({ programId: p.id, updatedBy: actor.id })
    .returning()
  if (!plan) throw new Error('Plan creation failed')
  await tx.insert(s.npiTrackingItems).values(
    (Object.keys(nodeNames) as Array<NodeType>).map((type) => ({
      programId: p.id,
      manufacturingPlanId: plan.id,
      sourceType: 'MANUFACTURING',
      trackingType: type,
      name: nodeNames[type],
      ownerId: mfg.id,
      requiredDate:
        type === 'assembly' ? prototypeRequiredDate : requiredKitDate,
      affectsKit: type === 'process' || type === 'tooling',
    })),
  )
  await event(tx, actor, p.id, p.id, 'PROJECT_CREATED', {
    name,
    code,
    profile: profile.next,
  })
  return { id: p.id, code, status: 'Active', currentNpiStage: 'design' }
}
type TrackingRow = {
  item: Track
  ownerName: string | null
  bomImportId: string | null
  bomRow: Pick<BomRow, 'materialCode' | 'rowNo'> | null
  bomVersionNo: number | null
}
type ProjectIssueRow = {
  severity: string | null
  state: string
  targetDate: string
}
const trackingSelection = {
  item: s.npiTrackingItems,
  ownerName: users.name,
  bomImportId: s.npiBomItems.importId,
  bomRow: sql<Pick<
    BomRow,
    'materialCode' | 'rowNo'
  > | null>`case when ${s.npiBomItems.id} is null then null else jsonb_build_object('materialCode', ${s.npiBomItems.materialCode}, 'rowNo', ${s.npiBomItems.row}->'rowNo') end`,
  bomVersionNo: s.npiBomImports.versionNo,
}
function projectSnapshot(
  p: Project,
  rows: Array<TrackingRow>,
  changeCounts: Map<string, number>,
  issueRows: Array<ProjectIssueRow>,
  activeRowCount: number,
) {
  const items = rows.map(
    ({ item, ownerName, bomRow, bomVersionNo, bomImportId }) => ({
      ...item,
      bomReference:
        bomRow && bomVersionNo
          ? {
              materialCode: bomRow.materialCode,
              rowNo: bomRow.rowNo,
              versionNo: bomVersionNo,
              current: bomImportId === p.activeBomImportId,
            }
          : null,
      ownerName: ownerName || '未命名',
      status: itemStatus(item),
      changeCount: changeCounts.get(item.id) || 0,
    }),
  )
  const kit = kitStatus(
    items,
    p.requiredKitDate,
    items.find((i) => i.trackingType === 'kit')?.currentCommittedDate ?? null,
  )
  const needsReview = rows.filter(
    ({ item, bomImportId }) =>
      bomImportId &&
      bomImportId !== p.activeBomImportId &&
      !item.actualCompleteDate &&
      (item.trackingEnabled || item.affectsKit),
  )
  const bomReviewCount = needsReview.length
  if (bomReviewCount) {
    kit.alerts.push({
      code: 'BOM_REVIEW_PENDING',
      message: `BOM换版后有${bomReviewCount}项旧跟踪待复核，请进入BOM页关联新版或停止旧跟踪`,
    })
    if (needsReview.some(({ item }) => item.affectsKit))
      kit.predictionComplete = false
  }
  const openIssues = issueRows.filter(
    (i) => !['Closed', 'Cancelled'].includes(i.state),
  )
  const criticalIssueCount = openIssues.filter(
    (i) => i.severity === 'Critical',
  ).length
  const overdueIssueCount = openIssues.filter(
    (i) => i.targetDate < today(),
  ).length
  if (criticalIssueCount)
    kit.alerts.push({
      code: 'CRITICAL_ISSUE_OPEN',
      message: `有${criticalIssueCount}个重大项目问题尚未关闭，请进入项目问题查看`,
    })
  if (overdueIssueCount)
    kit.alerts.push({
      code: 'ISSUE_OVERDUE',
      message: `有${overdueIssueCount}个项目问题超过计划关闭日期`,
    })
  const riskStatus =
    p.currentNpiStage === 'completed'
      ? 'completed'
      : kit.overdueCount
        ? 'overdue'
        : kit.riskCount || kit.alerts.some((a) => a.code !== 'PENDING_REPLY')
          ? 'risk'
          : kit.pendingReplyCount
            ? 'pending_reply'
            : 'normal'
  return {
    items,
    kit,
    riskStatus,
    bomReviewCount,
    criticalIssueCount,
    overdueIssueCount,
    openIssueCount: openIssues.length,
    untrackedBomCount: Math.max(
      0,
      activeRowCount -
        new Set(
          rows
            .filter(
              ({ item, bomImportId }) =>
                bomImportId === p.activeBomImportId &&
                (item.trackingEnabled || item.affectsKit),
            )
            .map(({ item }) => item.bomItemId),
        ).size,
    ),
  }
}
const groupByProject = <T>(rows: Array<T>, key: (row: T) => string) => {
  const groups = new Map<string, Array<T>>()
  for (const row of rows) {
    const id = key(row)
    const group = groups.get(id)
    if (group) group.push(row)
    else groups.set(id, [row])
  }
  return groups
}
async function detailFor(tx: Tx | typeof db, p: Project) {
  const [program] = await tx
    .select()
    .from(programs)
    .where(eq(programs.id, p.programId))
  const rows = await tx
    .select(trackingSelection)
    .from(s.npiTrackingItems)
    .innerJoin(users, eq(users.id, s.npiTrackingItems.ownerId))
    .leftJoin(s.npiBomItems, eq(s.npiBomItems.id, s.npiTrackingItems.bomItemId))
    .leftJoin(s.npiBomImports, eq(s.npiBomImports.id, s.npiBomItems.importId))
    .where(eq(s.npiTrackingItems.programId, p.programId))
    .orderBy(asc(s.npiTrackingItems.createdAt), asc(s.npiTrackingItems.name))
  const history = await tx
    .select({ history: s.npiPromiseHistory, actorName: users.name })
    .from(s.npiPromiseHistory)
    .innerJoin(users, eq(users.id, s.npiPromiseHistory.changedBy))
    .where(eq(s.npiPromiseHistory.programId, p.programId))
    .orderBy(asc(s.npiPromiseHistory.changedAt))
  const changeCounts = promiseChangeCounts(history.map((h) => h.history))
  const imports = await tx
    .select({
      id: s.npiBomImports.id,
      versionNo: s.npiBomImports.versionNo,
      rowCount: s.npiBomImports.rowCount,
      maxLevel: s.npiBomImports.maxLevel,
      mother: s.npiBomImports.mother,
      sourceName: s.npiBomImports.sourceName,
      createdAt: s.npiBomImports.createdAt,
    })
    .from(s.npiBomImports)
    .where(eq(s.npiBomImports.programId, p.programId))
    .orderBy(desc(s.npiBomImports.versionNo))
  const [plan] = await tx
    .select()
    .from(s.npiManufacturingPlan)
    .where(eq(s.npiManufacturingPlan.programId, p.programId))
  const issueRows = await tx
    .select({
      severity: nativeIssues.severity,
      state: nativeItems.state,
      targetDate: s.npiIssueLinks.targetDate,
    })
    .from(s.npiIssueLinks)
    .innerJoin(nativeIssues, eq(nativeIssues.itemId, s.npiIssueLinks.itemId))
    .innerJoin(nativeItems, eq(nativeItems.id, nativeIssues.itemId))
    .where(eq(s.npiIssueLinks.programId, p.programId))
  const snapshot = projectSnapshot(
    p,
    rows,
    changeCounts,
    issueRows,
    imports.find((i) => i.id === p.activeBomImportId)?.rowCount || 0,
  )
  return {
    ...p,
    id: p.programId,
    name: program?.name ?? '',
    code: program?.code ?? '',
    profile: readProjectProfile(program),
    createdBy: program?.createdBy || null,
    ...snapshot,
    imports,
    plan,
    history: history.map((h) => ({ ...h.history, actorName: h.actorName })),
    events: await tx
      .select()
      .from(s.npiEvents)
      .where(eq(s.npiEvents.programId, p.programId))
      .orderBy(desc(s.npiEvents.createdAt))
      .limit(100),
  }
}
export async function projectDetail(userId: string, id: string) {
  return db.transaction(
    async (tx) => {
      const a = await getActor(userId, tx)
      return detailFor(tx, await loadProject(tx, id, a))
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
export async function dashboard(userId: string) {
  return db.transaction(
    async (tx) => {
      const actor = await getActor(userId, tx)
      if (actor.role === 'procurement') return denied()
      const visible = await tx
        .select()
        .from(s.npiProjects)
        .where(
          ['admin', 'supervisor'].includes(actor.role)
            ? undefined
            : or(
                eq(s.npiProjects.technicalOwnerId, actor.id),
                eq(s.npiProjects.manufacturingOwnerId, actor.id),
              ),
        )
      const ids = visible.map((p) => p.programId)
      const day = today(),
        { start, end } = businessDayRange(day)
      const programRows = ids.length
        ? await tx
            .select({
              id: programs.id,
              name: programs.name,
              code: programs.code,
            })
            .from(programs)
            .where(inArray(programs.id, ids))
        : []
      const trackingRows = ids.length
        ? await tx
            .select(trackingSelection)
            .from(s.npiTrackingItems)
            .innerJoin(users, eq(users.id, s.npiTrackingItems.ownerId))
            .leftJoin(
              s.npiBomItems,
              eq(s.npiBomItems.id, s.npiTrackingItems.bomItemId),
            )
            .leftJoin(
              s.npiBomImports,
              eq(s.npiBomImports.id, s.npiBomItems.importId),
            )
            .where(inArray(s.npiTrackingItems.programId, ids))
            .orderBy(
              asc(s.npiTrackingItems.createdAt),
              asc(s.npiTrackingItems.name),
            )
        : []
      const countRows = ids.length
        ? await tx
            .select({
              objectId: s.npiPromiseHistory.objectId,
              count: sql<number>`count(*)::int`,
            })
            .from(s.npiPromiseHistory)
            .innerJoin(users, eq(users.id, s.npiPromiseHistory.changedBy))
            .where(
              and(
                inArray(s.npiPromiseHistory.programId, ids),
                sql`${s.npiPromiseHistory.oldCommittedDate} is not null and ${s.npiPromiseHistory.oldCommittedDate} <> ${s.npiPromiseHistory.newCommittedDate}`,
              ),
            )
            .groupBy(s.npiPromiseHistory.objectId)
        : []
      const historyRows = ids.length
        ? await tx
            .select({ history: s.npiPromiseHistory, actorName: users.name })
            .from(s.npiPromiseHistory)
            .innerJoin(users, eq(users.id, s.npiPromiseHistory.changedBy))
            .where(
              and(
                inArray(s.npiPromiseHistory.programId, ids),
                gte(s.npiPromiseHistory.changedAt, start),
                lt(s.npiPromiseHistory.changedAt, end),
              ),
            )
            .orderBy(asc(s.npiPromiseHistory.changedAt))
        : []
      const importRows = ids.length
        ? await tx
            .select({
              programId: s.npiBomImports.programId,
              id: s.npiBomImports.id,
              versionNo: s.npiBomImports.versionNo,
              rowCount: s.npiBomImports.rowCount,
              sourceName: s.npiBomImports.sourceName,
            })
            .from(s.npiBomImports)
            .where(inArray(s.npiBomImports.programId, ids))
            .orderBy(desc(s.npiBomImports.versionNo))
        : []
      const issueRows = ids.length
        ? await tx
            .select({
              programId: s.npiIssueLinks.programId,
              severity: nativeIssues.severity,
              state: nativeItems.state,
              targetDate: s.npiIssueLinks.targetDate,
            })
            .from(s.npiIssueLinks)
            .innerJoin(
              nativeIssues,
              eq(nativeIssues.itemId, s.npiIssueLinks.itemId),
            )
            .innerJoin(nativeItems, eq(nativeItems.id, nativeIssues.itemId))
            .where(inArray(s.npiIssueLinks.programId, ids))
        : []
      const programMap = new Map(programRows.map((p) => [p.id, p]))
      const rowsByProject = groupByProject(
        trackingRows,
        (r) => r.item.programId,
      )
      const importsByProject = groupByProject(importRows, (r) => r.programId)
      const issuesByProject = groupByProject(issueRows, (r) => r.programId)
      const historyByProject = groupByProject(
        historyRows,
        (r) => r.history.programId,
      )
      const changeCounts = new Map(countRows.map((r) => [r.objectId, r.count]))
      const projects = visible.map((p) => {
        const program = programMap.get(p.programId)
        const imports = (importsByProject.get(p.programId) || []).map(
          ({ id, versionNo, rowCount, sourceName }) => ({
            id,
            versionNo,
            rowCount,
            sourceName,
          }),
        )
        return {
          ...p,
          id: p.programId,
          name: program?.name || '',
          code: program?.code || '',
          imports,
          ...projectSnapshot(
            p,
            rowsByProject.get(p.programId) || [],
            changeCounts,
            issuesByProject.get(p.programId) || [],
            imports.find((i) => i.id === p.activeBomImportId)?.rowCount || 0,
          ),
        }
      })
      const todayEvents = visible.length
        ? await tx
            .select({
              id: s.npiEvents.id,
              programId: s.npiEvents.programId,
              objectId: s.npiEvents.objectId,
              action: s.npiEvents.action,
              detail: s.npiEvents.detail,
              createdAt: s.npiEvents.createdAt,
              actorName: users.name,
            })
            .from(s.npiEvents)
            .innerJoin(users, eq(users.id, s.npiEvents.actorId))
            .where(
              and(
                inArray(
                  s.npiEvents.programId,
                  visible.map((p) => p.programId),
                ),
                inArray(s.npiEvents.action, [
                  'COMPLETED',
                  'TRACKING_CHANGED',
                  'BOM_TRACKING_RETIRED',
                ]),
                gte(s.npiEvents.createdAt, start),
                lt(s.npiEvents.createdAt, end),
              ),
            )
            .orderBy(asc(s.npiEvents.createdAt))
        : []

      const order = ['overdue', 'risk', 'pending_reply', 'normal', 'completed']
      projects.sort(
        (a, b) => order.indexOf(a.riskStatus) - order.indexOf(b.riskStatus),
      )
      const activityProjects = projects.map((p) => ({
        ...p,
        history: (historyByProject.get(p.id) || []).map((r) => ({
          ...r.history,
          actorName: r.actorName,
        })),
      }))
      return {
        projects,
        todayActivity: todayActivity(activityProjects, todayEvents, day),
        metrics: dashboardMetrics(projects, day),
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
export async function procurement(userId: string) {
  return personalMaterials(userId, false)
}
export async function assignedMaterials(userId: string) {
  return personalMaterials(userId, true)
}
async function personalMaterials(userId: string, assigned: boolean) {
  return db.transaction(
    async (tx) => {
      const actor = await getActor(userId, tx)
      if (assigned && !['technical', 'manufacturing'].includes(actor.role))
        return denied()
      const types = assigned ? ['material', 'other'] : ['purchase']
      const rows = await tx
        .select({
          item: s.npiTrackingItems,
          projectName: programs.name,
          projectCode: programs.code,
          currentNpiStage: s.npiProjects.currentNpiStage,
          activeBomImportId: s.npiProjects.activeBomImportId,
          bomImportId: s.npiBomItems.importId,
          bomRow: s.npiBomItems.row,
          bomVersionNo: s.npiBomImports.versionNo,
        })
        .from(s.npiTrackingItems)
        .innerJoin(programs, eq(programs.id, s.npiTrackingItems.programId))
        .innerJoin(s.npiProjects, eq(s.npiProjects.programId, programs.id))
        .leftJoin(
          s.npiBomItems,
          eq(s.npiBomItems.id, s.npiTrackingItems.bomItemId),
        )
        .leftJoin(
          s.npiBomImports,
          eq(s.npiBomImports.id, s.npiBomItems.importId),
        )
        .where(
          and(
            eq(s.npiTrackingItems.ownerId, actor.id),
            inArray(s.npiTrackingItems.trackingType, types),
          ),
        )
      const history = await tx
        .select({
          objectId: s.npiPromiseHistory.objectId,
          oldCommittedDate: s.npiPromiseHistory.oldCommittedDate,
          newCommittedDate: s.npiPromiseHistory.newCommittedDate,
        })
        .from(s.npiPromiseHistory)
        .innerJoin(
          s.npiTrackingItems,
          eq(s.npiTrackingItems.id, s.npiPromiseHistory.objectId),
        )
        .where(
          and(
            eq(s.npiTrackingItems.ownerId, actor.id),
            inArray(s.npiTrackingItems.trackingType, types),
          ),
        )
      const counts = promiseChangeCounts(history)
      return {
        actorId: actor.id,
        today: today(),
        items: rows
          .filter((r) => r.item.trackingEnabled || r.item.affectsKit)
          .map((r) => ({
            ...r.item,
            bomReference:
              r.bomRow && r.bomVersionNo
                ? {
                    materialCode: r.bomRow.materialCode,
                    rowNo: r.bomRow.rowNo,
                    versionNo: r.bomVersionNo,
                    current: r.bomImportId === r.activeBomImportId,
                  }
                : null,
            projectName: r.projectName,
            projectCode: r.projectCode,
            currentNpiStage: r.currentNpiStage,
            status: itemStatus(r.item),
            changeCount: counts.get(r.item.id) || 0,
          })),
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
export async function trackingHistory(userId: string, id: string) {
  return db.transaction(
    async (tx) => {
      const actor = await getActor(userId, tx)
      const [item] = await tx
        .select()
        .from(s.npiTrackingItems)
        .where(eq(s.npiTrackingItems.id, uuidValue(id)))
      if (!item)
        throw new NpiError('TRACKING_ITEM_NOT_FOUND', '跟踪项不存在', 404)
      if (actor.role === 'procurement') {
        if (item.trackingType !== 'purchase' || item.ownerId !== actor.id)
          return denied()
      } else if (!(
        item.ownerId === actor.id &&
        ['material', 'other'].includes(item.trackingType) &&
        ['technical', 'manufacturing'].includes(actor.role)
      ))
        await loadProject(tx, item.programId, actor)
      const [bom] = item.bomItemId
        ? await tx
            .select({
              row: s.npiBomItems.row,
              versionNo: s.npiBomImports.versionNo,
              importId: s.npiBomItems.importId,
              activeId: s.npiProjects.activeBomImportId,
            })
            .from(s.npiBomItems)
            .innerJoin(
              s.npiBomImports,
              eq(s.npiBomImports.id, s.npiBomItems.importId),
            )
            .innerJoin(
              s.npiProjects,
              eq(s.npiProjects.programId, s.npiBomImports.programId),
            )
            .where(
              and(
                eq(s.npiBomItems.id, item.bomItemId),
                eq(s.npiBomImports.programId, item.programId),
              ),
            )
        : []
      const records = await tx
        .select({ history: s.npiPromiseHistory, actorName: users.name })
        .from(s.npiPromiseHistory)
        .leftJoin(users, eq(users.id, s.npiPromiseHistory.changedBy))
        .where(
          and(
            eq(s.npiPromiseHistory.objectId, item.id),
            eq(s.npiPromiseHistory.programId, item.programId),
          ),
        )
        .orderBy(
          asc(s.npiPromiseHistory.changedAt),
          asc(s.npiPromiseHistory.id),
        )
      const history = records.map(({ history: h, actorName }) => ({
        id: h.id,
        oldCommittedDate: h.oldCommittedDate,
        newCommittedDate: h.newCommittedDate,
        reason: h.reason,
        changedAt: h.changedAt,
        actorName: actorName || '系统用户',
      }))
      return {
        item: {
          id: item.id,
          name: item.name,
          bomReference: bom
            ? {
                materialCode: bom.row.materialCode,
                rowNo: bom.row.rowNo,
                versionNo: bom.versionNo,
                current: bom.importId === bom.activeId,
              }
            : null,
          firstCommittedDate: item.firstCommittedDate,
          currentCommittedDate: item.currentCommittedDate,
          changeCount:
            promiseChangeCounts(records.map((r) => r.history)).get(item.id) ||
            0,
        },
        history,
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
export type TrackingHistory = Awaited<ReturnType<typeof trackingHistory>>

export async function addExternal(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true)
    await loadProject(tx, id, a, true)
    const type =
      input.trackingType === undefined ? 'purchase' : input.trackingType
    if (
      typeof type !== 'string' ||
      !['purchase', 'material', 'other'].includes(type)
    )
      throw new NpiError(
        'VALIDATION_ERROR',
        '物料类型须为BOM外采购件、临时样机件或其他物料',
      )
    const requestId =
      input.requestId === undefined
        ? undefined
        : uuidValue(input.requestId).toLowerCase()
    const values = {
      programId: id.toLowerCase(),
      sourceType: 'EXTERNAL' as const,
      trackingType: type,
      name: textValue(input.name, '物料名称'),
      specification: textValue(input.specification, '规格', 1000, true),
      qty: quantity(input.qty),
      unit: textValue(input.unit, '单位', 30, true),
      ownerId: uuidValue(input.ownerId).toLowerCase(),
      requiredDate: dateValue(input.requiredDate, '要求日期')!,
      affectsKit: flag(input.affectsKit),
      supplier: textValue(input.supplier, '供应商', 255, true),
      remark: textValue(input.remark, '备注', 2000, true),
    }
    const payloadHash = createHash('sha256')
      .update(JSON.stringify(values))
      .digest('hex')
    // loadProject(edit=true) holds the project lock for both lookup and insert.
    // The retry key belongs to this actor and project; identical new requests may still create new material.
    if (requestId) {
      const [existing] = await tx
        .select()
        .from(s.npiEvents)
        .where(
          and(
            eq(s.npiEvents.programId, id),
            eq(s.npiEvents.actorId, a.id),
            eq(s.npiEvents.action, 'EXTERNAL_CREATED'),
            sql`${s.npiEvents.detail}->>'requestId' = ${requestId}`,
          ),
        )
        .limit(1)
      if (existing) {
        if (
          (existing.detail as { payloadHash?: unknown }).payloadHash !==
          payloadHash
        )
          throw new NpiError(
            'VERSION_CONFLICT',
            '此提交编号已用于不同的物料内容，请核对原记录',
            409,
          )
        const [saved] = await tx
          .select()
          .from(s.npiTrackingItems)
          .where(
            and(
              eq(s.npiTrackingItems.id, existing.objectId),
              eq(s.npiTrackingItems.programId, id),
              eq(s.npiTrackingItems.sourceType, 'EXTERNAL'),
            ),
          )
          .limit(1)
        if (!saved)
          throw new NpiError(
            'VERSION_CONFLICT',
            '原物料记录不可用，请联系项目负责人核对，勿重新创建',
            409,
          )
        return { ...saved, status: itemStatus(saved) }
      }
    }
    await owner(
      tx,
      values.ownerId,
      type === 'purchase' ? ['procurement'] : ['manufacturing', 'technical'],
    )
    const [item] = await tx
      .insert(s.npiTrackingItems)
      .values(values)
      .returning()
    if (!item) throw new Error('Item creation failed')
    await event(tx, a, id, item.id, 'EXTERNAL_CREATED', {
      name: item.name,
      ownerId: item.ownerId,
      trackingType: item.trackingType,
      ...(requestId ? { requestId, payloadHash } : {}),
    })
    return { ...item, status: itemStatus(item) }
  })
}
async function editableItem(
  tx: Tx,
  userId: string,
  itemId: string,
  allowCompletionRetry = false,
) {
  const a = await getActor(userId, tx, true)
  uuidValue(itemId)
  const [lookup] = await tx
    .select()
    .from(s.npiTrackingItems)
    .where(eq(s.npiTrackingItems.id, itemId))
  if (!lookup)
    throw new NpiError('TRACKING_ITEM_NOT_FOUND', '跟踪项不存在', 404)
  const [p] = await tx
    .select()
    .from(s.npiProjects)
    .where(eq(s.npiProjects.programId, lookup.programId))
    .for('update')
  if (!p) throw new NpiError('PROGRAM_NOT_FOUND', '项目不存在', 404)
  const [item] = await tx
    .select()
    .from(s.npiTrackingItems)
    .where(eq(s.npiTrackingItems.id, itemId))
    .for('update')
  if (!item) throw new NpiError('TRACKING_ITEM_NOT_FOUND', '跟踪项不存在', 404)
  if (!(
    a.role === 'admin' ||
    (item.ownerId === a.id &&
      (item.trackingType === 'purchase'
        ? a.role === 'procurement'
        : ['manufacturing', 'technical'].includes(a.role)))
  ))
    return denied()
  if (!item.trackingEnabled && !item.affectsKit)
    throw new NpiError(
      'INVALID_STATE_TRANSITION',
      '已停止跟踪，请联系项目负责人复核',
      400,
    )
  if (p.currentNpiStage === 'completed' && !allowCompletionRetry)
    throw new NpiError('INVALID_STATE_TRANSITION', '已完成项目为只读', 400)
  return { a, item, p }
}
async function writePromise(
  tx: Tx,
  a: Actor,
  item: Track,
  input: Record<string, unknown>,
) {
  const change = promiseChange(item, {
    committedDate: input.committedDate,
    reason: input.reason,
    expectedVersion: input.expectedVersion,
  })
  if (!change) {
    const supplier =
      input.supplier === undefined
        ? item.supplier
        : textValue(input.supplier, '供应商', 255, true)
    const remark =
      input.remark === undefined
        ? item.remark
        : textValue(input.remark, '备注', 2000, true)
    if (supplier === item.supplier && remark === item.remark) return item
    if (item.actualCompleteDate)
      throw new NpiError('INVALID_STATE_TRANSITION', '已完成项不能修改', 400)
    const [updatedDetails] = await tx
      .update(s.npiTrackingItems)
      .set({ supplier, remark, version: item.version + 1 })
      .where(eq(s.npiTrackingItems.id, item.id))
      .returning()
    if (!updatedDetails) throw new Error('Item update failed')
    await event(tx, a, item.programId, item.id, 'DETAILS_UPDATED', {
      before: { supplier: item.supplier, remark: item.remark },
      after: { supplier, remark },
    })
    return updatedDetails
  }
  const [updated] = await tx
    .update(s.npiTrackingItems)
    .set({
      firstCommittedDate: change.firstCommittedDate,
      currentCommittedDate: change.currentCommittedDate,
      version: item.version + 1,
      supplier:
        input.supplier === undefined
          ? item.supplier
          : textValue(input.supplier, '供应商', 255, true),
      remark:
        input.remark === undefined
          ? item.remark
          : textValue(input.remark, '备注', 2000, true),
    })
    .where(eq(s.npiTrackingItems.id, item.id))
    .returning()
  await tx.insert(s.npiPromiseHistory).values({
    programId: item.programId,
    objectId: item.id,
    objectType:
      item.sourceType === 'MANUFACTURING'
        ? 'MANUFACTURING_NODE'
        : 'TRACKING_ITEM',
    oldCommittedDate: change.oldCommittedDate,
    newCommittedDate: change.currentCommittedDate,
    reason: change.reason,
    changedBy: a.id,
  })
  await event(tx, a, item.programId, item.id, 'PROMISE_CHANGED', change)
  return updated!
}
export async function updatePromise(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const { a, item } = await editableItem(tx, userId, id)
    const result = await writePromise(tx, a, item, input)
    if (result.version !== item.version && item.manufacturingPlanId)
      await tx
        .update(s.npiManufacturingPlan)
        .set({
          version: sql`${s.npiManufacturingPlan.version} + 1`,
          updatedBy: a.id,
        })
        .where(eq(s.npiManufacturingPlan.id, item.manufacturingPlanId))
    const history = await tx
      .select({
        objectId: s.npiPromiseHistory.objectId,
        oldCommittedDate: s.npiPromiseHistory.oldCommittedDate,
        newCommittedDate: s.npiPromiseHistory.newCommittedDate,
      })
      .from(s.npiPromiseHistory)
      .where(
        and(
          eq(s.npiPromiseHistory.objectId, item.id),
          eq(s.npiPromiseHistory.programId, item.programId),
        ),
      )
    return {
      ...result,
      status: itemStatus(result),
      changeCount: promiseChangeCounts(history).get(item.id) || 0,
    }
  })
}
async function managedTracking(
  tx: Tx,
  userId: string,
  id: string,
  edit: true | 'plan' = true,
) {
  const a = await getActor(userId, tx, true)
  uuidValue(id)
  const [lookup] = await tx
    .select()
    .from(s.npiTrackingItems)
    .where(eq(s.npiTrackingItems.id, id))
  if (!lookup)
    throw new NpiError('TRACKING_ITEM_NOT_FOUND', '跟踪项不存在', 404)
  const p = await loadProject(tx, lookup.programId, a, edit)
  const [item] = await tx
    .select()
    .from(s.npiTrackingItems)
    .where(eq(s.npiTrackingItems.id, id))
    .for('update')
  if (!item) throw new NpiError('TRACKING_ITEM_NOT_FOUND', '跟踪项不存在', 404)
  if (!item.trackingEnabled && !item.affectsKit)
    throw new NpiError(
      'INVALID_STATE_TRANSITION',
      '已停止跟踪，请先进行换版复核',
      400,
    )
  return { a, p, item }
}
const adjustmentReason = (input: Record<string, unknown>) => {
  const reason = textValue(input.reason, '调整原因', 2000, true)
  if (!reason)
    throw new NpiError('ADJUSTMENT_REASON_REQUIRED', '调整必须填写原因', 400)
  return reason
}
async function advancePlan(tx: Tx, item: Track, a: Actor) {
  if (item.manufacturingPlanId)
    await tx
      .update(s.npiManufacturingPlan)
      .set({
        version: sql`${s.npiManufacturingPlan.version} + 1`,
        updatedBy: a.id,
      })
      .where(eq(s.npiManufacturingPlan.id, item.manufacturingPlanId))
}
export async function adjustTrackingPlan(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const { a, p, item } = await managedTracking(tx, userId, id, 'plan')
    versionCheck(item.version, input.expectedVersion)
    const reason = adjustmentReason(input)
    if (item.actualCompleteDate)
      throw new NpiError(
        'INVALID_STATE_TRANSITION',
        '已完成项不可调整计划，请使用实际日期更正',
        400,
      )
    const requiredDate =
      input.requiredDate === undefined
        ? item.requiredDate
        : dateValue(input.requiredDate, '要求日期')!
    const nextOwnerId =
      input.ownerId === undefined ? item.ownerId : uuidValue(input.ownerId)
    if (
      item.sourceType === 'MANUFACTURING' &&
      nextOwnerId !== p.manufacturingOwnerId
    )
      throw new NpiError(
        'VALIDATION_ERROR',
        '制造四节点须由项目制造负责人统一负责',
      )
    const nextOwner =
      nextOwnerId === item.ownerId
        ? null
        : await owner(
            tx,
            nextOwnerId,
            item.trackingType === 'purchase'
              ? ['procurement']
              : ['technical', 'manufacturing'],
          )
    if (requiredDate === item.requiredDate && nextOwnerId === item.ownerId)
      return { ...item, status: itemStatus(item) }
    const [previousOwner] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, item.ownerId))
    const [updated] = await tx
      .update(s.npiTrackingItems)
      .set({ requiredDate, ownerId: nextOwnerId, version: item.version + 1 })
      .where(eq(s.npiTrackingItems.id, item.id))
      .returning()
    await advancePlan(tx, item, a)
    await event(tx, a, item.programId, item.id, 'TRACKING_PLAN_ADJUSTED', {
      reason,
      actorName: a.name,
      itemName: item.name,
      before: {
        requiredDate: item.requiredDate,
        ownerId: item.ownerId,
        ownerName: previousOwner?.name || item.ownerId,
      },
      after: {
        requiredDate,
        ownerId: nextOwnerId,
        ownerName: nextOwner?.name || previousOwner?.name || nextOwnerId,
      },
    })
    return { ...updated!, status: itemStatus(updated!) }
  })
}
export async function correctCompletion(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const { a, item } = await managedTracking(tx, userId, id)
    versionCheck(item.version, input.expectedVersion)
    const reason = adjustmentReason(input)
    if (!item.actualCompleteDate)
      throw new NpiError(
        'INVALID_STATE_TRANSITION',
        '尚未确认完成，请先由责任人确认完成',
        400,
      )
    const actualCompleteDate = dateValue(
      input.actualCompleteDate,
      '实际完成日期',
    )!
    if (actualCompleteDate > today())
      throw new NpiError('VALIDATION_ERROR', '实际完成日期不能在未来')
    if (actualCompleteDate === item.actualCompleteDate)
      return { ...item, status: itemStatus(item) }
    const [updated] = await tx
      .update(s.npiTrackingItems)
      .set({ actualCompleteDate, version: item.version + 1 })
      .where(eq(s.npiTrackingItems.id, item.id))
      .returning()
    await advancePlan(tx, item, a)
    await event(tx, a, item.programId, item.id, 'COMPLETION_CORRECTED', {
      reason,
      actorName: a.name,
      itemName: item.name,
      before: { actualCompleteDate: item.actualCompleteDate },
      after: { actualCompleteDate },
    })
    return { ...updated!, status: itemStatus(updated!) }
  })
}
async function writeCompletion(
  tx: Tx,
  a: Actor,
  item: Track,
  p: Project,
  input: Record<string, unknown>,
) {
  const date = dateValue(input.actualCompleteDate, '实际完成日期')!
  if (date > today())
    throw new NpiError('VALIDATION_ERROR', '实际完成日期不能在未来')
  if (item.actualCompleteDate === date) return { ...item, status: 'completed' }
  if (p.currentNpiStage === 'completed')
    throw new NpiError('INVALID_STATE_TRANSITION', '已完成项目为只读', 400)
  if (item.actualCompleteDate)
    throw new NpiError(
      'INVALID_STATE_TRANSITION',
      '已完成项不能重复改写实际日期',
      400,
    )
  versionCheck(item.version, input.expectedVersion)
  const [result] = await tx
    .update(s.npiTrackingItems)
    .set({
      actualCompleteDate: date,
      version: item.version + 1,
      remark:
        input.remark === undefined
          ? item.remark
          : textValue(input.remark, '备注', 2000, true),
    })
    .where(eq(s.npiTrackingItems.id, item.id))
    .returning()
  await event(tx, a, item.programId, item.id, 'COMPLETED', {
    actualCompleteDate: date,
    remark: input.remark,
  })
  return { ...result!, status: 'completed' }
}
export async function completeItem(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const { a, item, p } = await editableItem(tx, userId, id, true)
    const result = await writeCompletion(tx, a, item, p, input)
    if (result.version !== item.version && item.manufacturingPlanId)
      await tx
        .update(s.npiManufacturingPlan)
        .set({
          version: sql`${s.npiManufacturingPlan.version} + 1`,
          updatedBy: a.id,
        })
        .where(eq(s.npiManufacturingPlan.id, item.manufacturingPlanId))
    return { ...result, status: 'completed' }
  })
}
export async function manufacturingPlan(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true)
    const p = await loadProject(tx, id, a, true)
    if (a.role !== 'admin' && a.id !== p.manufacturingOwnerId) return denied()
    const [plan] = await tx
      .select()
      .from(s.npiManufacturingPlan)
      .where(eq(s.npiManufacturingPlan.programId, id))
      .for('update')
    if (!plan) throw new Error('Missing manufacturing plan')
    versionCheck(plan.version, input.expectedVersion)
    const items = await tx
      .select()
      .from(s.npiTrackingItems)
      .where(eq(s.npiTrackingItems.manufacturingPlanId, plan.id))
    const reasons = (input.changeReasons ?? {}) as Record<string, unknown>
    let changed = false
    for (const item of items) {
      const key = `${item.trackingType}Committed`
      if (input[key] !== undefined && input[key] !== '') {
        const next = await writePromise(tx, a, item, {
          committedDate: input[key],
          reason: reasons[key],
          expectedVersion: item.version,
        })
        changed ||= next.version !== item.version
      }
      const requiredKey = `${item.trackingType}Required`
      if (input[requiredKey] !== undefined) {
        const required = dateValue(input[requiredKey], '要求日期')!
        if (required !== item.requiredDate) {
          if (item.actualCompleteDate)
            throw new NpiError(
              'INVALID_STATE_TRANSITION',
              '已完成节点不能调整要求日期',
              400,
            )
          const requiredReason = adjustmentReason({
            reason: reasons[requiredKey],
          })
          await tx
            .update(s.npiTrackingItems)
            .set({
              requiredDate: required,
              version: sql`${s.npiTrackingItems.version} + 1`,
            })
            .where(eq(s.npiTrackingItems.id, item.id))
          await event(tx, a, id, item.id, 'TRACKING_PLAN_ADJUSTED', {
            reason: requiredReason,
            actorName: a.name,
            itemName: item.name,
            before: { requiredDate: item.requiredDate },
            after: { requiredDate: required },
          })
          changed = true
        }
      }
    }
    if (changed) {
      await tx
        .update(s.npiManufacturingPlan)
        .set({ version: plan.version + 1, updatedBy: a.id })
        .where(eq(s.npiManufacturingPlan.id, plan.id))
      await event(tx, a, id, plan.id, 'MANUFACTURING_PLAN_REPLIED', {
        version: plan.version + 1,
      })
    }
    return { version: changed ? plan.version + 1 : plan.version }
  })
}
// A project lock serializes single-node edits, stage changes and this batch.
export async function completeManufacturing(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true)
    const p = await loadProject(tx, id, a, true)
    if (a.role !== 'admin' && a.id !== p.manufacturingOwnerId) return denied()
    const [plan] = await tx
      .select()
      .from(s.npiManufacturingPlan)
      .where(eq(s.npiManufacturingPlan.programId, id))
      .for('update')
    if (!plan) throw new Error('Missing manufacturing plan')
    versionCheck(plan.version, input.expectedVersion)
    const dates = input.actualDates
    if (!dates || typeof dates !== 'object' || Array.isArray(dates))
      throw new NpiError('VALIDATION_ERROR', '请选择需要确认的制造节点日期')
    const entries = Object.entries(dates)
    if (
      !entries.length ||
      entries.some(([key]) => !Object.hasOwn(nodeNames, key))
    )
      throw new NpiError('VALIDATION_ERROR', '制造节点无效或未选择')
    const items = await tx
      .select()
      .from(s.npiTrackingItems)
      .where(eq(s.npiTrackingItems.manufacturingPlanId, plan.id))
      .for('update')
    const completedIds: Array<string> = []
    for (const [key, date] of entries) {
      const item = items.find(
        (i) => i.trackingType === key && i.sourceType === 'MANUFACTURING',
      )
      if (!item || !item.trackingEnabled)
        throw new NpiError('INVALID_STATE_TRANSITION', '制造节点不可确认', 400)
      const result = await writeCompletion(tx, a, item, p, {
        actualCompleteDate: date,
        expectedVersion: item.version,
      })
      if (result.version !== item.version) completedIds.push(item.id)
    }
    if (completedIds.length) {
      await tx
        .update(s.npiManufacturingPlan)
        .set({ version: plan.version + 1, updatedBy: a.id })
        .where(eq(s.npiManufacturingPlan.id, plan.id))
      await event(tx, a, id, plan.id, 'MANUFACTURING_COMPLETED', {
        completedIds,
      })
    }
    return {
      version: plan.version + (completedIds.length ? 1 : 0),
      completedIds,
    }
  })
}
export async function changeStage(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true),
      p = await loadProject(tx, id, a, true)
    versionCheck(p.version, input.expectedVersion)
    const next = input.currentNpiStage as NpiStage
    if (stages.indexOf(next) !== stages.indexOf(p.currentNpiStage) + 1)
      throw new NpiError('INVALID_STATE_TRANSITION', '请按五阶段顺序推进', 400)
    const changes: Partial<Project> = {
      currentNpiStage: next,
      version: p.version + 1,
    }
    if (next === 'manufacturing') {
      changes.drawingCompleteDate = dateValue(
        input.drawingCompleteDate,
        '图纸完成日期',
      )
      if (changes.drawingCompleteDate! > today())
        throw new NpiError('VALIDATION_ERROR', '图纸完成日期不能在未来')
    }
    if (next === 'completed') {
      const unfinished = await tx
        .select()
        .from(s.npiTrackingItems)
        .where(eq(s.npiTrackingItems.programId, id))
      if (
        unfinished.some(
          (i) =>
            (i.affectsKit || i.sourceType === 'MANUFACTURING') &&
            !i.actualCompleteDate,
        )
      )
        throw new NpiError(
          'INVALID_STATE_TRANSITION',
          '制造四节点及影响齐套的项目须先确认完成',
          400,
        )
      await tx
        .update(programs)
        .set({ status: 'Completed', updatedBy: a.id, updatedAt: new Date() })
        .where(eq(programs.id, id))
    }
    await tx
      .update(s.npiProjects)
      .set(changes)
      .where(eq(s.npiProjects.programId, id))
    await event(tx, a, id, id, 'STAGE_CHANGED', {
      from: p.currentNpiStage,
      to: next,
    })
    return changes
  })
}
export async function createPreview(
  userId: string,
  id: string,
  file: File,
  templateId?: string,
  motherConfirmation?: unknown,
) {
  const a = await getActor(userId)
  const p = await loadProject(db, id, a)
  if (
    !['admin', 'technical'].includes(a.role) ||
    (a.role !== 'admin' && a.id !== p.technicalOwnerId)
  )
    return denied()
  if (!/\.xlsx$/i.test(file.name) || file.size > 5 * 1024 * 1024)
    throw new NpiError('INVALID_BOM_FORMAT', '请上传5MB以内的xlsx文件', 400)
  const templates = await db
    .select()
    .from(s.npiImportTemplates)
    .where(eq(s.npiImportTemplates.enabled, true))
  const bytes = Buffer.from(await file.arrayBuffer())
  const parsed = await previewExcel(
    bytes,
    templates.map((t) => t.config),
    templateId,
  )
  const preview = confirmMother(parsed, motherConfirmation, a)
  if (preview.summary.errors) return { ...preview, previewToken: null }
  const [record] = await db
    .insert(s.npiBomPreviews)
    .values({
      programId: id,
      userId,
      projectVersion: p.version,
      templateId: preview.templateId,
      preview,
      sourceName: file.name,
      sourceBase64: bytes.toString('base64'),
      sourceHash: createHash('sha256').update(bytes).digest('hex'),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    })
    .returning({ id: s.npiBomPreviews.id })
  return { ...preview, previewToken: record!.id }
}
export async function confirmImport(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true)
    const p = await loadProject(tx, id, a, true)
    if (
      a.role !== 'admin' &&
      (a.role !== 'technical' || a.id !== p.technicalOwnerId)
    )
      return denied()
    const [preview] = await tx
      .select()
      .from(s.npiBomPreviews)
      .where(eq(s.npiBomPreviews.id, uuidValue(input.previewToken)))
      .for('update')
    if (!preview || preview.programId !== id || preview.userId !== a.id)
      return denied()
    if (preview.savedAt || preview.discardedAt)
      throw new NpiError(
        'BOM_VERSION_CONFLICT',
        '请从草稿列表重新恢复预览',
        409,
      )
    if (preview.draftSourceId) {
      const [draft] = await tx
        .select()
        .from(s.npiBomPreviews)
        .where(eq(s.npiBomPreviews.id, preview.draftSourceId))
        .for('update')
      if (
        !draft ||
        draft.programId !== id ||
        draft.userId !== a.id ||
        !draft.savedAt ||
        draft.discardedAt ||
        draft.consumedImportId
      )
        throw new NpiError(
          'BOM_VERSION_CONFLICT',
          '草稿已移除或已导入，请刷新列表',
          409,
        )
    }
    if (preview.consumedImportId)
      throw new NpiError(
        'BOM_VERSION_CONFLICT',
        '此预览已导入，请查看导入记录',
        409,
      )
    if (preview.expiresAt.getTime() < Date.now())
      throw new NpiError('BOM_VERSION_CONFLICT', '预览已过期，请重新上传', 409)
    versionCheck(p.version, preview.projectVersion, 'BOM_VERSION_CONFLICT')
    const errors = preview.preview.validation.filter(
      (entry) => entry.severity === 'ERROR',
    )
    if (preview.preview.summary.errors || errors.length) {
      const levelError = errors.find(
        (entry) => entry.code === 'INVALID_LEVEL_SEQUENCE',
      )
      const error = levelError ?? errors[0]
      throw new NpiError(
        levelError ? 'INVALID_LEVEL_SEQUENCE' : 'INVALID_BOM_FORMAT',
        error
          ? `BOM${error.rowNo ? `第${error.rowNo}行` : ''}：${error.message}；请修正文件后重新预览`
          : '预览有错误，不能导入',
        400,
      )
    }
    const [template] = await tx
      .select()
      .from(s.npiImportTemplates)
      .where(eq(s.npiImportTemplates.id, preview.templateId))
    if (!template?.enabled)
      throw new NpiError('INVALID_BOM_FORMAT', '模板已停用，请重新预览', 400)
    const [last] = await tx
      .select({ version: s.npiBomImports.versionNo })
      .from(s.npiBomImports)
      .where(eq(s.npiBomImports.programId, id))
      .orderBy(desc(s.npiBomImports.versionNo))
      .limit(1)
    const [record] = await tx
      .insert(s.npiBomImports)
      .values({
        programId: id,
        versionNo: (last?.version ?? 0) + 1,
        templateId: preview.templateId,
        mother: preview.preview.mother,
        sheetName: preview.preview.sheetName,
        rowCount: preview.preview.summary.rows,
        maxLevel: preview.preview.summary.maxLevel,
        sourceName: preview.sourceName,
        sourceBase64: preview.sourceBase64,
        sourceHash: preview.sourceHash,
        templateSnapshot: preview.preview.templateSnapshot ?? template.config,
        importedBy: a.id,
      })
      .returning({
        id: s.npiBomImports.id,
        versionNo: s.npiBomImports.versionNo,
      })
    if (!record) throw new Error('Import failed')
    for (let i = 0; i < preview.preview.previewRows.length; i += 100)
      await tx.insert(s.npiBomItems).values(
        preview.preview.previewRows.slice(i, i + 100).map((row) => ({
          id: row.id,
          importId: record.id,
          parentId: row.parentId,
          level: row.level,
          materialCode: row.materialCode,
          row,
        })),
      )
    const active = flag(input.activate)
    await tx
      .update(s.npiProjects)
      .set({
        ...(active ? { activeBomImportId: record.id } : {}),
        version: p.version + 1,
      })
      .where(eq(s.npiProjects.programId, id))
    await tx
      .update(s.npiBomPreviews)
      .set({ consumedImportId: record.id, sourceBase64: '' })
      .where(eq(s.npiBomPreviews.id, preview.id))
    if (preview.draftSourceId)
      await tx
        .update(s.npiBomPreviews)
        .set({ consumedImportId: record.id, sourceBase64: '' })
        .where(eq(s.npiBomPreviews.id, preview.draftSourceId))
    await event(tx, a, id, record.id, 'BOM_IMPORTED', {
      versionNo: record.versionNo,
      sourceName: preview.sourceName,
      rowCount: preview.preview.summary.rows,
      ...(preview.preview.motherConfirmation
        ? { motherConfirmation: preview.preview.motherConfirmation }
        : {}),
    })
    return {
      importId: record.id,
      versionNo: record.versionNo,
      rowCount: preview.preview.summary.rows,
      maxLevel: preview.preview.summary.maxLevel,
      active,
    }
  })
}
export async function getBom(
  userId: string,
  id: string,
  importId?: string,
  trackingOnly = false,
) {
  return db.transaction(
    async (tx) => {
      const a = await getActor(userId, tx),
        p = await loadProject(tx, id, a)
      const target = importId ? uuidValue(importId) : p.activeBomImportId
      if (!target)
        return { nodes: [], rows: [], importId: null, versionNo: null }
      const [record] = await tx
        .select({
          id: s.npiBomImports.id,
          versionNo: s.npiBomImports.versionNo,
        })
        .from(s.npiBomImports)
        .where(
          and(
            eq(s.npiBomImports.id, target),
            eq(s.npiBomImports.programId, id),
          ),
        )
      if (!record)
        throw new NpiError('BOM_NOT_FOUND', '未找到此项目的BOM版本', 404)
      const entries = await tx
        .select({
          row: s.npiBomItems.row,
          trackingEnabled: s.npiTrackingItems.trackingEnabled,
          affectsKit: s.npiTrackingItems.affectsKit,
        })
        .from(s.npiBomItems)
        .leftJoin(
          s.npiTrackingItems,
          and(
            eq(s.npiTrackingItems.bomItemId, s.npiBomItems.id),
            eq(s.npiTrackingItems.programId, id),
          ),
        )
        .where(eq(s.npiBomItems.importId, target))
      const allRows = entries
        .map(({ row, trackingEnabled, affectsKit }) => ({
          ...row,
          trackingEnabled: trackingEnabled ?? false,
          affectsKit: affectsKit ?? false,
        }))
        .sort((left, right) => left.rowNo - right.rowNo)
      let rows = allRows
      if (trackingOnly) {
        const byId = new Map(allRows.map((row) => [row.id, row])),
          retained = new Set<string>()
        // Keep context ancestors, never unrelated siblings or descendants.
        // Shared ancestors are visited once; their own flags remain unchanged.
        for (const row of allRows) {
          if (!row.trackingEnabled) continue
          let current: (typeof allRows)[number] | undefined = row
          while (current && !retained.has(current.id)) {
            retained.add(current.id)
            current = current.parentId ? byId.get(current.parentId) : undefined
          }
        }
        rows = allRows.filter((row) => retained.has(row.id))
      }
      return {
        importId: target,
        versionNo: record.versionNo,
        nodes: bomTree(rows),
        rows,
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
export async function getDiff(
  userId: string,
  id: string,
  before: string,
  after: string,
) {
  const old = await getBom(userId, id, before),
    next = await getBom(userId, id, after)
  return bomDiff(old.rows, next.rows)
}
// A review is derived from the active baseline and immutable old BOM rows.
// Nothing is reassigned until a technical owner explicitly confirms it.
async function reconciliationFor(tx: Tx | typeof db, p: Project) {
  const entries = await tx
    .select({ bom: s.npiBomItems })
    .from(s.npiBomItems)
    .innerJoin(s.npiBomImports, eq(s.npiBomImports.id, s.npiBomItems.importId))
    .where(eq(s.npiBomImports.programId, p.programId))
  const byId = new Map(entries.map(({ bom }) => [bom.id, bom]))
  const groups = new Map<string, Array<BomRow>>()
  for (const { bom } of entries) {
    const group = groups.get(bom.importId) || []
    group.push(bom.row)
    groups.set(bom.importId, group)
  }
  const active = groups.get(p.activeBomImportId || '') || []
  const groupLocations = new Map(
    [...groups].map(([id, rows]) => [id, bomLocations(rows)]),
  )
  const locations = groupLocations.get(p.activeBomImportId || '') || new Map()
  const tracks = await tx
    .select()
    .from(s.npiTrackingItems)
    .where(eq(s.npiTrackingItems.programId, p.programId))
  const occupied = new Set(tracks.map((t) => t.bomItemId).filter(Boolean))
  const diffs = new Map(
    [...groups].map(([id, rows]) => [id, bomDiff(rows, active)]),
  )
  const items = tracks
    .filter((t) => {
      const old = t.bomItemId ? byId.get(t.bomItemId) : undefined
      return (
        old &&
        old.importId !== p.activeBomImportId &&
        !t.actualCompleteDate &&
        (t.trackingEnabled || t.affectsKit)
      )
    })
    .map((item) => {
      const old = byId.get(item.bomItemId!)!
      const match = diffs
        .get(old.importId)!
        .find((d) => d.before?.id === old.id && d.after)
      const candidates = active
        .filter((row) => row.materialCode === old.materialCode)
        .map((row) => ({
          id: row.id,
          name: row.materialName,
          qty: row.qty,
          unit: row.unit,
          specification: row.specification,
          path: locations.get(row.id)!.label,
          occupied: occupied.has(row.id),
        }))
      return {
        item,
        oldRow: old.row,
        oldPath: groupLocations.get(old.importId)!.get(old.id)!.label,
        suggestedId:
          match?.after && !occupied.has(match.after.id) ? match.after.id : null,
        changeType:
          match?.type ?? (candidates.length ? 'AMBIGUOUS' : 'REMOVED'),
        candidates,
      }
    })
  return {
    projectVersion: p.version,
    activeImportId: p.activeBomImportId,
    items,
  }
}
export async function getReconciliation(userId: string, id: string) {
  return db.transaction(
    async (tx) => {
      const a = await getActor(userId, tx)
      return reconciliationFor(tx, await loadProject(tx, id, a))
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
export async function reconcileTracking(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true)
    const p = await loadProject(tx, id, a, true)
    if (
      a.role !== 'admin' &&
      (a.role !== 'technical' || a.id !== p.technicalOwnerId)
    )
      return denied()
    versionCheck(
      p.version,
      input.expectedProjectVersion,
      'BOM_VERSION_CONFLICT',
    )
    if (input.activeImportId !== p.activeBomImportId)
      throw new NpiError(
        'BOM_VERSION_CONFLICT',
        '当前BOM已变化，请刷新复核列表',
        409,
      )
    const [item] = await tx
      .select()
      .from(s.npiTrackingItems)
      .where(
        and(
          eq(s.npiTrackingItems.id, uuidValue(input.trackingItemId)),
          eq(s.npiTrackingItems.programId, id),
        ),
      )
      .for('update')
    if (!item || !item.bomItemId)
      throw new NpiError('BOM_NOT_FOUND', '未找到此项目的BOM跟踪项', 404)
    versionCheck(item.version, input.expectedVersion)
    const [old] = await tx
      .select()
      .from(s.npiBomItems)
      .where(eq(s.npiBomItems.id, item.bomItemId))
    if (
      !old ||
      old.importId === p.activeBomImportId ||
      item.actualCompleteDate ||
      (!item.trackingEnabled && !item.affectsKit)
    )
      throw new NpiError(
        'INVALID_STATE_TRANSITION',
        '此项无需换版复核，请刷新列表',
        409,
      )
    const reason = textValue(input.reason, '换版复核原因', 2000)
    let patch: Partial<Track>, action: string
    if (input.action === 'retire') {
      patch = { trackingEnabled: false, affectsKit: false }
      action = 'BOM_TRACKING_RETIRED'
    } else if (input.action === 'migrate') {
      const [target] = await tx
        .select()
        .from(s.npiBomItems)
        .where(eq(s.npiBomItems.id, uuidValue(input.targetBomItemId)))
      if (
        !target ||
        target.importId !== p.activeBomImportId ||
        target.materialCode !== old.materialCode
      )
        throw new NpiError(
          'BOM_VERSION_CONFLICT',
          '只能关联当前BOM中相同物料编码的位置',
          409,
        )
      const [used] = await tx
        .select({ id: s.npiTrackingItems.id })
        .from(s.npiTrackingItems)
        .where(eq(s.npiTrackingItems.bomItemId, target.id))
      if (used)
        throw new NpiError(
          'BOM_VERSION_CONFLICT',
          '目标位置已有跟踪项，请核对，不能覆盖其历史',
          409,
        )
      patch = {
        bomItemId: target.id,
        name: target.row.materialName,
        specification: target.row.specification,
        qty: target.row.qty,
        unit: target.row.unit,
      }
      action = 'BOM_TRACKING_MIGRATED'
    } else throw new NpiError('VALIDATION_ERROR', '请选择关联新版或停止跟踪')
    const [result] = await tx
      .update(s.npiTrackingItems)
      .set({ ...patch, version: item.version + 1 })
      .where(eq(s.npiTrackingItems.id, item.id))
      .returning()
    await event(tx, a, id, item.id, action, {
      reason,
      activeImportId: p.activeBomImportId,
      before: item,
      after: result,
    })
    return result!
  })
}
export type NpiReconciliation = Awaited<ReturnType<typeof getReconciliation>>

export async function sourceFile(
  userId: string,
  programId: string,
  importId: string,
) {
  const a = await getActor(userId)
  await loadProject(db, programId, a)
  const [file] = await db
    .select()
    .from(s.npiBomImports)
    .where(
      and(
        eq(s.npiBomImports.id, uuidValue(importId)),
        eq(s.npiBomImports.programId, programId),
      ),
    )
  if (!file) throw new NpiError('BOM_NOT_FOUND', '文件不存在', 404)
  const bytes = Buffer.from(file.sourceBase64, 'base64')
  if (createHash('sha256').update(bytes).digest('hex') !== file.sourceHash)
    throw new NpiError('SOURCE_INTEGRITY_ERROR', '原始文件校验失败', 503)
  return { name: file.sourceName, bytes }
}
export async function setTracking(
  userId: string,
  bomId: string,
  input: Record<string, unknown>,
) {
  return db.transaction((tx) =>
    setTrackingInTransaction(tx, userId, bomId, input),
  )
}
async function setTrackingInTransaction(
  tx: Tx,
  userId: string,
  bomId: string,
  input: Record<string, unknown>,
) {
  const a = await getActor(userId, tx, true)
  const [entry] = await tx
    .select({ bom: s.npiBomItems, programId: s.npiBomImports.programId })
    .from(s.npiBomItems)
    .innerJoin(s.npiBomImports, eq(s.npiBomImports.id, s.npiBomItems.importId))
    .where(eq(s.npiBomItems.id, uuidValue(bomId)))
  if (!entry) throw new NpiError('BOM_NOT_FOUND', 'BOM行不存在', 404)
  const p = await loadProject(tx, entry.programId, a, true)
  const o = await owner(tx, input.ownerId, [
    'technical',
    'manufacturing',
    'procurement',
  ])
  const [current] = await tx
    .select()
    .from(s.npiTrackingItems)
    .where(eq(s.npiTrackingItems.bomItemId, bomId))
    .for('update')
  if (!current && p.activeBomImportId !== entry.bom.importId)
    throw new NpiError('BOM_VERSION_CONFLICT', '仅能从当前BOM新增跟踪项', 409)
  versionCheck(current?.version ?? 0, input.expectedVersion)
  const trackingEnabled = flag(input.trackingEnabled),
    affectsKit = flag(input.affectsKit)
  if (current?.actualCompleteDate)
    throw new NpiError(
      'INVALID_STATE_TRANSITION',
      '完成项不可改写跟踪定义',
      400,
    )
  const reason = textValue(input.reason, '调整原因', 2000, true)
  if (
    current &&
    ((current.trackingEnabled && !trackingEnabled) ||
      (current.affectsKit && !affectsKit)) &&
    !reason
  )
    throw new NpiError(
      'TRACKING_REASON_REQUIRED',
      '取消跟踪或齐套影响必须填写原因',
      400,
    )
  if (!current) {
    const review = await reconciliationFor(tx, p)
    if (
      review.items.some((r) => r.oldRow.materialCode === entry.bom.materialCode)
    )
      throw new NpiError(
        'BOM_REVIEW_REQUIRED',
        '此物料有旧版跟踪待复核，请先关联新版或停止旧跟踪',
        409,
      )
  }
  const values = {
    ownerId: o.id,
    requiredDate: dateValue(input.requiredDate, '要求日期')!,
    trackingEnabled,
    affectsKit,
    trackingType: o.role === 'procurement' ? 'purchase' : 'material',
  }
  if (
    current &&
    (values.requiredDate !== current.requiredDate ||
      values.ownerId !== current.ownerId) &&
    !reason
  )
    throw new NpiError(
      'INVALID_STATE_TRANSITION',
      '调整要求日期或责任人必须填写原因',
      400,
    )
  let result
  if (current)
    [result] = await tx
      .update(s.npiTrackingItems)
      .set({ ...values, version: current.version + 1 })
      .where(eq(s.npiTrackingItems.id, current.id))
      .returning()
  else
    [result] = await tx
      .insert(s.npiTrackingItems)
      .values({
        ...values,
        programId: entry.programId,
        bomItemId: bomId,
        sourceType: 'ERP_BOM',
        name: entry.bom.row.materialName,
        specification: entry.bom.row.specification,
        qty: entry.bom.row.qty,
        unit: entry.bom.row.unit,
      })
      .returning()
  if (!result) throw new Error('Tracking update failed')
  await event(tx, a, p.programId, result.id, 'TRACKING_CHANGED', {
    reason,
    before: current ?? null,
    after: result,
  })
  return {
    trackingItemId: result.id,
    ...result,
    status: itemStatus(result),
  }
}
export async function reportManufacturingException(
  userId: string,
  programId: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true)
    const p = await loadProject(tx, programId, a, true)
    if (!(
      a.role === 'admin' ||
      (a.role === 'manufacturing' && a.id === p.manufacturingOwnerId)
    ))
      return denied()
    versionCheck(p.version, input.expectedProjectVersion)
    if (!p.activeBomImportId || p.activeBomImportId !== input.activeImportId)
      throw new NpiError(
        'BOM_VERSION_CONFLICT',
        'BOM已更新，请重新载入并选择当前物料',
        409,
      )
    const bomId = uuidValue(input.bomItemId)
    const [row] = await tx
      .select()
      .from(s.npiBomItems)
      .where(
        and(
          eq(s.npiBomItems.id, bomId),
          eq(s.npiBomItems.importId, p.activeBomImportId),
        ),
      )
    if (!row)
      throw new NpiError(
        'BOM_NOT_FOUND',
        '所选物料不属于当前项目的生效BOM',
        404,
      )
    const [current] = await tx
      .select()
      .from(s.npiTrackingItems)
      .where(eq(s.npiTrackingItems.bomItemId, bomId))
      .for('update')
    if (
      current &&
      (current.ownerId !== p.manufacturingOwnerId ||
        current.trackingType !== 'material')
    )
      throw new NpiError(
        'NPI_PERMISSION_DENIED',
        '已有跟踪由其他责任人负责，请由该责任人回复或先办理交接',
        403,
      )
    const reason = textValue(input.reason, '异常原因', 2000)
    const tracked = await setTrackingInTransaction(tx, userId, bomId, {
      expectedVersion: input.expectedVersion,
      ownerId: p.manufacturingOwnerId,
      requiredDate: current?.requiredDate || p.requiredKitDate,
      trackingEnabled: true,
      affectsKit: flag(input.affectsKit),
      reason,
    })
    const result = await writePromise(tx, a, tracked, {
      expectedVersion: tracked.version,
      committedDate: input.committedDate,
      reason,
    })
    await event(
      tx,
      a,
      programId,
      result.id,
      'MANUFACTURING_EXCEPTION_REPORTED',
      {
        name: result.name,
        reason,
        committedDate: result.currentCommittedDate,
        affectsKit: result.affectsKit,
        bomImportId: p.activeBomImportId,
      },
    )
    return { ...result, status: itemStatus(result) }
  })
}

export async function saveTemplate(
  userId: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true)
    if (a.role !== 'admin') return denied()
    const config = input.config as ImportTemplate
    validateTemplate(config)
    const [existing] = await tx
      .select()
      .from(s.npiImportTemplates)
      .where(eq(s.npiImportTemplates.id, config.id))
      .for('update')
    versionCheck(existing?.version ?? 0, input.expectedVersion)
    const enabled = flag(input.enabled, existing?.enabled ?? true)
    if (existing)
      await tx
        .update(s.npiImportTemplates)
        .set({
          name: config.name,
          config,
          enabled,
          updatedBy: a.id,
          version: existing.version + 1,
        })
        .where(eq(s.npiImportTemplates.id, config.id))
    else
      await tx.insert(s.npiImportTemplates).values({
        id: config.id,
        name: config.name,
        config,
        enabled,
        updatedBy: a.id,
      })
    await event(tx, a, null, config.id, 'TEMPLATE_UPDATED', { config, enabled })
    return { id: config.id }
  })
}
export async function setRole(userId: string, input: Record<string, unknown>) {
  return db.transaction(async (tx) => {
    const a = await getActor(userId, tx, true)
    if (a.role !== 'admin') return denied()
    const target = uuidValue(input.userId),
      role = input.role as Role
    const [targetUser] = await tx
      .select()
      .from(users)
      .where(eq(users.id, target))
      .for('update')
    if (!targetUser) throw new NpiError('VALIDATION_ERROR', '用户不存在')
    if (
      ![
        'technical',
        'manufacturing',
        'procurement',
        'supervisor',
        'admin',
      ].includes(role)
    )
      throw new NpiError('VALIDATION_ERROR', '岗位无效')
    await tx
      .insert(s.npiUserRoles)
      .values({ userId: target, role })
      .onConflictDoUpdate({ target: s.npiUserRoles.userId, set: { role } })
    await event(tx, a, null, target, 'ROLE_CHANGED', { role })
    return { userId: target, role }
  })
}
export async function seedNpiConfig() {
  await db
    .insert(s.npiImportTemplates)
    .values({
      id: defaultTemplate.id,
      name: defaultTemplate.name,
      config: defaultTemplate,
    })
    .onConflictDoNothing()
}
export type ProjectDetail = Awaited<ReturnType<typeof projectDetail>>
export type NpiMetadata = Awaited<ReturnType<typeof metadata>>
export type NpiDashboard = Awaited<ReturnType<typeof dashboard>>
export type NpiTracking = Track & {
  status: string
  ownerName?: string
  projectName?: string
  projectCode?: string
  bomReference?: TrackingBomReference | null
  changeCount?: number
}
