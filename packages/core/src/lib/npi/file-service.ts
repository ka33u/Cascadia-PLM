// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { designs } from '../db/schema/designs'
import { branches, commits } from '../db/schema/versioning'
import { documents, issues, items } from '../db/schema/items'
import { vaultFileHistory, vaultFiles } from '../db/schema/vault'
import { users } from '../db/schema/users'
import * as s from '../db/schema/npi'
import { StorageFactory } from '../vault/storage/storage-factory'
import { lifecycleDefinitions } from '../db/schema/lifecycles'
import { DEFAULT_ITEM_LIFECYCLES } from '../items/default-lifecycles'
import { LIFECYCLE_IDS } from '../items/lifecycle-ids'
import { ItemService } from '../items/services/ItemService'
import '../items/registerItemTypes.server'
import { NpiError, textValue } from './domain'
import { validatedFile } from './file-validation'
import { MAX_NPI_FILE_BYTES } from './file-types'
import { event, getActor, loadProject, uuidValue } from './service'
import type { Actor } from './service'
import type { TransactionClient } from '../db'
import type { Document } from '../items/types/document'

type Run = TransactionClient | typeof db
export type FileScope = { kind: 'project' | 'tracking' | 'issue'; id: string }
const deny = () => {
  throw new NpiError('NPI_PERMISSION_DENIED', '无权访问此资料', 403)
}
const missing = () => {
  throw new NpiError('FILE_NOT_FOUND', '资料不存在或已不可用', 404)
}
export function fileScope(kind: string, id: string): FileScope {
  if (!['project', 'tracking', 'issue'].includes(kind))
    throw new NpiError('VALIDATION_ERROR', '资料归属无效')
  return { kind: kind as FileScope['kind'], id: uuidValue(id) }
}
// Always evaluate current assignment. Being the uploader grants no extra access.
async function access(
  run: Run,
  actor: Actor,
  scope: FileScope,
  edit = false,
): Promise<{
  programId: string
  project: typeof s.npiProjects.$inferSelect
  canUpload: boolean
  canArchive: boolean
}> {
  let programId = scope.id,
    ownerId: string | null = null,
    active = true,
    assignedMaterial = false
  if (scope.kind === 'tracking') {
    const [t] = await run
      .select()
      .from(s.npiTrackingItems)
      .where(eq(s.npiTrackingItems.id, scope.id))
    if (!t) return missing()
    programId = t.programId
    ownerId = t.trackingType === 'purchase' ? t.ownerId : null
    assignedMaterial =
      ['technical', 'manufacturing'].includes(actor.role) &&
      ['material', 'other'].includes(t.trackingType) &&
      actor.id === t.ownerId
    active = t.trackingEnabled || t.affectsKit
  } else if (scope.kind === 'issue') {
    const [r] = await run
      .select({ link: s.npiIssueLinks, issue: issues, item: items })
      .from(s.npiIssueLinks)
      .innerJoin(issues, eq(issues.itemId, s.npiIssueLinks.itemId))
      .innerJoin(items, eq(items.id, issues.itemId))
      .where(eq(s.npiIssueLinks.itemId, scope.id))
    if (!r || r.item.isDeleted || r.issue.programId !== r.link.programId)
      return missing()
    programId = r.link.programId
    ownerId = r.issue.assignedTo
    active = !['Closed', 'Cancelled'].includes(r.item.state)
  }
  let project
  if (actor.role === 'procurement' || assignedMaterial) {
    if (!assignedMaterial && (scope.kind === 'project' || actor.id !== ownerId))
      return deny()
    const q = run
      .select()
      .from(s.npiProjects)
      .where(eq(s.npiProjects.programId, programId))
    ;[project] = edit ? await q.for('update') : await q
    if (!project) return missing()
    // Assignment may have changed while the project lock was awaited.

    if (edit && project.currentNpiStage === 'completed')
      throw new NpiError('INVALID_STATE_TRANSITION', '已完成项目为只读', 400)
  } else project = await loadProject(run, programId, actor, edit)
  if (edit) {
    const latest = await access(run, actor, scope)
    if (latest.programId !== programId) return deny()
    active = latest.canUpload
  }
  if (edit && !active)
    throw new NpiError(
      'INVALID_STATE_TRANSITION',
      '已停止的跟踪项或已关闭的问题为只读',
      400,
    )
  return {
    programId,
    project,
    canArchive:
      project.currentNpiStage !== 'completed' &&
      active &&
      (actor.role === 'admin' ||
        (['technical', 'manufacturing'].includes(actor.role) &&
          [project.technicalOwnerId, project.manufacturingOwnerId].includes(
            actor.id,
          ))),
    canUpload:
      actor.role !== 'supervisor' &&
      project.currentNpiStage !== 'completed' &&
      active,
  }
}
const condition = (scope: FileScope) =>
  scope.kind === 'tracking'
    ? eq(s.npiFileLinks.trackingItemId, scope.id)
    : scope.kind === 'issue'
      ? eq(s.npiFileLinks.issueId, scope.id)
      : and(
          eq(s.npiFileLinks.programId, scope.id),
          isNull(s.npiFileLinks.trackingItemId),
          isNull(s.npiFileLinks.issueId),
        )
