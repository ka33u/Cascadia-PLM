// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto'
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db'
import * as s from '../db/schema/npi'
import { NpiError } from './domain'
import { previewExcel } from './excel'
import { confirmMother, restoreConfirmedMother } from './mother-confirmation'
import { event, getActor, loadProject, uuidValue } from './service'
import type { TransactionClient } from '../db'

async function access(
  tx: TransactionClient | typeof db,
  userId: string,
  id: string,
  edit = false,
) {
  const a = await getActor(userId, tx, edit)
  const p = await loadProject(tx, id, a, edit)
  if (
    a.role !== 'admin' &&
    (a.role !== 'technical' || p.technicalOwnerId !== a.id)
  )
    throw new NpiError(
      'NPI_PERMISSION_DENIED',
      '仅项目技术负责人可管理自己的BOM草稿',
      403,
    )
  return { a, p }
}
async function savedDraft(
  tx: TransactionClient,
  id: string,
  userId: string,
  draftId: unknown,
) {
  const [draft] = await tx
    .select()
    .from(s.npiBomPreviews)
    .where(eq(s.npiBomPreviews.id, uuidValue(draftId)))
    .for('update')
  if (
    !draft ||
    draft.programId !== id ||
    draft.userId !== userId ||
    !draft.savedAt
  )
    throw new NpiError('NPI_PERMISSION_DENIED', '无权读取此草稿', 403)
  if (draft.discardedAt || draft.consumedImportId)
    throw new NpiError(
      'BOM_VERSION_CONFLICT',
      '草稿已移除或已导入，请刷新列表',
      409,
    )
  return draft
}
export async function listBomDrafts(userId: string, id: string) {
  await access(db, userId, id)
  // Do not return original workbook bytes or full parsed rows in the list.
  const records = await db
    .select({
      id: s.npiBomPreviews.id,
      sourceName: s.npiBomPreviews.sourceName,
      templateId: s.npiBomPreviews.templateId,
      savedAt: s.npiBomPreviews.savedAt,
      projectVersion: s.npiBomPreviews.projectVersion,
      preview: s.npiBomPreviews.preview,
    })
    .from(s.npiBomPreviews)
    .where(
      and(
        eq(s.npiBomPreviews.programId, id),
        eq(s.npiBomPreviews.userId, userId),
        isNotNull(s.npiBomPreviews.savedAt),
        isNull(s.npiBomPreviews.discardedAt),
        isNull(s.npiBomPreviews.consumedImportId),
      ),
    )
    .orderBy(desc(s.npiBomPreviews.savedAt))
  return {
    drafts: records.map(({ preview, ...record }) => ({
      ...record,
      motherCode: preview.mother.code,
      rowCount: preview.summary.rows,
      templateName: preview.templateSnapshot?.name || preview.templateId,
    })),
  }
}
export type BomDraft = Awaited<
  ReturnType<typeof listBomDrafts>
