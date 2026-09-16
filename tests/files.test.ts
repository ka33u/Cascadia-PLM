import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw new Error('Explicit _test database required')
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
process.env.ATTACHMENT_ROOT = await mkdtemp(join(tmpdir(), 'npi-file-test-'))
const base = 'http://localhost:3497'
process.env.BASE_URL = base
const { app } = await import('../src/server/app')
const { db, closeDatabase } = await import('../src/lib/db')
const { users } = await import('../src/lib/db/schema/users')
const schema = await import('../src/lib/db/schema/npi')
const { createSession } = await import('../src/lib/auth/session')
const { attachmentPath } = await import('../src/lib/npi/file-service')
await migrate(db, { migrationsFolder: 'migrations' })
const actors: Record<string, { id: string; token: string }> = {}
for (const role of [
  'technical',
  'manufacturing',
  'procurement',
  'supervisor',
  'otherBuyer',
]) {
  const id = crypto.randomUUID()
  await db.insert(users).values({
    id,
    name: '附件验收-' + role,
    email: id + '@files.test.invalid',
    mustChangePassword: false,
  })
  await db.insert(schema.npiUserRoles).values({
    userId: id,
    role: role === 'otherBuyer' ? 'procurement' : (role as 'technical'),
  })
  actors[role] = { id, token: (await createSession(id)).sessionToken }
}
async function call(
  role: string,
  path: string,
  method = 'GET',
  body?: unknown,
) {
  const actor = actors[role]!,
    multipart = body instanceof FormData
  return app.request(base + '/api/v1/npi' + path, {
    method,
    headers: {
      origin: base,
      cookie: 'session=' + actor.token,
      'x-npi-actor': actor.id,
      ...(!multipart ? { 'content-type': 'application/json' } : {}),
    },
    body:
      body === undefined ? undefined : multipart ? body : JSON.stringify(body),
  })
}
const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n',
)
const upload = (
  requestId = crypto.randomUUID(),
  name = '规格.pdf',
  category = 'technical',
  bytes: Buffer = pdf,
  title = '规格资料',
) => {
  const f = new FormData()
  f.set(
    'file',
    new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }),
  )
  f.set('requestId', requestId)
  f.set('category', category)
  f.set('title', title)
  return f
}
let project = '',
  tracking = '',
  issue = '',
  file = ''