const query = (run: Run) =>
  run
    .select({
      link: s.npiFileLinks,
      file: vaultFiles,
      item: items,
      document: documents,
      space: s.npiDocumentSpaces,
      design: designs,
      uploader: users.name,
    })
    .from(s.npiFileLinks)
    .innerJoin(vaultFiles, eq(vaultFiles.id, s.npiFileLinks.fileId))
    .innerJoin(items, eq(items.id, s.npiFileLinks.documentId))
    .innerJoin(documents, eq(documents.itemId, items.id))
    .innerJoin(
      s.npiDocumentSpaces,
      eq(s.npiDocumentSpaces.programId, s.npiFileLinks.programId),
    )
    .innerJoin(designs, eq(designs.id, s.npiDocumentSpaces.designId))
    .leftJoin(users, eq(users.id, s.npiFileLinks.uploadedBy))
type Row = Awaited<ReturnType<typeof query>>[number]
const intact = (r: Row) =>
  !r.file.deletedAt &&
  !r.item.isDeleted &&
  r.file.itemId === r.item.id &&
  r.item.itemType === 'Document' &&
  r.item.designId === r.space.designId &&
  r.design.programId === r.link.programId &&
  r.document.fileId === r.file.id
const summary = (r: Row) => ({
  id: r.link.id,
  documentId: r.item.id,
  name: r.file.originalFileName,
  title: r.item.name || r.file.originalFileName,
  size: r.file.fileSize,
  mimeType: r.file.mimeType,
  category: r.link.category,
  uploader: r.uploader || '系统用户',
  createdAt: r.link.createdAt,
  archivedAt: r.link.archivedAt,
  archiveReason: r.link.archiveReason,
  available: intact(r),
})
export type NpiFile = ReturnType<typeof summary>
export async function listFiles(userId: string, scope: FileScope) {
  const actor = await getActor(userId)
  const a = await access(db, actor, scope)
  const rows = await query(db)
    .where(condition(scope))
    .orderBy(desc(s.npiFileLinks.createdAt))
  return {
    files: rows.filter((r) => r.link.programId === a.programId).map(summary),
    canUpload: a.canUpload,
    canArchive: a.canArchive,
  }
}
export type NpiFileList = Awaited<ReturnType<typeof listFiles>>

