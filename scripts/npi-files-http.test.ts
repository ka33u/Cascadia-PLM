// SPDX-License-Identifier: AGPL-3.0-or-later
// Real HTTP, native Document/Vault and isolated PostgreSQL. No runtime business writes.
import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'
import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw new Error('Explicit isolated _test database required')
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
process.env.VAULT_ROOT = await mkdtemp('/tmp/npi-files-test-')
process.env.VAULT_TYPE = 'local'
const client = postgres(process.env.TEST_DATABASE_URL, { max: 5 })
await migrate(drizzle(client), { migrationsFolder: 'apps/cascadia/drizzle' })
// Never let test storage resolve to the live Vault through database settings.
const { SettingsService, SettingKeys } =
  await import('../packages/core/src/lib/config/SettingsService')
const rootOverride = await SettingsService.getValue(SettingKeys.VAULT_ROOT)
if (rootOverride)
  throw new Error('Test database must have no Vault root override')
const { default: app } = await import('../packages/core/src/server/routes/npi')
const { SessionManager } = await import('../packages/core/src/lib/auth/session')
const { requireDesignAccess } =
  await import('../packages/core/src/lib/auth/access')
const { StorageFactory } =
  await import('../packages/core/src/lib/vault/storage/storage-factory')
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
await new Promise<void>((r) =>
  server.listening ? r() : server.once('listening', r),
)
const addr = server.address()
if (!addr || typeof addr === 'string') throw new Error('No test server')
const base = `http://127.0.0.1:${addr.port}`
const accounts: Record<string, { id: string; token: string }> = {}
for (const role of [
  'technical',
  'manufacturing',
  'procurement',
  'otherBuyer',
  'otherTech',
  'otherMfg',
  'supervisor',
  'admin',
]) {
  const id = crypto.randomUUID()
  await client`insert into users(id,email,name,active) values(${id},${`${id}@files.test.invalid`},${role},true)`
  await client`insert into npi_user_roles(user_id,role) values(${id},${role === 'otherBuyer' ? 'procurement' : role === 'otherTech' ? 'technical' : role === 'otherMfg' ? 'manufacturing' : role})`
  accounts[role] = {
    id,
    token: (await SessionManager.createSession(id)).sessionToken,
  }
}
const headers = (role: string) => ({
  cookie: `session=${accounts[role]!.token}`,
  origin: base,
  'x-npi-actor': accounts[role]!.id,
})
async function call(
  role: string,
  path: string,
  method = 'GET',
  body?: unknown,
  status = 200,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...headers(role),
      ...(body instanceof FormData
        ? {}
        : { 'content-type': 'application/json' }),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  })
  const result = await response.json()
  assert.equal(response.status, status, JSON.stringify(result))
  return result
}
const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n',
)
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=',
  'base64',
)
function upload(
  category = 'technical',
  bytes = pdf,
  name = '技术规格.pdf',
  requestId = crypto.randomUUID(),
) {
  const f = new FormData()
  f.set('file', new File([new Uint8Array(bytes)], name))
  f.set('requestId', requestId)
  f.set('category', category)
  return f
}
let projectId = '',
  trackingId = '',
  issueId = '',
  projectFileId = '',
  photoId = '',
  designId = ''
