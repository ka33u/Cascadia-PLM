// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema/users'
import * as s from '../db/schema/npi'
import { NpiError, textValue } from './domain'
import { validatedFile } from './file-validation'
import { MAX_NPI_FILE_BYTES } from './file-types'
import { event, getActor, loadProject, uuidValue } from './service'
import type { Actor } from './service'
import type { TransactionClient } from '../db'
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
      .select()
      .from(s.npiIssues)
      .where(eq(s.npiIssues.id, scope.id))
    if (!r) return missing()
    programId = r.programId
    ownerId = r.ownerId
    active = !['Closed', 'Cancelled'].includes(r.state)
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
    ? eq(s.npiAttachments.trackingItemId, scope.id)
    : scope.kind === 'issue'
      ? eq(s.npiAttachments.issueId, scope.id)
      : and(
          eq(s.npiAttachments.programId, scope.id),
          isNull(s.npiAttachments.trackingItemId),
          isNull(s.npiAttachments.issueId),
        )

export function attachmentPath(key: string) {
  if (!/^[a-f0-9-]{36}\.(pdf|png|jpg|jpeg|webp|docx|xlsx)$/.test(key))
    throw new NpiError('FILE_NOT_FOUND', '资料存储编号无效', 404)
  return resolve(process.env.ATTACHMENT_ROOT || './runtime/attachments', key)
}
const query = (run: Run) =>
  run
    .select({ file: s.npiAttachments, uploader: users.name })
    .from(s.npiAttachments)
    .innerJoin(users, eq(users.id, s.npiAttachments.uploadedBy))
type Row = Awaited<ReturnType<typeof query>>[number]
const summary = (r: Row) => ({
  id: r.file.id,
  name: r.file.name,
  title: r.file.title,
  size: r.file.size,
  mimeType: r.file.mimeType,
  category: r.file.category,
  uploader: r.uploader,
  createdAt: r.file.createdAt,
  archivedAt: r.file.archivedAt,
  archiveReason: r.file.archiveReason,
  available: true,
})
export type NpiFile = ReturnType<typeof summary>
export async function listFiles(userId: string, scope: FileScope) {
  const actor = await getActor(userId),
    permission = await access(db, actor, scope)
  const rows = await query(db)
    .where(condition(scope))
    .orderBy(desc(s.npiAttachments.createdAt))
  return {
    files: rows
      .filter((r) => r.file.programId === permission.programId)
      .map(summary),
    canUpload: permission.canUpload,
    canArchive: permission.canArchive,
  }
}
export type NpiFileList = Awaited<ReturnType<typeof listFiles>>
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
  const requestId = uuidValue(input.requestId),
    fileHash = createHash('sha256').update(bytes).digest('hex')
  const requestHash = createHash('sha256')
    .update(JSON.stringify([scope, title, category, f.name, fileHash]))
    .digest('hex')
  const id = randomUUID(),
    storageKey = id + '.' + f.ext,
    path = attachmentPath(storageKey)
  let written = false
  try {
    return await db.transaction(async (tx) => {
      const actor = await getActor(userId, tx, true),
        permission = await access(tx, actor, scope, true)
      if (
        !permission.canUpload ||
        (actor.role === 'procurement' &&
          scope.kind === 'tracking' &&
          category !== 'receipt')
      )
        return deny()
      const [existing] = await query(tx).where(
        and(
          eq(s.npiAttachments.uploadedBy, actor.id),
          eq(s.npiAttachments.requestId, requestId),
        ),
      )
      if (existing) {
        if (existing.file.requestHash !== requestHash)
          throw new NpiError(
            'VERSION_CONFLICT',
            '此上传编号已用于另一份资料，请重新选择文件',
            409,
          )
        return summary(existing)
      }
      await mkdir(
        resolve(process.env.ATTACHMENT_ROOT || './runtime/attachments'),
        { recursive: true, mode: 0o700 },
      )
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
      written = true
      await tx.insert(s.npiAttachments).values({
        id,
        programId: permission.programId,
        trackingItemId: scope.kind === 'tracking' ? scope.id : null,
        issueId: scope.kind === 'issue' ? scope.id : null,
        name: f.name,
        title,
        size: bytes.length,
        mimeType: f.mime,
        fileHash,
        storageKey,
        category: category as 'technical' | 'receipt' | 'issue',
        requestId,
        requestHash,
        uploadedBy: actor.id,
      })
      await event(tx, actor, permission.programId, scope.id, 'FILE_UPLOADED', {
        linkId: id,
        fileName: f.name,
        category,
        fileHash,
      })
      const [r] = await query(tx).where(eq(s.npiAttachments.id, id))
      return summary(r!)
    })
  } catch (error) {
    if (written) {
      // If COMMIT's reply was lost, retain bytes whenever metadata may exist.
      try {
        const [r] = await db
          .select({ id: s.npiAttachments.id })
          .from(s.npiAttachments)
          .where(eq(s.npiAttachments.id, id))
        if (!r) await unlink(path)
      } catch {
        console.error('Attachment cleanup deferred:', id)
      }
    }
    throw error
  }
}
const scopeOf = (r: Row): FileScope =>
  r.file.trackingItemId
    ? { kind: 'tracking', id: r.file.trackingItemId }
    : r.file.issueId
      ? { kind: 'issue', id: r.file.issueId }
      : { kind: 'project', id: r.file.programId }
export async function downloadFile(userId: string, id: string) {
  const [r] = await query(db).where(eq(s.npiAttachments.id, uuidValue(id)))
  if (!r) return missing()
  const actor = await getActor(userId)
  if ((await access(db, actor, scopeOf(r))).programId !== r.file.programId)
    return missing()
  let bytes: Buffer
  try {
    bytes = await readFile(attachmentPath(r.file.storageKey))
  } catch {
    return missing()
  }
  if (
    bytes.length !== r.file.size ||
    createHash('sha256').update(bytes).digest('hex') !== r.file.fileHash
  )
    throw new NpiError(
      'FILE_INTEGRITY_ERROR',
      '文件校验失败，请联系管理员核查备份',
      409,
    )
  await access(db, await getActor(userId), scopeOf(r))
  await db.transaction((tx) =>
    event(tx, actor, r.file.programId, id, 'FILE_DOWNLOADED', {}),
  )
  return { bytes, name: r.file.name, mimeType: r.file.mimeType }
}
export async function archiveFile(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const actor = await getActor(userId, tx, true)
    const [r] = await query(tx).where(eq(s.npiAttachments.id, uuidValue(id)))
    if (!r) return missing()
    const permission = await access(tx, actor, scopeOf(r), true)
    if (!permission.canArchive || permission.programId !== r.file.programId)
      return deny()
    const reason = textValue(input.reason, '归档原因', 2000)
    const [updated] = await tx
      .update(s.npiAttachments)
      .set({
        archivedAt: new Date(),
        archivedBy: actor.id,
        archiveReason: reason,
      })
      .where(
        and(eq(s.npiAttachments.id, id), isNull(s.npiAttachments.archivedAt)),
      )
      .returning({ id: s.npiAttachments.id })
    if (!updated)
      throw new NpiError('VERSION_CONFLICT', '资料已归档，请刷新核对', 409)
    await event(tx, actor, r.file.programId, id, 'FILE_ARCHIVED', { reason })
    return { ok: true }
  })
}