// Provision one private, program-bound native design. No membership/role changes.
// This separate, idempotent infrastructure transaction commits before native
// ItemService's branch-policy reads. A failed file upload may leave an empty space.
async function ensureSpace(userId: string, scope: FileScope) {
  return db.transaction(async (tx) => {
    const actor = await getActor(userId, tx, true)
    const { programId } = await access(tx, actor, scope, true)
    const [current] = await tx
      .select()
      .from(s.npiDocumentSpaces)
      .where(eq(s.npiDocumentSpaces.programId, programId))
    if (current) return current.designId
    const [d] = await tx
      .insert(designs)
      .values({
        programId,
        name: 'NPI项目资料',
        code: `NPI-DOC-${programId}`,
        designType: 'Engineering',
        createdBy: actor.id,
        attributes: { npiDocumentSpace: true },
      })
      .returning()
    const [b] = await tx
      .insert(branches)
      .values({
        designId: d!.id,
        name: 'main',
        branchType: 'main',
        createdBy: actor.id,
      })
      .returning()
    const [c] = await tx
      .insert(commits)
      .values({
        designId: d!.id,
        branchId: b!.id,
        message: 'NPI document space created',
        createdBy: actor.id,
      })
      .returning()
    await tx
      .update(branches)
      .set({ headCommitId: c!.id, baseCommitId: c!.id })
      .where(eq(branches.id, b!.id))
    await tx
      .update(designs)
      .set({ defaultBranchId: b!.id })
      .where(eq(designs.id, d!.id))
    await tx.insert(s.npiDocumentSpaces).values({ programId, designId: d!.id })
    await event(tx, actor, programId, d!.id, 'DOCUMENT_SPACE_CREATED', {
      designId: d!.id,
    })
    return d!.id
  })
}
export async function uploadFile(
  userId: string,
  scope: FileScope,
  file: File,
  input: Record<string, unknown>,
) {
  await access(db, await getActor(userId), scope, true)
  if (file.size > MAX_NPI_FILE_BYTES)
    throw new NpiError('INVALID_FILE', '单个文件不超过5MB')
  const bytes = Buffer.from(await file.arrayBuffer()),
    f = validatedFile(file, bytes)
  const title = input.title
    ? textValue(input.title, '资料标题', 200)
    : f.name.slice(0, 200)
  const category = input.category
  if (
    !(scope.kind === 'project'
      ? category === 'technical'
      : scope.kind === 'issue'
        ? category === 'issue'
        : ['technical', 'receipt'].includes(String(category)))
  )
    throw new NpiError('VALIDATION_ERROR', '资料分类与归属不匹配')
  const actor = await getActor(userId)
  if (
    actor.role === 'procurement' &&
    scope.kind === 'tracking' &&
    category !== 'receipt'
  )
    return deny()
  const requestId = uuidValue(input.requestId),
    fileHash = createHash('sha256').update(bytes).digest('hex')
  const requestHash = createHash('sha256')
    .update(JSON.stringify([scope, title, category, f.name, fileHash]))
    .digest('hex')
  // Preserve configured Document policy; seed its native default only if absent.
  const def = DEFAULT_ITEM_LIFECYCLES.find(
    (d) => d.id === LIFECYCLE_IDS.document,
  )!
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
  const designId = await ensureSpace(userId, scope)
  const fileId = randomUUID(),
    storagePath = `npi/${designId}/${fileId}.${f.ext}`
  const storage = await StorageFactory.createFromSettings()
  const storageWrite = { attempted: false }
  try {
    return await db.transaction(async (tx) => {
      const a = await getActor(userId, tx, true)
      const { programId } = await access(tx, a, scope, true)
      if (
        a.role === 'procurement' &&
        scope.kind === 'tracking' &&
        category !== 'receipt'
      )
        return deny()
      const [existing] = await query(tx).where(
        and(
          eq(s.npiFileLinks.uploadedBy, a.id),
          eq(s.npiFileLinks.requestId, requestId),
        ),
      )
      if (existing) {
        if (existing.link.requestHash !== requestHash)
          throw new NpiError(
            'VERSION_CONFLICT',
            '此上传编号已用于另一份资料，请重新选择文件',
            409,
          )
        return summary(existing)
      }
      const [space] = await tx
        .select()
        .from(designs)
        .where(eq(designs.id, designId))
        .for('share')
      if (!space || space.programId !== programId || space.isArchived)
        throw new NpiError(
          'INVALID_STATE_TRANSITION',
          '资料空间已归档或归属改变',
          400,
        )
      storageWrite.attempted = true
      await storage.store(storagePath, bytes)
      if ((await storage.getSize(storagePath)) !== bytes.length)
        throw new Error('Stored file size mismatch')
      const document = await ItemService.create<Document>(
        'Document',
        {
          designId,
          name: title,
          fileId,
          fileName: f.name,
          fileSize: bytes.length,
          mimeType: f.mime,
          storagePath,
        } as Document,
        a.id,
        { tx },
      )
      if (!document.id) throw new Error('Native document ID missing')
      await tx.insert(vaultFiles).values({
        id: fileId,
        itemId: document.id,
        fileName: f.name,
        originalFileName: f.name,
        fileSize: bytes.length,
        mimeType: f.mime,
        fileHash,
        storagePath,
        storageType: process.env.VAULT_TYPE || 'local',
        uploadedBy: a.id,
        fileCategory: f.mime.startsWith('image/') ? 'image' : 'document',
      })
      const [link] = await tx
        .insert(s.npiFileLinks)
        .values({
          programId,
          documentId: document.id,
          fileId,
          trackingItemId: scope.kind === 'tracking' ? scope.id : null,
          issueId: scope.kind === 'issue' ? scope.id : null,
          category: category as 'technical' | 'receipt' | 'issue',
          uploadedBy: a.id,
          requestId,
          requestHash,
        })
        .returning()
      await tx.insert(vaultFileHistory).values({
        fileId,
        action: 'upload',
        performedBy: a.id,
        details: { source: 'npi', linkId: link!.id, fileHash },
      })
      await event(tx, a, programId, scope.id, 'FILE_UPLOADED', {
        linkId: link!.id,
        documentId: document.id,
        fileName: f.name,
        category,
        fileHash,
      })
      const [r] = await query(tx).where(eq(s.npiFileLinks.id, link!.id))
      return summary(r!)
    })
  } catch (error) {
    if (storageWrite.attempted) {
      // Commit may have succeeded despite connection loss. Delete only after
      // confirming no native row references these bytes; on DB outage retain.
      try {
        const [reference] = await db
          .select({ id: vaultFiles.id })
          .from(vaultFiles)
          .where(eq(vaultFiles.id, fileId))
        if (!reference) await storage.delete(storagePath)
      } catch {
        console.error('[NPI] File cleanup deferred', fileId)
      }
    }
    throw error
  }
}
function scopeOf(r: Row): FileScope {
  return r.link.trackingItemId
    ? { kind: 'tracking', id: r.link.trackingItemId }
    : r.link.issueId
      ? { kind: 'issue', id: r.link.issueId }
      : { kind: 'project', id: r.link.programId }
}
export async function downloadFile(userId: string, id: string) {
  const actor = await getActor(userId)
  const [r] = await query(db).where(eq(s.npiFileLinks.id, uuidValue(id)))
  if (!r) return missing()
  if ((await access(db, actor, scopeOf(r))).programId !== r.link.programId)
    return missing()
  if (!intact(r)) return missing()
  const storage = await StorageFactory.createFromSettings()
  if ((process.env.VAULT_TYPE || 'local') !== r.file.storageType)
    return missing()
  const bytes = await storage.retrieve(r.file.storagePath)
  if (
    bytes.length !== r.file.fileSize ||
    createHash('sha256').update(bytes).digest('hex') !== r.file.fileHash
  )
    throw new NpiError(
      'FILE_INTEGRITY_ERROR',
      '文件校验失败，请联系管理员核查备份',
      409,
    )
  // Recheck after storage I/O; do not serve using stale assignment/session data.
  await access(db, await getActor(userId), scopeOf(r))
  await db.insert(vaultFileHistory).values({
    fileId: r.file.id,
    action: 'download',
    performedBy: actor.id,
    details: { source: 'npi' },
  })
  return { bytes, name: r.file.originalFileName, mimeType: r.file.mimeType }
}
export async function archiveFile(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const actor = await getActor(userId, tx, true)
    if (actor.role === 'procurement') return deny()
    const [r] = await query(tx).where(eq(s.npiFileLinks.id, uuidValue(id)))
    if (!r) return missing()
    const permission = await access(tx, actor, scopeOf(r), true)
    if (permission.programId !== r.link.programId) return missing()
    if (!permission.canArchive) return deny()
    const reason = textValue(input.reason, '归档原因', 2000)
    const [updated] = await tx
      .update(s.npiFileLinks)
      .set({
        archivedAt: new Date(),
        archivedBy: actor.id,
        archiveReason: reason,
      })
      .where(and(eq(s.npiFileLinks.id, id), isNull(s.npiFileLinks.archivedAt)))
      .returning()
    if (!updated)
      throw new NpiError('VERSION_CONFLICT', '资料已归档，请刷新核对', 409)
    await event(tx, actor, r.link.programId, id, 'FILE_ARCHIVED', {
      reason,
      documentId: r.item.id,
    })
    return { ok: true }
  })
}