try {
  await test('Prepare independent project and material; scoped routes reject unauthenticated and cross-origin writes', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '附件边界验证',
        motorModel: 'TEST-FILES',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    projectId = p.id
    const t = await call(
      'technical',
      `/projects/${projectId}/external-items`,
      'POST',
      {
        name: '外购编码器',
        qty: '1',
        unit: '只',
        trackingType: 'purchase',
        ownerId: accounts.procurement!.id,
        requiredDate: '2026-10-15',
        affectsKit: true,
      },
      201,
    )
    trackingId = t.id
    const i = await call(
      'technical',
      `/projects/${projectId}/issues`,
      'POST',
      {
        title: '供应商核对',
        description: '合成测试问题',
        severity: 'High',
        ownerId: accounts.procurement!.id,
        targetDate: '2026-10-15',
        trackingItemId: trackingId,
      },
      201,
    )
    issueId = i.id
    assert.equal(
      (await fetch(base + `/files/project/${projectId}`)).status,
      401,
    )
    assert.equal(
      (
        await fetch(base + `/files/project/${projectId}`, {
          method: 'POST',
          headers: {
            ...headers('technical'),
            origin: 'https://invalid.example',
          },
          body: upload(),
        })
      ).status,
      403,
    )
  })
  await test('Native Document, Vault bytes, commit, uploader and audit are consistent; retry is idempotent', async () => {
    const key = crypto.randomUUID()
    const f = await call(
      'technical',
      `/files/project/${projectId}`,
      'POST',
      upload('technical', pdf, '技术规格.pdf', key),
      201,
    )
    projectFileId = f.id
    const again = await call(
      'technical',
      `/files/project/${projectId}`,
      'POST',
      upload('technical', pdf, '技术规格.pdf', key),
      201,
    )
    assert.equal(again.id, f.id)
    await call(
      'technical',
      `/files/project/${projectId}`,
      'POST',
      upload('technical', png, 'other.png', key),
      409,
    )
    const [row] =
      await client`select d.file_id, i.design_id, i.commit_id, i.item_type, vf.storage_path, vf.uploaded_by from npi_file_links l join items i on i.id=l.document_id join documents d on d.item_id=i.id join vault_files vf on vf.id=l.file_id where l.id=${f.id}`
    assert.equal(row!.item_type, 'Document')
    assert.ok(row!.commit_id)
    assert.equal(row!.uploaded_by, accounts.technical!.id)
    designId = row!.design_id
    assert.deepEqual(
      await readFile(join(process.env.VAULT_ROOT!, row!.storage_path)),
      pdf,
    )
    const response = await fetch(base + `/file-content/${f.id}?inline=1`, {
      headers: headers('manufacturing'),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition')!, /^attachment/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf)
    const audit =
      await client`select action from vault_file_history where file_id=${row!.file_id}`
    assert.deepEqual(audit.map((a) => a.action).sort(), ['download', 'upload'])
    await assert.rejects(
      requireDesignAccess(accounts.procurement!.id, designId),
    )
    const memberships =
      await client`select * from program_members where program_id=${projectId} and user_id=${accounts.procurement!.id}`
    assert.equal(memberships.length, 0)
  })
  await test('Procurement access is task scoped; technical files readonly for buyer; supervisor readonly', async () => {
    await call(
      'procurement',
      `/files/project/${projectId}`,
      'GET',
      undefined,
      403,
    )
    await call(
      'otherTech',
      `/files/project/${projectId}`,
      'GET',
      undefined,
      403,
    )
    await call(
      'procurement',
      `/files/tracking/${trackingId}`,
      'POST',
      upload(),
      403,
    )
    await call(
      'supervisor',
      `/files/project/${projectId}`,
      'POST',
      upload(),
      403,
    )
    await call('supervisor', `/files/project/${projectId}`)
    for (const role of ['procurement', 'otherBuyer', 'otherTech'])
      await call(role, `/file-content/${projectFileId}`, 'GET', undefined, 403)
    const technical = await call(
      'technical',
      `/files/tracking/${trackingId}`,
      'POST',
      upload(),
      201,
    )
    assert.equal(
      (
        await fetch(base + `/file-content/${technical.id}`, {
          headers: headers('procurement'),
        })
      ).status,
      200,
    )
    await call(
      'otherBuyer',
      `/files/tracking/${trackingId}`,
      'GET',
      undefined,
      403,
    )
    const f = await call(
      'procurement',
      `/files/tracking/${trackingId}`,
      'POST',
      upload('receipt', png, '到货照片.png'),
      201,
    )
    photoId = f.id
    const response = await fetch(base + `/file-content/${f.id}?inline=1`, {
      headers: headers('procurement'),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition')!, /^inline/)
    await call(
      'procurement',
      `/file-archive/${f.id}`,
      'POST',
      { reason: '无归档权限' },
      403,
    )
  })
  await test('Assignment handoff removes uploader access and gives new assignee scoped access', async () => {
    const current = (
      await call('technical', `/projects/${projectId}`)
    ).items.find((i: { id: string }) => i.id === trackingId)
    const transferred = await call(
      'technical',
      `/tracking/${trackingId}/plan`,
      'PATCH',
      {
        expectedVersion: current.version,
        ownerId: accounts.otherBuyer!.id,
        reason: '采购岗位交接',
      },
    )
    await call('procurement', `/file-content/${photoId}`, 'GET', undefined, 403)
    await call(
      'procurement',
      `/files/tracking/${trackingId}`,
      'POST',
      upload('receipt', png, 'new.png'),
      403,
    )
    assert.equal(
      (
        await fetch(base + `/file-content/${photoId}`, {
          headers: headers('otherBuyer'),
        })
      ).status,
      200,
    )
    await call('technical', `/tracking/${trackingId}/plan`, 'PATCH', {
      expectedVersion: transferred.version,
      ownerId: accounts.procurement!.id,
      reason: '交回原采购负责人',
    })
    const f = await call(
      'procurement',
      `/files/issue/${issueId}`,
      'POST',
      upload('issue', png, '问题.png'),
      201,
    )
    await call('otherBuyer', `/file-content/${f.id}`, 'GET', undefined, 403)
    await client`update issues set assigned_to=${accounts.otherBuyer!.id} where item_id=${issueId}`
    await call('procurement', `/file-content/${f.id}`, 'GET', undefined, 403)
    assert.equal(
      (
        await fetch(base + `/file-content/${f.id}`, {
          headers: headers('otherBuyer'),
        })
      ).status,
      200,
    )
    await client`update issues set assigned_to=${accounts.procurement!.id} where item_id=${issueId}`
  })
  await test('Delegated material files stay item-scoped, revoke on handoff, and respect archive and read-only boundaries', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '协作物料附件权限',
        motorModel: 'FILES-DELEGATED',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    for (const [trackingType, assignee, successor] of [
      ['material', 'otherTech', 'otherMfg'],
      ['other', 'otherMfg', 'otherTech'],
    ] as const) {
      const t = await call(
        'technical',
        `/projects/${p.id}/external-items`,
        'POST',
        {
          name: `协作${trackingType}`,
          qty: '1',
          unit: '件',
          trackingType,
          ownerId: accounts[assignee]!.id,
          requiredDate: '2026-10-15',
          affectsKit: true,
        },
        201,
      )
      const path = `/files/tracking/${t.id}`
      const spec = await call('technical', path, 'POST', upload(), 201)
      const before = await call(assignee, path)
      assert.equal(before.canUpload, true)
      assert.equal(before.canArchive, false)
      assert.deepEqual(
        before.files.map((f: { id: string }) => f.id),
        [spec.id],
      )
      const download = await fetch(base + `/file-content/${spec.id}`, {
        headers: headers(assignee),
      })
      assert.equal(download.status, 200)
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf)
      await call(assignee, `/projects/${p.id}`, 'GET', undefined, 403)
      await call(assignee, `/files/project/${p.id}`, 'GET', undefined, 403)
      await call(
        assignee,
        `/files/tracking/${trackingId}`,
        'GET',
        undefined,
        403,
      )
      await call(
        assignee,
        `/file-content/${projectFileId}`,
        'GET',
        undefined,
        403,
      )
      await call(successor, path, 'GET', undefined, 403)
      await call('procurement', path, 'GET', undefined, 403)
      const key = crypto.randomUUID()
      const receipt = await call(
        assignee,
        path,
        'POST',
        upload('receipt', png, '完成照片.png', key),
        201,
      )
      assert.equal(
        (
          await call(
            assignee,
            path,
            'POST',
            upload('receipt', png, '完成照片.png', key),
            201,
          )
        ).id,
        receipt.id,
      )
      await call(
        assignee,
        path,
        'POST',
        upload('technical', pdf, '制作说明.pdf'),
        201,
      )
      await call(
        assignee,
        `/file-archive/${spec.id}`,
        'POST',
        { reason: '非项目负责人' },
        403,
      )
      const [space] =
        await client`select design_id from npi_document_spaces where program_id=${p.id}`
      await assert.rejects(() =>
        requireDesignAccess(accounts[assignee]!.id, space!.design_id),
      )
      const [membership] =
        await client`select count(*)::int as count from program_members where program_id=${p.id} and user_id=${accounts[assignee]!.id}`
      assert.equal(membership!.count, 0)
      await call('technical', `/file-archive/${spec.id}`, 'POST', {
        reason: '旧版规格保留追溯',
      })
      const current = (await call('technical', `/projects/${p.id}`)).items.find(
        (i: { id: string }) => i.id === t.id,
      )
      await call('technical', `/tracking/${t.id}/plan`, 'PATCH', {
        expectedVersion: current.version,
        ownerId: accounts[successor]!.id,
        reason: '协作交接',
      })
      await call(assignee, path, 'GET', undefined, 403)
      await call(assignee, `/file-content/${receipt.id}`, 'GET', undefined, 403)
      await call(
        assignee,
        path,
        'POST',
        upload('receipt', png, '交接后.png'),
        403,
      )
      const after = await call(successor, path)
      assert.equal(after.files.length, 3)
      assert.ok(
        after.files.find(
          (f: { id: string; archivedAt: string }) => f.id === spec.id,
        )?.archivedAt,
      )
      assert.equal(
        (
          await fetch(base + `/file-content/${receipt.id}`, {
            headers: headers(successor),
          })
        ).status,
        200,
      )
      await client`update npi_tracking_items set tracking_enabled=false, affects_kit=false where id=${t.id}`
      assert.equal((await call(successor, path)).canUpload, false)
      await call(
        successor,
        path,
        'POST',
        upload('receipt', png, '停止后.png'),
        400,
      )
      await client`update npi_tracking_items set tracking_enabled=true, affects_kit=true where id=${t.id}`
      await client`update npi_projects set current_npi_stage='completed' where program_id=${p.id}`
      assert.equal((await call(successor, path)).canUpload, false)
      await call(
        successor,
        path,
        'POST',
        upload('receipt', png, '项目完成后.png'),
        400,
      )
      await client`update npi_projects set current_npi_stage='manufacturing' where program_id=${p.id}`
    }
  })
  await test('Reject file spoofing, oversize, invalid category; concurrent retry creates one document', async () => {
    for (const [bytes, name] of [
      [Buffer.from('<html>bad</html>'), 'fake.pdf'],
      [png, 'photo.svg'],
      [Buffer.alloc(0), 'empty.pdf'],
      [Buffer.alloc(5 * 1024 * 1024 + 1), 'large.pdf'],
    ] as const)
      await call(
        'technical',
        `/files/project/${projectId}`,
        'POST',
        upload('technical', bytes, name),
        422,
      )
    await call(
      'technical',
      `/files/project/${projectId}`,
      'POST',
      upload('receipt'),
      422,
    )
    const key = crypto.randomUUID()
    const results = await Promise.all(
      [1, 2].map(() =>
        call(
          'technical',
          `/files/project/${projectId}`,
          'POST',
          upload('technical', pdf, 'parallel.pdf', key),
          201,
        ),
      ),
    )
    assert.equal(results[0].id, results[1].id)
    const rows =
      await client`select * from npi_file_links where uploaded_by=${accounts.technical!.id} and request_id=${key}`
    assert.equal(rows.length, 1)
  })
  await test('Storage failure rolls back document and cleans partial blob; downloaded corruption refused', async () => {
    const storage = await StorageFactory.createFromSettings(),
      original = storage.store.bind(storage)
    let attemptedPath = ''
    const before = (
      await client`select count(*)::int as n from npi_file_links where program_id=${projectId}`
    )[0]!.n
    storage.store = async (path, bytes) => {
      attemptedPath = path
      await original(path, bytes)
      throw new Error('Synthetic partial storage failure')
    }
    try {
      await call(
        'technical',
        `/files/project/${projectId}`,
        'POST',
        upload(),
        500,
      )
    } finally {
      storage.store = original
    }
    assert.equal(await storage.exists(attemptedPath), false)
    assert.equal(
      (
        await client`select count(*)::int as n from npi_file_links where program_id=${projectId}`
      )[0]!.n,
      before,
    )
    const [row] =
      await client`select v.storage_path from npi_file_links l join vault_files v on v.id=l.file_id where l.id=${photoId}`
    const path = join(process.env.VAULT_ROOT!, row!.storage_path)
    const bytes = await readFile(path)
    await writeFile(path, Buffer.from('corrupt'))
    try {
      await call('technical', `/file-content/${photoId}`, 'GET', undefined, 409)
    } finally {
      await writeFile(path, bytes)
    }
  })
  await test('Failure after native Document insert rolls back native document, subtype and commit; removes only new bytes', async () => {
    const { ItemService } =
      await import('../packages/core/src/lib/items/services/ItemService')
    const before =
      await client`select id from items where design_id=${designId}`
    const nativeCreate = ItemService.create
    ItemService.create = async (...args) => {
      await nativeCreate.apply(ItemService, args)
      throw new Error('Synthetic failure after Document insert')
    }
    const storage = await StorageFactory.createFromSettings(),
      originalStore = storage.store.bind(storage)
    let attemptedPath = ''
    storage.store = async (path, bytes) => {
      attemptedPath = path
      await originalStore(path, bytes)
    }
    try {
      await call(
        'technical',
        `/files/project/${projectId}`,
        'POST',
        upload(),
        500,
      )
    } finally {
      ItemService.create = nativeCreate
      storage.store = originalStore
    }
    assert.deepEqual(
      await client`select id from items where design_id=${designId}`,
      before,
    )
    assert.equal(await storage.exists(attemptedPath), false)
    const orphans =
      await client`select d.item_id from documents d left join items i on i.id=d.item_id where i.id is null`
    assert.equal(orphans.length, 0)
  })
  await test('Buyer first upload provisions program-bound private document space without native membership', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '首次采购照片空间',
        motorModel: 'TEST-SPACE',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const t = await call(
      'technical',
      `/projects/${p.id}/external-items`,
      'POST',
      {
        name: '首次照片物料',
        qty: '1',
        ownerId: accounts.procurement!.id,
        requiredDate: '2026-10-15',
        affectsKit: true,
      },
      201,
    )
    const f = await call(
      'procurement',
      `/files/tracking/${t.id}`,
      'POST',
      upload('receipt', png, '采购首次照片.png'),
      201,
    )
    const [space] =
      await client`select d.* from npi_document_spaces s join designs d on d.id=s.design_id where s.program_id=${p.id}`
    assert.equal(space!.program_id, p.id)
    assert.equal(space!.created_by, accounts.procurement!.id)
    await assert.rejects(
      requireDesignAccess(accounts.procurement!.id, space!.id),
    )
    assert.equal(
      (
        await client`select * from program_members where program_id=${p.id} and user_id=${accounts.procurement!.id}`
      ).length,
      0,
    )
    await call('procurement', `/files/project/${p.id}`, 'GET', undefined, 403)
    assert.equal(
      (
        await fetch(base + `/file-content/${f.id}`, {
          headers: headers('procurement'),
        })
      ).status,
      200,
    )
  })
  await test('Project owner handoff moves NPI document access without changing native memberships', async () => {
    const before = await call('technical', `/projects/${projectId}`)
    const members =
      await client`select * from program_members where program_id=${projectId} order by id`
    const proposal = {
      expectedVersion: before.version,
      technicalOwnerId: accounts.otherTech!.id,
      reason: '技术负责人整体交接',
    }
    const preview = await call(
      'technical',
      `/projects/${projectId}/change-preview`,
      'POST',
      proposal,
    )
    await call('technical', `/projects/${projectId}/plan`, 'PATCH', {
      ...proposal,
      expectedSnapshot: preview.expectedSnapshot,
    })
    await call(
      'technical',
      `/files/project/${projectId}`,
      'GET',
      undefined,
      403,
    )
    await call(
      'technical',
      `/file-content/${projectFileId}`,
      'GET',
      undefined,
      403,
    )
    await call('otherTech', `/files/project/${projectId}`)
    assert.equal(
      (
        await fetch(base + `/file-content/${projectFileId}`, {
          headers: headers('otherTech'),
        })
      ).status,
      200,
    )
    await call(
      'otherTech',
      `/files/project/${projectId}`,
      'POST',
      upload(),
      201,
    )
    assert.deepEqual(
      await client`select * from program_members where program_id=${projectId} order by id`,
      members,
    )
    const after = await call('otherTech', `/projects/${projectId}`)
    const restore = {
      expectedVersion: after.version,
      technicalOwnerId: accounts.technical!.id,
      reason: '验收完成，交回原负责人',
    }
    const restorePreview = await call(
      'otherTech',
      `/projects/${projectId}/change-preview`,
      'POST',
      restore,
    )
    await call('otherTech', `/projects/${projectId}/plan`, 'PATCH', {
      ...restore,
      expectedSnapshot: restorePreview.expectedSnapshot,
    })
  })
  await test('Reasoned archival retains immutable bytes; stopped/closed/completed records deny upload and inactive session denied', async () => {
    await call(
      'technical',
      `/file-archive/${projectFileId}`,
      'POST',
      { reason: '' },
      422,
    )
    await call('technical', `/file-archive/${projectFileId}`, 'POST', {
      reason: '旧版参考，保留追溯',
    })
    await call(
      'technical',
      `/file-archive/${projectFileId}`,
      'POST',
      { reason: '不能覆盖' },
      409,
    )
    const data = await call('technical', `/files/project/${projectId}`)
    assert.equal(
      data.files.find((f: { id: string }) => f.id === projectFileId)
        .archiveReason,
      '旧版参考，保留追溯',
    )
    assert.equal(
      (
        await fetch(base + `/file-content/${projectFileId}`, {
          headers: headers('technical'),
        })
      ).status,
      200,
    )
    await client`update npi_tracking_items set tracking_enabled=false, affects_kit=false where id=${trackingId}`
    await call(
      'procurement',
      `/files/tracking/${trackingId}`,
      'POST',
      upload('receipt', png, 'receipt.png'),
      400,
    )
    await client`update items set state='Closed' where id=${issueId}`
    await call(
      'procurement',
      `/files/issue/${issueId}`,
      'POST',
      upload('issue', png, 'issue.png'),
      400,
    )
    await client`update npi_projects set current_npi_stage='completed' where program_id=${projectId}`
    await call(
      'technical',
      `/files/project/${projectId}`,
      'POST',
      upload(),
      400,
    )
    await client`update users set active=false where id=${accounts.technical!.id}`
    await call(
      'technical',
      `/file-content/${projectFileId}`,
      'GET',
      undefined,
      401,
    )
  })
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  )
  await client.end()
  const database = await import('../packages/core/src/lib/db')
  await (database.db as unknown as { $client: postgres.Sql }).$client.end()
  await database.migrationClient.end()
}
