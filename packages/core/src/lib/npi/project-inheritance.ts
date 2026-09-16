// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db'
import { programs } from '../db/schema/programs'
import * as s from '../db/schema/npi'
import { NpiError, dateValue, textValue } from './domain'
import { prepareProjectProfile } from './project-profile'
import {
  createProjectInTransaction,
  event,
  getActor,
  loadProject,
  owner,
} from './service'
import type { TransactionClient } from '../db'

async function prepare(
  tx: TransactionClient,
  userId: string,
  sourceId: string,
  input: Record<string, unknown>,
) {
  const actor = await getActor(userId, tx, true)
  if (!['technical', 'admin'].includes(actor.role))
    throw new NpiError(
      'NPI_PERMISSION_DENIED',
      '仅技术负责人或管理员可继承项目',
      403,
    )
  await loadProject(tx, sourceId, actor)
  // Completed sources are valid templates. Lock without treating the source as an edit.
  const [source] = await tx
    .select()
    .from(s.npiProjects)
    .where(eq(s.npiProjects.programId, sourceId))
    .for('update')
  const [program] = await tx
    .select()
    .from(programs)
    .where(eq(programs.id, sourceId))
    .for('update')
  if (!source || !program)
    throw new NpiError('PROGRAM_NOT_FOUND', '源项目不存在', 404)
  if (actor.role !== 'admin' && source.technicalOwnerId !== actor.id)
    throw new NpiError(
      'NPI_PERMISSION_DENIED',
      '仅能继承本人负责的技术项目',
      403,
    )
  for (const key of ['copyBom', 'copyExternal'])
    if (typeof input[key] !== 'boolean')
      throw new NpiError('VALIDATION_ERROR', '请明确选择继承范围')
  const technical = await owner(tx, input.technicalOwnerId, ['technical'])
  const manufacturing = await owner(tx, input.manufacturingOwnerId, [
    'manufacturing',
  ])
  const profile = prepareProjectProfile(program, input).next
  const target = {
    code: textValue(input.code, '新项目编号', 50),
    name: textValue(input.name, '新项目名称', 200),
    motorModel: textValue(input.motorModel, '电机型号', 150),
    technicalOwnerId: technical.id,
    manufacturingOwnerId: manufacturing.id,
    requiredKitDate: dateValue(input.requiredKitDate, '要求齐套日期')!,
    prototypeRequiredDate: dateValue(
      input.prototypeRequiredDate,
      '样机要求日期',
    )!,
    ...profile,
  }
  if (target.requiredKitDate > target.prototypeRequiredDate)
    throw new NpiError('VALIDATION_ERROR', '要求齐套日期不得晚于样机要求日期')
  const tracks = await tx
    .select()
    .from(s.npiTrackingItems)
    .where(eq(s.npiTrackingItems.programId, sourceId))
    .orderBy(asc(s.npiTrackingItems.id))
    .for('update')
  const [bomImport] = source.activeBomImportId
    ? await tx
        .select()
        .from(s.npiBomImports)
        .where(
          and(
            eq(s.npiBomImports.id, source.activeBomImportId),
            eq(s.npiBomImports.programId, sourceId),
          ),
        )
    : []
  const rows =
    input.copyBom && bomImport
      ? await tx
          .select()
          .from(s.npiBomItems)
          .where(eq(s.npiBomItems.importId, bomImport.id))
          .orderBy(asc(s.npiBomItems.level), asc(s.npiBomItems.id))
      : []
  const bomIds = new Set(rows.map((row) => row.id))
  if (
    input.copyBom &&
    tracks.some(
      (t) =>
        t.sourceType === 'ERP_BOM' &&
        !bomIds.has(t.bomItemId || '') &&
        !t.actualCompleteDate &&
        (t.trackingEnabled || t.affectsKit),
    )
  )
    throw new NpiError(
      'BOM_VERSION_CONFLICT',
      '源项目有旧版跟踪待复核，请先完成BOM换版复核',
      409,
    )
  const selected = tracks.filter(
    (t) =>
      t.trackingEnabled &&
      (t.sourceType === 'EXTERNAL'
        ? input.copyExternal
        : t.sourceType === 'ERP_BOM' &&
          input.copyBom &&
          bomIds.has(t.bomItemId || '')),
  )
  const buyer = selected.some((t) => t.trackingType === 'purchase')
    ? await owner(tx, input.procurementOwnerId, ['procurement'])
    : null
  const assignments = selected.map((t) => ({
    sourceItemId: t.id,
    name: t.name,
    specification: t.specification,
    qty: t.qty,
    unit: t.unit,
    supplier: t.supplier,
    remark: t.remark,
    affectsKit: t.affectsKit,
    sourceType: t.sourceType,
    trackingType: t.trackingType,
    ownerId:
      t.trackingType === 'purchase'
        ? buyer!.id
        : t.ownerId === source.technicalOwnerId
          ? technical.id
          : manufacturing.id,
    ownerName:
      t.trackingType === 'purchase'
        ? buyer!.name
        : t.ownerId === source.technicalOwnerId
          ? technical.name
          : manufacturing.name,
    requiredDate: target.requiredKitDate,
  }))
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        source,
        program,
        bomImport: bomImport && { ...bomImport, sourceBase64: undefined },
        rows,
        tracks,
        target,
        copyBom: input.copyBom,
        copyExternal: input.copyExternal,
        assignments,
      }),
    )
    .digest('hex')
  const preview = {
    expectedSnapshot: digest,
    source: {
      id: sourceId,
      name: program.name,
      code: program.code,
      bomVersion: input.copyBom ? bomImport?.versionNo || null : null,
    },
    target,
    copyBom: input.copyBom as boolean,
    copyExternal: input.copyExternal as boolean,
    counts: {
      bomRows: rows.length,
      bomTracking: selected.filter((t) => t.sourceType === 'ERP_BOM').length,
      external: selected.filter((t) => t.sourceType === 'EXTERNAL').length,
    },
    assignments,
  }
  return {
    actor,
    source,
    program,
    bomImport,
    rows,
    selected,
    assignments,
    preview,
  }
}
export type InheritancePreview = Awaited<ReturnType<typeof prepare>>['preview']
export async function previewInheritance(
  userId: string,
  sourceId: string,
  input: Record<string, unknown>,
) {
  return db.transaction(
    async (tx) => (await prepare(tx, userId, sourceId, input)).preview,
  )
}
export async function inheritProject(
  userId: string,
  sourceId: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const r = await prepare(tx, userId, sourceId, input)
    if (input.expectedSnapshot !== r.preview.expectedSnapshot)
      throw new NpiError(
        'VERSION_CONFLICT',
        '源项目或继承设置已变化，请重新预览核对',
        409,
      )
    const created = await createProjectInTransaction(
      tx,
      userId,
      r.preview.target,
    )
    const ids = new Map(r.rows.map((row) => [row.id, crypto.randomUUID()]))
    if (r.preview.copyBom && r.bomImport) {
      const source = r.bomImport
      const bytes = Buffer.from(source.sourceBase64, 'base64')
      if (
        createHash('sha256').update(bytes).digest('hex') !== source.sourceHash
      )
        throw new NpiError(
          'INVALID_BOM_FORMAT',
          '源BOM原始文件校验失败，未创建项目',
          400,
        )
      const [copy] = await tx
        .insert(s.npiBomImports)
        .values({
          programId: created.id,
          versionNo: 1,
          templateId: source.templateId,
          mother: source.mother,
          sheetName: source.sheetName,
          rowCount: source.rowCount,
          maxLevel: source.maxLevel,
          sourceName: source.sourceName,
          sourceBase64: source.sourceBase64,
          sourceHash: source.sourceHash,
          templateSnapshot: source.templateSnapshot,
          importedBy: r.actor.id,
        })
        .returning({ id: s.npiBomImports.id })
      for (let i = 0; i < r.rows.length; i += 100)
        await tx.insert(s.npiBomItems).values(
          r.rows.slice(i, i + 100).map((entry) => {
            const id = ids.get(entry.id)!,
              parentId = entry.parentId ? ids.get(entry.parentId) : null
            if (entry.parentId && !parentId)
              throw new NpiError(
                'INVALID_BOM_FORMAT',
                '源BOM层级关系不完整',
                400,
              )
            return {
              id,
              importId: copy!.id,
              parentId,
              level: entry.level,
              materialCode: entry.materialCode,
              row: { ...entry.row, id, parentId: parentId || null },
            }
          }),
        )
      await tx
        .update(s.npiProjects)
        .set({ activeBomImportId: copy!.id })
        .where(eq(s.npiProjects.programId, created.id))
      await event(tx, r.actor, created.id, copy!.id, 'BOM_IMPORTED', {
        versionNo: 1,
        sourceName: source.sourceName,
        rowCount: source.rowCount,
        inheritedFromImportId: source.id,
      })
    }
    const assignmentMap = new Map(r.assignments.map((a) => [a.sourceItemId, a]))
    if (r.selected.length) {
      for (let i = 0; i < r.selected.length; i += 100)
        await tx.insert(s.npiTrackingItems).values(
          r.selected.slice(i, i + 100).map((t) => {
            const assignment = assignmentMap.get(t.id)!
            return {
              programId: created.id,
              bomItemId:
                t.sourceType === 'ERP_BOM' ? ids.get(t.bomItemId!) : null,
              sourceType: t.sourceType,
              trackingType: t.trackingType,
              name: t.name,
              specification: t.specification,
              qty: t.qty,
              unit: t.unit,
              ownerId: assignment.ownerId,
              requiredDate: assignment.requiredDate,
              affectsKit: t.affectsKit,
              trackingEnabled: true,
              supplier: t.supplier,
              remark: t.remark,
            }
          }),
        )
    }
    await event(tx, r.actor, created.id, created.id, 'PROJECT_INHERITED', {
      sourceProgramId: sourceId,
      sourceCode: r.program.code,
      sourceName: r.program.name,
      sourceBomImportId: r.preview.copyBom ? r.bomImport?.id || null : null,
      counts: r.preview.counts,
      assignments: r.assignments,
    })
    return {
      ...created,
      canContinue:
        r.actor.role === 'admin' ||
        [
          r.preview.target.technicalOwnerId,
          r.preview.target.manufacturingOwnerId,
        ].includes(userId),
    }
  })
}