try {
  const response = await call('technical', '/projects', 'POST', {
    name: '独立附件验收',
    motorModel: 'FILES',
    technicalOwnerId: actors.technical!.id,
    manufacturingOwnerId: actors.manufacturing!.id,
    requiredKitDate: '2026-10-15',
    prototypeRequiredDate: '2026-10-20',
  })
  assert.equal(response.status, 201)
  project = (await response.json()).id
  tracking = (
    await (
      await call('technical', `/projects/${project}/external-items`, 'POST', {
        name: '附件采购件',
        qty: '1',
        ownerId: actors.procurement!.id,
        requiredDate: '2026-10-12',
        affectsKit: true,
      })
    ).json()
  ).id
  issue = (
    await (
      await call('technical', `/projects/${project}/issues`, 'POST', {
        title: '附件异常',
        description: '验证问题照片与处理证据',
        severity: 'Medium',
        ownerId: actors.procurement!.id,
        targetDate: '2026-10-12',
      })
    ).json()
  ).id
  await test('Own attachment records store exact bytes, hashes and download disposition', async () => {
    const saved = await call(
      'technical',
      `/files/project/${project}`,
      'POST',
      upload(),
    )
    assert.equal(saved.status, 201)
    file = (await saved.json()).id
    const downloaded = await call('technical', `/file-content/${file}`)
    assert.equal(downloaded.status, 200)
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), pdf)
    assert.match(downloaded.headers.get('content-disposition')!, /attachment/)
    const [row] = await db
      .select()
      .from(schema.npiAttachments)
      .where(eq(schema.npiAttachments.id, file))
    assert.equal(row!.size, pdf.length)
    assert.equal(row!.fileHash.length, 64)
    assert.deepEqual(await readFile(attachmentPath(row!.storageKey)), pdf)
  })
  await test('Concurrent replay stores one file and conflicting reuse writes no bytes', async () => {
    const id = crypto.randomUUID(),
      before = (await readdir(process.env.ATTACHMENT_ROOT!)).length
    const a = await Promise.all([
      call('technical', `/files/project/${project}`, 'POST', upload(id)),
      call('technical', `/files/project/${project}`, 'POST', upload(id)),
    ])
    assert.deepEqual(
      a.map((r) => r.status),
      [201, 201],
    )
    const records = await Promise.all(a.map((r) => r.json()))
    assert.equal(records[0].id, records[1].id)
    assert.equal(
      (await readdir(process.env.ATTACHMENT_ROOT!)).length,
      before + 1,
    )
    assert.equal(
      (
        await call(
          'technical',
          `/files/project/${project}`,
          'POST',
          upload(id, '规格.pdf', 'technical', pdf, '冲突标题'),
        )
      ).status,
      409,
    )
    assert.equal(
      (await readdir(process.env.ATTACHMENT_ROOT!)).length,
      before + 1,
    )
  })
  await test('Purchasers access only their current task or assigned issue and can upload receipts', async () => {
    assert.equal(
      (await call('procurement', `/files/project/${project}`)).status,
      403,
    )
    assert.equal(
      (await call('otherBuyer', `/files/tracking/${tracking}`)).status,
      403,
    )
    assert.equal(
      (await call('procurement', `/file-content/${file}`)).status,
      403,
    )
    assert.equal(
      (await call('supervisor', `/files/project/${project}`, 'POST', upload()))
        .status,
      403,
    )
    assert.equal(
      (
        await call(
          'procurement',
          `/files/tracking/${tracking}`,
          'POST',
          upload(),
        )
      ).status,
      403,
    )
    const receipt = await call(
      'procurement',
      `/files/tracking/${tracking}`,
      'POST',
      upload(crypto.randomUUID(), '回执.pdf', 'receipt'),
    )
    assert.equal(receipt.status, 201)
    const id = (await receipt.json()).id
    await db
      .update(schema.npiTrackingItems)
      .set({ ownerId: actors.otherBuyer!.id })
      .where(eq(schema.npiTrackingItems.id, tracking))
    assert.equal((await call('procurement', `/file-content/${id}`)).status, 403)
    assert.equal((await call('otherBuyer', `/file-content/${id}`)).status, 200)
    assert.equal(
      (
        await call(
          'procurement',
          `/files/issue/${issue}`,
          'POST',
          upload(crypto.randomUUID(), '证据.pdf', 'issue'),
        )
      ).status,
      201,
    )
    assert.equal(
      (await call('otherBuyer', `/files/issue/${issue}`)).status,
      403,
    )
  })
  await test('Wrong extensions, invalid signatures, oversize and category mismatch are rejected without storage writes', async () => {
    const before = (await readdir(process.env.ATTACHMENT_ROOT!)).length
    for (const form of [
      upload(crypto.randomUUID(), 'run.exe'),
      upload(
        crypto.randomUUID(),
        'fake.pdf',
        'technical',
        Buffer.from('not a PDF'),
      ),
      upload(
        crypto.randomUUID(),
        'large.pdf',
        'technical',
        Buffer.alloc(5 * 1024 * 1024 + 1),
      ),
      upload(crypto.randomUUID(), 'file.pdf', 'receipt'),
    ]) {
      assert.ok(
        [413, 422].includes(
          (await call('technical', `/files/project/${project}`, 'POST', form))
            .status,
        ),
      )
    }
    assert.equal((await readdir(process.env.ATTACHMENT_ROOT!)).length, before)
    assert.throws(() => attachmentPath('../../.env'))
  })
  await test('Corrupted storage never downloads; archive requires reason and retains readable history', async () => {
    const [row] = await db
      .select()
      .from(schema.npiAttachments)
      .where(eq(schema.npiAttachments.id, file))
    await writeFile(attachmentPath(row!.storageKey), 'corruption')
    assert.equal((await call('technical', `/file-content/${file}`)).status, 409)
    await writeFile(attachmentPath(row!.storageKey), pdf)
    assert.equal(
      (await call('technical', `/file-archive/${file}`, 'POST', {})).status,
      422,
    )
    assert.equal(
      (
        await call('technical', `/file-archive/${file}`, 'POST', {
          reason: '新版替代',
        })
      ).status,
      200,
    )
    assert.equal(
      (
        await call('technical', `/file-archive/${file}`, 'POST', {
          reason: '重复',
        })
      ).status,
      409,
    )
    assert.equal((await call('technical', `/file-content/${file}`)).status, 200)
    const list = await (
      await call('technical', `/files/project/${project}`)
    ).json()
    assert.equal(
      list.files.find((f: { id: string }) => f.id === file).archiveReason,
      '新版替代',
    )
  })
} finally {
  await closeDatabase()
}
