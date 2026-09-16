// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema/users'
import { programs } from '../db/schema/programs'
import { issues, items } from '../db/schema/items'
import * as s from '../db/schema/npi'
import { ItemService } from '../items/services/ItemService'
import { prepareProjectProfile } from './project-profile'
import { event, getActor, loadProject, owner, versionCheck } from './service'
import { NpiError, dateValue, textValue } from './domain'
import type { TransactionClient } from '../db'
import type { Issue } from '../items/types/issue'

type Input = Record<string, unknown>
async function prepare(
  tx: TransactionClient,
  userId: string,
  id: string,
  input: Input,
) {
  const actor = await getActor(userId, tx, true)
  const project = await loadProject(tx, id, actor, 'plan')
  if (
    !['admin', 'supervisor'].includes(actor.role) &&
    (actor.role !== 'technical' || actor.id !== project.technicalOwnerId)
  )
    throw new NpiError(
      'NPI_PERMISSION_DENIED',
      '项目计划与整体交接由技术负责人、主管或管理员调整',
      403,
    )
  versionCheck(project.version, input.expectedVersion)
  const reason = textValue(input.reason, '变更原因', 2000)
  const technical = await owner(
    tx,
    input.technicalOwnerId === undefined
      ? project.technicalOwnerId
      : input.technicalOwnerId,
    ['technical'],
  )
  const manufacturing = await owner(
    tx,
    input.manufacturingOwnerId === undefined
      ? project.manufacturingOwnerId
      : input.manufacturingOwnerId,
    ['manufacturing'],
  )
  const requiredKitDate = dateValue(
    input.requiredKitDate === undefined
      ? project.requiredKitDate
      : input.requiredKitDate,
    '要求齐套日期',
  )!
  const prototypeRequiredDate = dateValue(
    input.prototypeRequiredDate === undefined
      ? project.prototypeRequiredDate
      : input.prototypeRequiredDate,
    '样机要求日期',
  )!
  if (requiredKitDate > prototypeRequiredDate)
    throw new NpiError('VALIDATION_ERROR', '要求齐套日期不得晚于样机要求日期')
  const [program] = await tx
    .select()
    .from(programs)
    .where(eq(programs.id, id))
    .for('update')
  if (!program) throw new Error('Missing native Program')
  const profile = prepareProjectProfile(program, input)
  const next = {
    name:
      input.name === undefined
        ? program.name
        : textValue(input.name, '新品名称', 200),
    motorModel:
      input.motorModel === undefined
        ? project.motorModel
        : textValue(input.motorModel, '电机型号', 150),
    technicalOwnerId: technical.id,
    manufacturingOwnerId: manufacturing.id,
    requiredKitDate,
    prototypeRequiredDate,
  }
  const tracks = await tx
    .select()
    .from(s.npiTrackingItems)
    .where(eq(s.npiTrackingItems.programId, id))
    .orderBy(asc(s.npiTrackingItems.id))
    .for('update')
  const issueRows = await tx
    .select({ link: s.npiIssueLinks, item: items, issue: issues })
    .from(s.npiIssueLinks)
    .innerJoin(items, eq(items.id, s.npiIssueLinks.itemId))
    .innerJoin(issues, eq(issues.itemId, items.id))
    .where(eq(s.npiIssueLinks.programId, id))
    .orderBy(asc(s.npiIssueLinks.itemId))
    .for('update')
  const [plan] = await tx
    .select()
    .from(s.npiManufacturingPlan)
    .where(eq(s.npiManufacturingPlan.programId, id))
    .for('update')
  // No native membership is inferred or changed. NPI owner checks remain authoritative for NPI routes.
  const transfers = new Map<string, string>()
  for (const [oldId, newId] of [
    [project.technicalOwnerId, technical.id],
    [project.manufacturingOwnerId, manufacturing.id],
  ]) {
    if (oldId === newId) continue
    if (transfers.has(oldId!) && transfers.get(oldId!) !== newId)
      throw new NpiError(
        'VALIDATION_ERROR',
        '原负责人兼任两个岗位，请分次交接并核对工作清单',
      )
    transfers.set(oldId!, newId!)
  }
  const trackChanges = tracks.flatMap((track) => {
    let ownerId = track.ownerId,
      requiredDate = track.requiredDate
    if (track.sourceType === 'MANUFACTURING') {
      ownerId = manufacturing.id
      const previousDate =
        track.trackingType === 'assembly'
          ? project.prototypeRequiredDate
          : project.requiredKitDate
      if (!track.actualCompleteDate && track.requiredDate === previousDate)
        requiredDate =
          track.trackingType === 'assembly'
            ? prototypeRequiredDate
            : requiredKitDate
    } else if (
      track.trackingType !== 'purchase' &&
      !track.actualCompleteDate &&
      (track.trackingEnabled || track.affectsKit)
    ) {
      ownerId = transfers.get(track.ownerId) ?? track.ownerId
    }
    return ownerId === track.ownerId && requiredDate === track.requiredDate
      ? []
      : [{ track, ownerId, requiredDate }]
  })
  const issueChanges = issueRows.flatMap((r) => {
    const ownerId = r.issue.assignedTo
      ? transfers.get(r.issue.assignedTo)
      : undefined
    if (
      !ownerId ||
      r.item.isDeleted ||
      ['Closed', 'Cancelled'].includes(r.item.state)
    )
      return []
    if (r.issue.programId !== id)
      throw new NpiError(
        'INVALID_STATE_TRANSITION',
        '问题归属不一致，请先核对',
        409,
      )
    return [{ ...r, ownerId }]
  })
  const people = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(
      inArray(users.id, [
        project.technicalOwnerId,
        project.manufacturingOwnerId,
        technical.id,
        manufacturing.id,
      ]),
    )
    .orderBy(asc(users.id))
  const names = new Map(people.map((u) => [u.id, u.name || u.id]))
  const fields = [
    ['name', '新品名称', program.name, next.name],
    ['motorModel', '电机型号', project.motorModel, next.motorModel],
    [
      'requiredKitDate',
      '要求齐套日期',
      project.requiredKitDate,
      requiredKitDate,
    ],
    [
      'prototypeRequiredDate',
      '样机要求日期',
      project.prototypeRequiredDate,
      prototypeRequiredDate,
    ],
    ['technicalOwnerId', '技术负责人', project.technicalOwnerId, technical.id],
    [
      'manufacturingOwnerId',
      '制造负责人',
      project.manufacturingOwnerId,
      manufacturing.id,
    ],
  ]
    .filter((f) => f[2] !== f[3])
    .map(([key, label, before, after]) => ({
      key: key!,
      label: label!,
      before: key!.endsWith('OwnerId') ? names.get(before!)! : before!,
      after: key!.endsWith('OwnerId') ? names.get(after!)! : after!,
    }))
  fields.push(
    ...profile.changes.map((c) => ({
      ...c,
      before: c.before || '未填写',
      after: c.after || '未填写',
    })),
  )
  const snapshot = createHash('sha256')
    .update(
      JSON.stringify({
        project,
        program,
        plan,
        tracks,
        issueRows,
        people,
        technical,
        manufacturing,
        next,
        profile: profile.next,
        reason,
      }),
    )
    .digest('hex')
  const preview = {
    expectedSnapshot: snapshot,
    changes: fields,
    tracking: trackChanges.map(({ track, ownerId, requiredDate }) => ({
      id: track.id,
      name: track.name,
      ownerBefore: names.get(track.ownerId) || track.ownerId,
      ownerAfter: names.get(ownerId) || ownerId,
      requiredBefore: track.requiredDate,
      requiredAfter: requiredDate,
    })),
    issues: issueChanges.map((r) => ({
      id: r.item.id,
      name: r.item.name || r.item.itemNumber,
      ownerBefore: names.get(r.issue.assignedTo!) || r.issue.assignedTo!,
      ownerAfter: names.get(r.ownerId) || r.ownerId,
    })),
    retainedDates: tracks
      .filter(
        (t) =>
          t.sourceType === 'MANUFACTURING' &&
          (t.actualCompleteDate ||
            t.requiredDate !==
              (t.trackingType === 'assembly'
                ? project.prototypeRequiredDate
                : project.requiredKitDate)),
      )
      .map((t) => ({ id: t.id, name: t.name, requiredDate: t.requiredDate })),
    canContinue:
      ['admin', 'supervisor'].includes(actor.role) ||
      [technical.id, manufacturing.id].includes(actor.id),
  }
  return {
    actor,
    project,
    program,
    next,
    profile,
    reason,
    trackChanges,
    issueChanges,
    names,
    preview,
  }
}
export async function previewProjectChange(
  userId: string,
  id: string,
  input: Input,
) {
  return db.transaction(
    async (tx) => (await prepare(tx, userId, id, input)).preview,
  )
}
export async function applyProjectChange(
  userId: string,
  id: string,
  input: Input,
) {
  return db.transaction(async (tx) => {
    const r = await prepare(tx, userId, id, input)
    if (input.expectedSnapshot !== r.preview.expectedSnapshot)
      throw new NpiError(
        'VERSION_CONFLICT',
        '预览后项目或任务已变化，请重新预览再确认',
        409,
      )
    if (
      !r.preview.changes.length &&
      !r.trackChanges.length &&
      !r.issueChanges.length
    )
      return { version: r.project.version, canContinue: r.preview.canContinue }
    const { name, ...next } = r.next
    await tx
      .update(s.npiProjects)
      .set({ ...next, version: r.project.version + 1 })
      .where(eq(s.npiProjects.programId, id))
    await tx
      .update(programs)
      .set({
        ...r.profile.patch,
        name,
        ...(next.prototypeRequiredDate !== r.project.prototypeRequiredDate
          ? {
              targetEndDate: new Date(
                `${next.prototypeRequiredDate}T00:00:00+08:00`,
              ),
            }
          : {}),
        updatedBy: r.actor.id,
        updatedAt: new Date(),
      })
      .where(eq(programs.id, id))
    let planChanged = false
    for (const change of r.trackChanges) {
      const { track, ownerId, requiredDate } = change
      await tx
        .update(s.npiTrackingItems)
        .set({ ownerId, requiredDate, version: track.version + 1 })
        .where(eq(s.npiTrackingItems.id, track.id))
      planChanged ||= !!track.manufacturingPlanId
      await event(tx, r.actor, id, track.id, 'TRACKING_PLAN_ADJUSTED', {
        reason: r.reason,
        actorName: r.actor.name,
        itemName: track.name,
        before: {
          ownerId: track.ownerId,
          ownerName: r.names.get(track.ownerId) || track.ownerId,
          requiredDate: track.requiredDate,
        },
        after: {
          ownerId,
          ownerName: r.names.get(ownerId) || ownerId,
          requiredDate,
        },
      })
    }
    if (planChanged) {
      await tx
        .update(s.npiManufacturingPlan)
        .set({
          version: sql`${s.npiManufacturingPlan.version} + 1`,
          updatedBy: r.actor.id,
        })
        .where(eq(s.npiManufacturingPlan.programId, id))
    }
    for (const change of r.issueChanges) {
      await ItemService.update<Issue>(
        change.item.id,
        { assignedTo: change.ownerId },
        r.actor.id,
        { tx },
      )
      await tx
        .update(s.npiIssueLinks)
        .set({ version: change.link.version + 1 })
        .where(eq(s.npiIssueLinks.itemId, change.item.id))
      await event(tx, r.actor, id, change.item.id, 'ISSUE_UPDATED', {
        reason: r.reason,
        before: { ownerId: change.issue.assignedTo },
        after: { ownerId: change.ownerId },
      })
    }
    await event(tx, r.actor, id, id, 'PROJECT_CHANGED', {
      reason: r.reason,
      actorName: r.actor.name,
      before: {
        name: r.program.name,
        profile: r.profile.before,
        motorModel: r.project.motorModel,
        technicalOwnerId: r.project.technicalOwnerId,
        manufacturingOwnerId: r.project.manufacturingOwnerId,
        requiredKitDate: r.project.requiredKitDate,
        prototypeRequiredDate: r.project.prototypeRequiredDate,
      },
      after: { ...r.next, profile: r.profile.next },
      changes: r.preview.changes,
      tracking: r.preview.tracking,
      issues: r.preview.issues,
      retainedDates: r.preview.retainedDates,
    })
    return {
      version: r.project.version + 1,
      canContinue: r.preview.canContinue,
    }
  })
}
export type NpiProjectChangePreview = Awaited<
  ReturnType<typeof previewProjectChange>
>