>['drafts'][number]
export async function saveBomDraft(userId: string, id: string, token: unknown) {
  return db.transaction(async (tx) => {
    const { a } = await access(tx, userId, id, true)
    const [preview] = await tx
      .select()
      .from(s.npiBomPreviews)
      .where(eq(s.npiBomPreviews.id, uuidValue(token)))
      .for('update')
    if (!preview || preview.programId !== id || preview.userId !== userId)
      throw new NpiError('NPI_PERMISSION_DENIED', '无权保存此预览', 403)
    if (preview.discardedAt || preview.consumedImportId)
      throw new NpiError('BOM_VERSION_CONFLICT', '此预览已失效', 409)
    // Repeated clicks/request retries return the same durable draft.
    if (preview.savedAt) return { draftId: preview.id }
    if (preview.expiresAt.getTime() < Date.now())
      throw new NpiError(
        'BOM_VERSION_CONFLICT',
        '预览已过期，请重新上传或恢复草稿',
        409,
      )
    if (preview.preview.summary.errors)
      throw new NpiError(
        'INVALID_BOM_FORMAT',
        '请先修正解析错误，再保存草稿',
        400,
      )
    if (preview.draftSourceId) {
      const draft = await savedDraft(tx, id, userId, preview.draftSourceId)
      if (draft.sourceHash !== preview.sourceHash)
        throw new NpiError('INVALID_BOM_FORMAT', '草稿原始文件不一致', 400)
      await tx
        .update(s.npiBomPreviews)
        .set({
          preview: preview.preview,
          templateId: preview.templateId,
          projectVersion: preview.projectVersion,
          savedAt: new Date(),
        })
        .where(eq(s.npiBomPreviews.id, draft.id))
      await event(tx, a, id, draft.id, 'BOM_DRAFT_UPDATED', {
        sourceName: preview.sourceName,
        rowCount: preview.preview.summary.rows,
        ...(preview.preview.motherConfirmation
          ? { motherConfirmation: preview.preview.motherConfirmation }
          : {}),
      })
      await tx
        .update(s.npiBomPreviews)
        .set({ expiresAt: new Date(0) })
        .where(eq(s.npiBomPreviews.id, preview.id))
      return { draftId: draft.id }
    }
    await tx
      .update(s.npiBomPreviews)
      .set({ savedAt: new Date(), expiresAt: new Date(0) })
      .where(eq(s.npiBomPreviews.id, preview.id))
    await event(tx, a, id, preview.id, 'BOM_DRAFT_SAVED', {
      sourceName: preview.sourceName,
      rowCount: preview.preview.summary.rows,
    })
    return { draftId: preview.id }
  })
}
export async function resumeBomDraft(
  userId: string,
  id: string,
  draftId: string,
  templateId?: string,
  motherConfirmation?: unknown,
) {
  return db.transaction(async (tx) => {
    const { a, p } = await access(tx, userId, id, true)
    const draft = await savedDraft(tx, id, userId, draftId)
    const bytes = Buffer.from(draft.sourceBase64, 'base64')
    if (createHash('sha256').update(bytes).digest('hex') !== draft.sourceHash)
      throw new NpiError(
        'INVALID_BOM_FORMAT',
        '草稿原始文件校验失败，请重新上传',
        400,
      )
    const templates = await tx
      .select()
      .from(s.npiImportTemplates)
      .where(eq(s.npiImportTemplates.enabled, true))
    // Reparse original bytes using the current template, then bind to today's project version.
    const parsed = await previewExcel(
      bytes,
      templates.map((t) => t.config),
      templateId || draft.templateId,
    )
    const preview =
      motherConfirmation === undefined
        ? restoreConfirmedMother(parsed, draft.preview)
        : confirmMother(parsed, motherConfirmation, a)
    if (preview.summary.errors)
      return {
        ...preview,
        previewToken: null,
        sourceName: draft.sourceName,
        draftId: draft.id,
      }
    const [fresh] = await tx
      .insert(s.npiBomPreviews)
      .values({
        programId: id,
        userId,
        projectVersion: p.version,
        templateId: preview.templateId,
        preview,
        sourceName: draft.sourceName,
        sourceBase64: draft.sourceBase64,
        sourceHash: draft.sourceHash,
        draftSourceId: draft.id,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      })
      .returning({ id: s.npiBomPreviews.id })
    await event(tx, a, id, draft.id, 'BOM_DRAFT_RESUMED', {
      sourceName: draft.sourceName,
      templateId: preview.templateId,
      previousProjectVersion: draft.projectVersion,
      projectVersion: p.version,
    })
    return {
      ...preview,
      previewToken: fresh!.id,
      sourceName: draft.sourceName,
      draftId: draft.id,
    }
  })
}
export async function discardBomDraft(
  userId: string,
  id: string,
  draftId: string,
) {
  return db.transaction(async (tx) => {
    const { a } = await access(tx, userId, id, true)
    const draft = await savedDraft(tx, id, userId, draftId)
    await tx
      .update(s.npiBomPreviews)
      .set({ discardedAt: new Date() })
      .where(eq(s.npiBomPreviews.id, draft.id))
    await event(tx, a, id, draft.id, 'BOM_DRAFT_DISCARDED', {
      sourceName: draft.sourceName,
    })
    return { discarded: true }
  })
}
