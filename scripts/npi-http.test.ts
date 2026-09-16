// SPDX-License-Identifier: AGPL-3.0-or-later
import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import postgres from 'postgres'
import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw new Error('Explicit _test database required')
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const client = postgres(process.env.TEST_DATABASE_URL, { max: 5 })
await migrate(drizzle(client), { migrationsFolder: 'apps/cascadia/drizzle' })
const { default: app } = await import('../packages/core/src/server/routes/npi')
const service = await import('../packages/core/src/lib/npi/service')
const { SessionManager } = await import('../packages/core/src/lib/auth/session')
const { defaultTemplate } = await import('../packages/core/src/lib/npi/bom')
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
await new Promise<void>((resolve) =>
  server.listening ? resolve() : server.once('listening', resolve),
)
const address = server.address()
if (!address || typeof address === 'string') throw new Error('No address')
const base = `http://127.0.0.1:${address.port}`
const actorIds: Array<string> = []
const accounts: Record<string, { id: string; token: string }> = {}
for (const role of [
  'technical',
  'manufacturing',
  'procurement',
  'supervisor',
  'admin',
  'otherBuyer',
  'otherTech',
]) {
  const id = crypto.randomUUID()
  actorIds.push(id)
  await client`insert into users(id,email,name,active) values(${id},${`${id}@test.invalid`},${role},true)`
  await client`insert into npi_user_roles(user_id,role) values(${id},${role === 'otherBuyer' ? 'procurement' : role === 'otherTech' ? 'technical' : role})`
  const { sessionToken } = await SessionManager.createSession(id)
  accounts[role] = { id, token: sessionToken }
}
await service.seedNpiConfig()
async function call(
  role: string,
  path: string,
  method = 'GET',
  body?: unknown,
  status = 200,
) {
  const a = accounts[role]!
  const headers: Record<string, string> = {
    cookie: `session=${a.token}`,
    origin: base,
    'x-npi-actor': a.id,
  }
  if (!(body instanceof FormData)) headers['content-type'] = 'application/json'
  const response = await fetch(base + path, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  })
  const data = await response.json()
  assert.equal(response.status, status, JSON.stringify(data))
  return data
}
let issueId = ''
let projectId = '',
  externalId = '',
  trackingId = '',
  importId = '',
  source: Buffer,
  previewToken = ''
const doc = new ExcelJS.Workbook()
const sheet = doc.addWorksheet(defaultTemplate.sheetName)
sheet.getCell('A4').value = 'TEST-NPI'
sheet.getCell('B4').value = '测试电机'
sheet.getCell('C4').value = 'TEST'
sheet.getRow(5).values = [
  '级别',
  '子件行号',
  '子件编码',
  '子件名称',
  '基本用量',
  '子件计量单位',
  '供应类型',
  '仓库名称',
  '领料部门名称',
]
sheet.getRow(6).values = [
  '+',
  10,
  '00123',
  '关键机壳',
  1,
  '只',
  '领用',
  '半成品库',
  '金工',
]
sheet.getRow(7).values = [
  '++',
  10,
  'M00123',
  '毛坯',
  1,
  '只',
  '领用',
  '原材料库',
  '金工',
]
source = Buffer.from(await doc.xlsx.writeBuffer())
const upload = () => {
  const f = new FormData()
  // This fixture uses the standard template; other tests may retain matching templates.
  f.set('templateId', defaultTemplate.id)
  f.set(
    'file',
    new File([new Uint8Array(source)], 'bom.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  )
  return f
}
try {
  await test('HTTP authentication and session actor protection', async () => {
    assert.equal((await fetch(base + '/meta')).status, 401)
    const a = accounts.technical!
    assert.equal(
      (
        await fetch(base + '/projects', {
          method: 'POST',
          headers: {
            cookie: `session=${a.token}`,
            origin: base,
            'content-type': 'application/json',
          },
          body: '{}',
        })
      ).status,
      409,
    )
  })
  await test('Durable BOM drafts survive token expiry, reparse current templates, enforce ownership and consume/discard all restored previews', async (t) => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: 'BOM草稿验收',
        motorModel: 'DRAFT-160',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const path = `/projects/${p.id}/bom`
    const tid = `draft-${crypto.randomUUID()}`
    const config = { ...defaultTemplate, id: tid, name: '草稿专用模板' }
    await client`insert into npi_import_templates(id,name,config) values(${tid},${config.name},${JSON.stringify(config)}::jsonb)`
    t.after(async () => {
      await client`update npi_import_templates set enabled=false where id=${tid}`
    })
    const data = upload()
    data.set('templateId', tid)
    const preview = await call(
      'technical',
      path + '/import-preview',
      'POST',
      data,
    )
    const old = await call('technical', `/projects/${p.id}`)
    for (const role of [
      'manufacturing',
      'procurement',
      'supervisor',
      'otherTech',
    ]) {
      await call(role, path + '/drafts', 'GET', undefined, 403)
      await call(
        role,
        path + '/drafts',
        'POST',
        { previewToken: preview.previewToken },
        403,
      )
    }
    const saved = await call('technical', path + '/drafts', 'POST', {
      previewToken: preview.previewToken,
    })
    assert.equal(
      (
        await call('technical', path + '/drafts', 'POST', {
          previewToken: preview.previewToken,
        })
      ).draftId,
      saved.draftId,
    )
    assert.equal((await call('admin', path + '/drafts')).drafts.length, 0)
    await call(
      'admin',
      `${path}/drafts/${saved.draftId}/resume`,
      'POST',
      {},
      403,
    )
    const listing = (await call('technical', path + '/drafts')).drafts
    assert.equal(listing.length, 1)
    assert.equal(listing[0].rowCount, 2)
    for (const key of [
      'sourceBase64',
      'sourceHash',
      'preview',
      'previewRows',
      'previewToken',
    ])
      assert.equal(key in listing[0], false)
    const unchanged = await call('technical', `/projects/${p.id}`)
    assert.equal(unchanged.version, old.version)
    assert.equal(unchanged.imports.length, 0)
    assert.deepEqual(unchanged.items, old.items)
    await call(
      'technical',
      path + '/import',
      'POST',
      { previewToken: preview.previewToken },
      409,
    )
    // Change the project and template while the draft's original preview is long expired.
    await client`update npi_bom_previews set expires_at=now()-interval '3 days',saved_at=now()-interval '2 days' where id=${saved.draftId}`
    await client`update npi_projects set version=version+1 where program_id=${p.id}`
    const newConfig = {
      ...config,
      name: '已更新模板',
      motherInfoMapping: { ...config.motherInfoMapping, code: 'B4' },
    }
    await client`update npi_import_templates set config=${JSON.stringify(newConfig)}::jsonb, version=version+1 where id=${tid}`
    const resumed = await call(
      'technical',
      `${path}/drafts/${saved.draftId}/resume`,
      'POST',
      {},
    )
    assert.notEqual(resumed.previewToken, preview.previewToken)
    assert.equal(resumed.templateSnapshot.name, newConfig.name)
    assert.equal(resumed.mother.code, '测试电机')
    assert.equal(resumed.sourceName, 'bom.xlsx')
    assert.equal(resumed.previewRows[0].materialCode, '00123')
    const second = await call(
      'technical',
      `${path}/drafts/${saved.draftId}/resume`,
      'POST',
      {},
    )
    const imported = await call(
      'technical',
      path + '/import',
      'POST',
      { previewToken: resumed.previewToken, activate: true },
      201,
    )
    assert.equal(imported.versionNo, 1)
    await call(
      'technical',
      path + '/import',
      'POST',
      { previewToken: second.previewToken, activate: true },
      409,
    )
    await call(
      'technical',
      `${path}/drafts/${saved.draftId}/resume`,
      'POST',
      {},
      409,
    )
    assert.equal((await call('technical', path + '/drafts')).drafts.length, 0)
    const [record] =
      await client`select source_base64, source_hash from npi_bom_imports where id=${imported.importId}`
    assert.deepEqual(Buffer.from(record!.source_base64, 'base64'), source)
    assert.equal(
      record!.source_hash,
      createHash('sha256').update(source).digest('hex'),
    )
    // Explicit removal invalidates previews already open in another tab.
    const again = await call(
      'technical',
      path + '/import-preview',
      'POST',
      (() => {
        const f = upload()
        f.set('templateId', tid)
        return f
      })(),
    )
    const d2 = await call('technical', path + '/drafts', 'POST', {
      previewToken: again.previewToken,
    })
    const r2 = await call(
      'technical',
      `${path}/drafts/${d2.draftId}/resume`,
      'POST',
      {},
    )
    assert.equal(
      (
        await call('technical', path + '/drafts', 'POST', {
          previewToken: r2.previewToken,
        })
      ).draftId,
      d2.draftId,
    )
    const r3 = await call(
      'technical',
      `${path}/drafts/${d2.draftId}/resume`,
      'POST',
      {},
    )
    await call('technical', `${path}/drafts/${d2.draftId}/discard`, 'POST', {})
    await call(
      'technical',
      path + '/import',
      'POST',
      { previewToken: r3.previewToken },
      409,
    )
    await call(
      'technical',
      `${path}/drafts/${d2.draftId}/resume`,
      'POST',
      {},
      409,
    )
    const final = await call('technical', `/projects/${p.id}`)
    assert.equal(final.imports.length, 1)
    assert.equal(
      final.events.filter(
        (e: { action: string }) => e.action === 'BOM_DRAFT_SAVED',
      ).length,
      2,
    )
    assert.equal(
      final.events.filter(
        (e: { action: string }) => e.action === 'BOM_DRAFT_DISCARDED',
      ).length,
      1,
    )
    // Disabled templates and corrupt source fail without losing the saved draft.
    const data3 = upload()
    data3.set('templateId', tid)
    const pv3 = await call('technical', path + '/import-preview', 'POST', data3)
    const d3 = await call('technical', path + '/drafts', 'POST', {
      previewToken: pv3.previewToken,
    })
    await client`update npi_import_templates set enabled=false where id=${tid}`
    await call(
      'technical',
      `${path}/drafts/${d3.draftId}/resume`,
      'POST',
      {},
      400,
    )
    assert.equal((await call('technical', path + '/drafts')).drafts.length, 1)
    assert.ok(
      (
        await call('technical', `${path}/drafts/${d3.draftId}/resume`, 'POST', {
          templateId: defaultTemplate.id,
        })
      ).previewToken,
    )
    await client`update npi_bom_previews set source_hash='bad' where id=${d3.draftId}`
    await call(
      'technical',
      `${path}/drafts/${d3.draftId}/resume`,
      'POST',
      { templateId: defaultTemplate.id },
      400,
    )
    await client`update npi_projects set current_npi_stage='completed' where program_id=${p.id}`
    await call(
      'technical',
      `${path}/drafts/${d3.draftId}/resume`,
      'POST',
      {},
      400,
    )
    await call(
      'technical',
      `${path}/drafts/${d3.draftId}/discard`,
      'POST',
      {},
      400,
    )
  })
  await test('E2E: project creation, BOM preview/import and original-file roundtrip', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: 'NPI HTTP 流程验证',
        motorModel: 'TEST-160',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    projectId = p.id
    const preview = await call(
      'technical',
      `/projects/${projectId}/bom/import-preview`,
      'POST',
      upload(),
    )
    assert.equal(preview.summary.errors, 0)
    assert.equal(preview.summary.rows, 2)
    previewToken = preview.previewToken
    const imported = await call(
      'technical',
      `/projects/${projectId}/bom/import`,
      'POST',
      { previewToken, activate: true },
      201,
    )
    importId = imported.importId
    assert.equal(imported.versionNo, 1)
    const tree = await call('technical', `/projects/${projectId}/bom/tree`)
    assert.equal(tree.nodes[0].materialCode, '00123')
    assert.equal(tree.nodes[0].children.length, 1)
    const f = await fetch(
      `${base}/projects/${projectId}/bom/${importId}/source`,
      { headers: { cookie: `session=${accounts.technical!.token}` } },
    )
    assert.equal(f.status, 200)
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(await f.arrayBuffer()))
        .digest('hex'),
      createHash('sha256').update(source).digest('hex'),
    )
    const track = await call(
      'manufacturing',
      `/bom-items/${tree.nodes[0].id}/tracking`,
      'PATCH',
      {
        ownerId: accounts.manufacturing!.id,
        requiredDate: '2026-10-15',
        trackingEnabled: true,
        affectsKit: true,
        expectedVersion: 0,
      },
    )
    trackingId = track.trackingItemId
  })
  await test('E2E: external purchase, buyer reply, manufacturing reply, incomplete prediction and bottleneck', async () => {
    const e = await call(
      'technical',
      `/projects/${projectId}/external-items`,
      'POST',
      {
        name: 'BOM外编码器',
        qty: '1',
        ownerId: accounts.procurement!.id,
        requiredDate: '2026-10-12',
        affectsKit: true,
      },
      201,
    )
    externalId = e.id
    const before = await call('technical', `/projects/${projectId}/kit-status`)
    assert.equal(before.predictionComplete, false)
    const work = await call('procurement', '/workbench/procurement')
    assert.ok(work.items.some((i: { id: string }) => i.id === externalId))
    assert.ok(!('items' in work.items[0]))
    assert.ok(!('history' in work.items[0]))
    const firstReply = await call(
      'procurement',
      `/tracking/${externalId}/promise`,
      'POST',
      {
        committedDate: '2026-10-13',
        expectedVersion: 1,
      },
    )
    assert.equal(firstReply.changeCount, 0)
    const p = await call('manufacturing', `/projects/${projectId}`)
    await call(
      'manufacturing',
      `/projects/${projectId}/manufacturing-plan`,
      'PUT',
      {
        expectedVersion: p.plan.version,
        processCommitted: '2026-10-10',
        toolingCommitted: '2026-10-11',
        kitCommitted: '2026-10-15',
        assemblyCommitted: '2026-10-20',
      },
    )
    await call('manufacturing', `/tracking/${trackingId}/promise`, 'POST', {
      committedDate: '2026-10-18',
      expectedVersion: 1,
    })
    const kit = await call('technical', `/projects/${projectId}/kit-status`)
    assert.equal(kit.predictionComplete, true)
    assert.equal(kit.predictedKitDate, '2026-10-18')
    assert.equal(kit.bottleneck.id, trackingId)
    assert.ok(
      kit.alerts.some(
        (a: { code: string }) => a.code === 'DETAIL_VS_COMMIT_CONFLICT',
      ),
    )
  })
  await test('Object permissions: procurement cannot read full project or edit another buyer/material', async () => {
    await call('procurement', `/projects/${projectId}`, 'GET', undefined, 403)
    await call(
      'otherBuyer',
      `/tracking/${externalId}/promise`,
      'POST',
      { committedDate: '2026-10-15', reason: '越权', expectedVersion: 2 },
      403,
    )
    await call(
      'procurement',
      `/tracking/${trackingId}/promise`,
      'POST',
      { committedDate: '2026-10-15', reason: '越权', expectedVersion: 2 },
      403,
    )
    await call(
      'supervisor',
      `/projects/${projectId}/external-items`,
      'POST',
      { name: '越权' },
      403,
    )
  })
  await test('Change reason and optimistic concurrency preserve first date and exactly one winning history', async () => {
    const bad = await call(
      'procurement',
      `/tracking/${externalId}/promise`,
      'POST',
      { committedDate: '2026-10-16', expectedVersion: 2 },
      400,
    )
    assert.equal(bad.code, 'PROMISE_REASON_REQUIRED')
    const a = accounts.procurement!
    const replies = await Promise.all(
      ['2026-10-16', '2026-10-17'].map((committedDate) =>
        fetch(`${base}/tracking/${externalId}/promise`, {
          method: 'POST',
          headers: {
            cookie: `session=${a.token}`,
            origin: base,
            'x-npi-actor': a.id,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            committedDate,
            reason: '供应商延迟',
            expectedVersion: 2,
          }),
        }),
      ),
    )
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409])
    const winningReply = await replies.find((r) => r.status === 200)!.json()
    assert.equal(winningReply.changeCount, 1)
    const p = await call('technical', `/projects/${projectId}`)
    const item = p.items.find((i: { id: string }) => i.id === externalId)
    assert.equal(item.firstCommittedDate, '2026-10-13')
    assert.equal(item.changeCount, 1)
    assert.equal(
      p.history.filter((h: { objectId: string }) => h.objectId === externalId)
        .length,
      2,
    )
  })
  await test('Supplier-only edits persist without changing promise history', async () => {
    const p = await call('technical', '/projects/' + projectId)
    const item = p.items.find((i: { id: string }) => i.id === externalId)
    const before = p.history.length
    const detailsReply = await call(
      'procurement',
      '/tracking/' + externalId + '/promise',
      'POST',
      {
        committedDate: item.currentCommittedDate,
        expectedVersion: item.version,
        supplier: '测试供应商',
        remark: '仅补充供应商，不改期',
      },
    )
    assert.equal(detailsReply.changeCount, item.changeCount)
    const next = await call('technical', '/projects/' + projectId)
    assert.equal(
      next.items.find((i: { id: string }) => i.id === externalId).supplier,
      '测试供应商',
    )
    assert.equal(next.history.length, before)
  })
  await test('Manufacturing plan failure rolls back earlier node promises in same request', async () => {
    const p = await call('manufacturing', `/projects/${projectId}`),
      process = p.items.find(
        (i: { trackingType: string }) => i.trackingType === 'process',
      )
    await call(
      'manufacturing',
      `/projects/${projectId}/manufacturing-plan`,
      'PUT',
      {
        expectedVersion: p.plan.version,
        processCommitted: '2026-10-12',
        toolingCommitted: '2026-10-13',
        changeReasons: { processCommitted: '测试原子回退' },
      },
      400,
    )
    const after = await call('manufacturing', `/projects/${projectId}`)
    assert.equal(after.plan.version, p.plan.version)
    assert.equal(
      after.items.find((i: { id: string }) => i.id === process.id)
        .currentCommittedDate,
      process.currentCommittedDate,
    )
    assert.equal(after.history.length, p.history.length)
  })
  await test('Import replay refused; new BOM version preserves old trees and all promises', async () => {
    const replay = await call(
      'technical',
      `/projects/${projectId}/bom/import`,
      'POST',
      { previewToken, activate: true },
      409,
    )
    assert.equal(replay.code, 'BOM_VERSION_CONFLICT')
    sheet.getCell('B6').value = 30
    sheet.getCell('E6').value = 2
    source = Buffer.from(await doc.xlsx.writeBuffer())
    const preview = await call(
      'technical',
      `/projects/${projectId}/bom/import-preview`,
      'POST',
      upload(),
    )
    const newer = await call(
      'technical',
      `/projects/${projectId}/bom/import`,
      'POST',
      { previewToken: preview.previewToken, activate: true },
      201,
    )
    assert.equal(newer.versionNo, 2)
    const old = await call(
      'technical',
      `/projects/${projectId}/bom/tree?importId=${importId}`,
    )
    assert.equal(old.versionNo, 1)
    assert.equal(old.nodes.length, 1)
    const detail = await call('technical', `/projects/${projectId}`)
    assert.equal(
      detail.items.find((i: { id: string }) => i.id === trackingId)
        .currentCommittedDate,
      '2026-10-18',
    )
  })
  await test('BOM revision review preserves identity/history and rejects unauthorized, stale or duplicate actions', async () => {
    const before = await call('technical', `/projects/${projectId}`)
    const previous = before.items.find(
      (i: { id: string }) => i.id === trackingId,
    )
    const history = before.history.filter(
      (h: { objectId: string }) => h.objectId === trackingId,
    )
    const review = await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
    )
    assert.equal(review.items.length, 1)
    assert.equal(before.bomReviewCount, 1)
    assert.ok(
      before.kit.alerts.some(
        (a: { code: string }) => a.code === 'BOM_REVIEW_PENDING',
      ),
    )
    assert.equal(before.kit.predictionComplete, false)
    const r = review.items[0]
    assert.equal(r.suggestedId, r.candidates[0].id)
    const body = {
      action: 'migrate',
      trackingItemId: trackingId,
      targetBomItemId: r.suggestedId,
      expectedVersion: r.item.version,
      expectedProjectVersion: review.projectVersion,
      activeImportId: review.activeImportId,
      reason: '已核对新版本位置和数量，沿用原承诺',
    }
    for (const role of ['procurement', 'manufacturing', 'supervisor'])
      await call(
        role,
        `/projects/${projectId}/bom/reconciliation`,
        'POST',
        body,
        403,
      )
    await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
      'POST',
      { ...body, reason: '' },
      422,
    )
    await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
      'POST',
      { ...body, expectedProjectVersion: review.projectVersion - 1 },
      409,
    )
    await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
      'POST',
      { ...body, targetBomItemId: r.oldRow.id },
      409,
    )
    const duplicate = await call(
      'manufacturing',
      `/bom-items/${r.suggestedId}/tracking`,
      'PATCH',
      {
        expectedVersion: 0,
        ownerId: accounts.manufacturing!.id,
        requiredDate: '2026-10-15',
        trackingEnabled: true,
        affectsKit: true,
      },
      409,
    )
    assert.equal(duplicate.code, 'BOM_REVIEW_REQUIRED')
    const afterFailures = await call('technical', `/projects/${projectId}`)
    assert.deepEqual(
      afterFailures.items.find((i: { id: string }) => i.id === trackingId),
      previous,
    )
    const after = await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
      'POST',
      body,
    )
    assert.equal(after.id, trackingId)
    assert.equal(after.bomItemId, r.suggestedId)
    assert.equal(after.qty, '2')
    assert.equal(r.changeType, 'MOVED')
    for (const field of [
      'ownerId',
      'requiredDate',
      'firstCommittedDate',
      'currentCommittedDate',
      'supplier',
      'remark',
    ])
      assert.equal(after[field], previous[field])
    assert.equal(after.version, previous.version + 1)
    await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
      'POST',
      body,
      409,
    )
    const detail = await call('technical', `/projects/${projectId}`)
    assert.deepEqual(
      detail.history.filter(
        (h: { objectId: string }) => h.objectId === trackingId,
      ),
      history,
    )
    assert.equal(detail.bomReviewCount, 0)
    const audit = detail.events.find(
      (e: { action: string }) => e.action === 'BOM_TRACKING_MIGRATED',
    )
    assert.equal(audit.detail.reason, body.reason)
    assert.equal(audit.detail.before.bomItemId, r.oldRow.id)
    assert.equal(audit.detail.after.bomItemId, r.suggestedId)
    assert.equal(
      (await call('technical', `/projects/${projectId}/bom/reconciliation`))
        .items.length,
      0,
    )
  })
  await test('Disabling kit impact needs a reason, retains audit, and can be reversed with version checks', async () => {
    const p = await call('technical', `/projects/${projectId}`)
    const item = p.items.find((i: { id: string }) => i.id === trackingId)
    const body = {
      expectedVersion: item.version,
      ownerId: item.ownerId,
      requiredDate: item.requiredDate,
      affectsKit: false,
      trackingEnabled: true,
    }
    const denied = await call(
      'manufacturing',
      `/bom-items/${item.bomItemId}/tracking`,
      'PATCH',
      body,
      400,
    )
    assert.equal(denied.code, 'TRACKING_REASON_REQUIRED')
    const changed = await call(
      'manufacturing',
      `/bom-items/${item.bomItemId}/tracking`,
      'PATCH',
      { ...body, reason: '此件可在装配后补装' },
    )
    const next = await call('technical', `/projects/${projectId}`)
    assert.notEqual(next.kit.bottleneck?.id, trackingId)
    const event = next.events.find(
      (e: { action: string; objectId: string }) =>
        e.action === 'TRACKING_CHANGED' && e.objectId === trackingId,
    )
    assert.equal(event.detail.reason, '此件可在装配后补装')
    await call(
      'manufacturing',
      `/bom-items/${item.bomItemId}/tracking`,
      'PATCH',
      { ...body, expectedVersion: changed.version, affectsKit: true },
    )
  })
  await test('Removed BOM material can be retired with reason; procurement, risk and history stay consistent', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '换版移除验证',
        motorModel: 'TEST-RETIRED',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const firstPreview = await call(
      'technical',
      `/projects/${p.id}/bom/import-preview`,
      'POST',
      upload(),
    )
    await call(
      'technical',
      `/projects/${p.id}/bom/import`,
      'POST',
      { previewToken: firstPreview.previewToken },
      201,
    )
    const tree = await call('technical', `/projects/${p.id}/bom/tree`)
    const track = await call(
      'technical',
      `/bom-items/${tree.rows[0].id}/tracking`,
      'PATCH',
      {
        expectedVersion: 0,
        ownerId: accounts.procurement!.id,
        requiredDate: '2026-10-15',
        affectsKit: true,
        trackingEnabled: true,
      },
    )
    await call('procurement', `/tracking/${track.id}/promise`, 'POST', {
      expectedVersion: track.version,
      committedDate: '2026-10-20',
    })
    const modified = new ExcelJS.Workbook()
    await modified.xlsx.load(
      new Uint8Array(source) as unknown as Parameters<
        typeof modified.xlsx.load
      >[0],
    )
    modified.worksheets[0]!.getCell('C6').value = 'REPLACEMENT'
    const form = new FormData()
    form.set('templateId', defaultTemplate.id)
    form.set(
      'file',
      new File(
        [new Uint8Array(await modified.xlsx.writeBuffer())],
        'removed.xlsx',
      ),
    )
    const preview = await call(
      'technical',
      `/projects/${p.id}/bom/import-preview`,
      'POST',
      form,
    )
    await call(
      'technical',
      `/projects/${p.id}/bom/import`,
      'POST',
      { previewToken: preview.previewToken },
      201,
    )
    const review = await call(
      'technical',
      `/projects/${p.id}/bom/reconciliation`,
    )
    assert.equal(review.items[0].changeType, 'REMOVED')
    assert.equal(review.items[0].candidates.length, 0)
    const body = {
      action: 'retire',
      trackingItemId: track.id,
      expectedVersion: review.items[0].item.version,
      expectedProjectVersion: review.projectVersion,
      activeImportId: review.activeImportId,
      reason: '新版设计取消此零件，经技术确认停止采购',
    }
    await call(
      'technical',
      `/projects/${p.id}/bom/reconciliation`,
      'POST',
      { ...body, reason: '' },
      422,
    )
    // A valid object ID from a different project must not be accepted.
    await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
      'POST',
      {
        ...body,
        expectedProjectVersion: (
          await call('technical', `/projects/${projectId}`)
        ).version,
        activeImportId: (await call('technical', `/projects/${projectId}`))
          .activeBomImportId,
      },
      404,
    )
    const retired = await call(
      'technical',
      `/projects/${p.id}/bom/reconciliation`,
      'POST',
      body,
    )
    assert.equal(retired.trackingEnabled, false)
    assert.equal(retired.affectsKit, false)
    assert.equal(retired.firstCommittedDate, '2026-10-20')
    assert.equal(retired.bomItemId, tree.rows[0].id)
    const next = await call('technical', `/projects/${p.id}`)
    assert.equal(next.bomReviewCount, 0)
    assert.equal(next.kit.riskCount, 0)
    assert.equal(next.kit.pendingReplyCount, 4)
    assert.equal(
      next.history.filter((h: { objectId: string }) => h.objectId === track.id)
        .length,
      1,
    )
    assert.equal(
      next.events.find(
        (e: { action: string }) => e.action === 'BOM_TRACKING_RETIRED',
      ).detail.reason,
      body.reason,
    )
    assert.ok(
      !(await call('procurement', '/workbench/procurement')).items.some(
        (i: { id: string }) => i.id === track.id,
      ),
    )
    await call(
      'procurement',
      `/tracking/${track.id}/promise`,
      'POST',
      {
        expectedVersion: retired.version,
        committedDate: '2026-10-21',
        reason: '不得继续回复已停止项',
      },
      400,
    )
  })
  await test('Completion is idempotent and excludes finished bottleneck from prediction', async () => {
    const p = await call('technical', `/projects/${projectId}`)
    const i = p.items.find((r: { id: string }) => r.id === trackingId)
    const body = {
      actualCompleteDate: '2026-09-14',
      expectedVersion: i.version,
      remark: '验收完成',
    }
    await call(
      'manufacturing',
      `/tracking/${trackingId}/complete`,
      'POST',
      body,
    )
    await call(
      'manufacturing',
      `/tracking/${trackingId}/complete`,
      'POST',
      body,
    )
    const next = await call('technical', `/projects/${projectId}`)
    assert.equal(
      next.events.filter(
        (e: { objectId: string; action: string }) =>
          e.objectId === trackingId && e.action === 'COMPLETED',
      ).length,
      1,
    )
    assert.notEqual(next.kit.bottleneck?.id, trackingId)
  })
  await test('Native Issue creation is atomic, scoped and visible in critical project risk', async () => {
    const before =
      await client`select count(*)::int as count from items where item_type='Issue'`
    await call(
      'technical',
      `/projects/${projectId}/issues`,
      'POST',
      {
        title: '必须回滚的原生Issue',
        description: '无效目标日期用于验证外层事务',
        ownerId: accounts.procurement!.id,
        severity: 'Critical',
        targetDate: 'bad',
        trackingItemId: externalId,
      },
      422,
    )
    const after =
      await client`select count(*)::int as count from items where item_type='Issue'`
    assert.equal(after[0]!.count, before[0]!.count)
    const result = await call(
      'technical',
      `/projects/${projectId}/issues`,
      'POST',
      {
        title: '关键附件交付异常',
        description: '供应商需协调样机附件交付',
        ownerId: accounts.procurement!.id,
        severity: 'Critical',
        targetDate: '2026-10-18',
        trackingItemId: externalId,
      },
      201,
    )
    issueId = result.id
    const native =
      await client`select i.item_type, q.program_id, q.assigned_to from items i join issues q on q.item_id=i.id where i.id=${issueId}`
    assert.equal(native[0]!.item_type, 'Issue')
    assert.equal(native[0]!.program_id, projectId)
    assert.equal(native[0]!.assigned_to, accounts.procurement!.id)
    const detail = await call('procurement', `/issues/${issueId}`)
    assert.equal(detail.relatedLabel, 'BOM外编码器')
    assert.equal(detail.state, 'Open')
    assert.ok(
      detail.transitions.some(
        (t: { toStateId: string }) => t.toStateId === 'InProgress',
      ),
    )
    const project = await call('technical', `/projects/${projectId}`)
    assert.equal(project.criticalIssueCount, 1)
    assert.ok(
      project.kit.alerts.some(
        (a: { code: string }) => a.code === 'CRITICAL_ISSUE_OPEN',
      ),
    )
    assert.ok(
      (await call('procurement', '/workbench/issues')).some(
        (i: { id: string }) => i.id === issueId,
      ),
    )
  })
  await test('Issue permissions preserve procurement isolation and supervisor read-only policy', async () => {
    for (const role of ['otherBuyer', 'otherTech']) {
      await call(role, `/issues/${issueId}`, 'GET', undefined, 403)
      await call(
        role,
        `/issues/${issueId}/notes`,
        'POST',
        { message: '越权' },
        403,
      )
      await call(
        role,
        `/issues/${issueId}/transition`,
        'POST',
        { toState: 'InProgress', comments: '越权' },
        403,
      )
    }
    await call(
      'procurement',
      `/projects/${projectId}/issues`,
      'GET',
      undefined,
      403,
    )
    await call('procurement', `/projects/${projectId}/issues`, 'POST', {}, 403)
    await call('procurement', `/issues/${issueId}`, 'PATCH', {}, 403)
    for (const path of [
      `/issues/${issueId}/notes`,
      `/issues/${issueId}/transition`,
    ])
      await call(
        'supervisor',
        path,
        'POST',
        { message: '只读', comments: '只读', toState: 'InProgress' },
        403,
      )
    const view = await call('supervisor', `/issues/${issueId}`)
    assert.deepEqual(view.transitions, [])
    await call(
      'technical',
      `/projects/${projectId}/issues`,
      'POST',
      {
        title: '不能扩大项目权限',
        description: '技术责任人须为项目负责人',
        ownerId: accounts.otherTech!.id,
        severity: 'High',
        targetDate: '2026-10-18',
      },
      422,
    )
    await call(
      'otherTech',
      `/projects/${projectId}/issues`,
      'GET',
      undefined,
      403,
    )
    const crossProject =
      await client`select id from npi_tracking_items where program_id <> ${projectId} limit 1`
    await call(
      'technical',
      `/projects/${projectId}/issues`,
      'POST',
      {
        title: '跨项目关联被拒绝',
        description: '已有的其他项目对象',
        ownerId: accounts.procurement!.id,
        severity: 'High',
        targetDate: '2026-10-18',
        trackingItemId: crossProject[0]!.id,
      },
      422,
    )
    const fake = crypto.randomUUID()
    await call(
      'technical',
      `/projects/${projectId}/issues`,
      'POST',
      {
        title: '越界关联',
        description: '无效对象',
        ownerId: accounts.procurement!.id,
        severity: 'High',
        targetDate: '2026-10-18',
        trackingItemId: fake,
      },
      422,
    )
    await client`update users set active=false where id=${accounts.otherBuyer!.id}`
    await call('otherBuyer', '/workbench/issues', 'GET', undefined, 401)
    await client`update users set active=true where id=${accounts.otherBuyer!.id}`
  })
  await test('Issue handoff rechecks procurement assignment after waiting for the project lock', async () => {
    accounts.otherBuyer!.token = (
      await SessionManager.createSession(accounts.otherBuyer!.id)
    ).sessionToken
    const message = `concurrent-handoff-${crypto.randomUUID()}`
    let unlock!: () => void, locked!: (pid: number) => void
    const gate = new Promise<void>((resolve) => {
      unlock = resolve
    })
    const ready = new Promise<number>((resolve) => {
      locked = resolve
    })
    const handoff = client.begin(async (tx) => {
      await tx`select program_id from npi_projects where program_id=${projectId} for update`
      await tx`update issues set assigned_to=${accounts.otherBuyer!.id} where item_id=${issueId}`
      const [connection] = await tx`select pg_backend_pid() as pid`
      locked(connection!.pid)
      await gate
    })
    // Propagate fixture failures rather than hanging while waiting for the lock.
    const pid = await Promise.race([
      ready,
      handoff.then(() => {
        throw new Error('Handoff ended before observation')
      }),
    ])
    const pending = call(
      'procurement',
      `/issues/${issueId}/notes`,
      'POST',
      { message },
      403,
    ).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    )
    try {
      let blocked = false
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const [waiting] =
          await client`select count(*)::int as count from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid)) and wait_event_type='Lock'`
        if (waiting!.count > 0) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(
        blocked,
        true,
        'The old assignee request must actually wait for the handoff lock',
      )
      unlock()
      await handoff
      const result = await pending
      if (result.error) throw result.error
      const [notes] =
        await client`select count(*)::int as count from npi_events where object_id=${issueId} and action='ISSUE_NOTE' and detail->>'message'=${message}`
      assert.equal(
        notes!.count,
        0,
        'Former assignee must not append a note after handoff',
      )
      await call(
        'otherBuyer',
        `/issues/${issueId}/notes`,
        'POST',
        {
          message: `${message}-successor`,
        },
        201,
      )
      await call('procurement', `/issues/${issueId}`, 'GET', undefined, 403)
    } finally {
      unlock()
      await handoff
      await pending
      await client`update issues set assigned_to=${accounts.procurement!.id} where item_id=${issueId}`
    }
  })
  await test('Issue note retry keys prevent duplicate concurrent appends and preserve actor, scope and handoff permissions', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '处理记录重试验证',
        motorModel: 'NOTE-RETRY',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const create = () =>
      call(
        'technical',
        `/projects/${p.id}/issues`,
        'POST',
        {
          title: '协调交期',
          description: '隔离测试记录',
          severity: 'Medium',
          ownerId: accounts.procurement!.id,
          targetDate: '2026-10-15',
        },
        201,
      )
    const first = await create(),
      second = await create(),
      requestId = crypto.randomUUID()
    const body = { requestId, message: '供应商已确认' }
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        call('procurement', `/issues/${first.id}/notes`, 'POST', body, 201),
      ),
    )
    assert.ok(responses.every((r) => r.id === first.id))
    const original =
      await client`select id,created_at from npi_events where object_id=${first.id} and actor_id=${accounts.procurement!.id} and detail->>'requestId'=${requestId}`
    assert.equal(original.length, 1)
    await call(
      'procurement',
      `/issues/${first.id}/notes`,
      'POST',
      { ...body, requestId: requestId.toUpperCase() },
      201,
    )
    assert.deepEqual(
      await client`select id,created_at from npi_events where object_id=${first.id} and actor_id=${accounts.procurement!.id} and detail->>'requestId'=${requestId}`,
      original,
    )
    await call(
      'procurement',
      `/issues/${first.id}/notes`,
      'POST',
      { ...body, message: '不同内容' },
      409,
    )
    await call('procurement', `/issues/${second.id}/notes`, 'POST', body, 409)
    for (const invalid of ['', null, 1, []])
      await call(
        'procurement',
        `/issues/${first.id}/notes`,
        'POST',
        { ...body, requestId: invalid },
        422,
      )
    await call('technical', `/issues/${first.id}/notes`, 'POST', body, 201)
    const sameKey =
      await client`select id from npi_events where program_id=${p.id} and detail->>'requestId'=${requestId}`
    assert.equal(
      sameKey.length,
      2,
      'Different actors have independent retry identities',
    )
    for (let i = 0; i < 2; i++)
      await call(
        'procurement',
        `/issues/${first.id}/notes`,
        'POST',
        { message: '兼容旧客户端' },
        201,
      )
    const legacy =
      await client`select id from npi_events where object_id=${first.id} and detail->>'message'='兼容旧客户端'`
    assert.equal(
      legacy.length,
      2,
      'Omitted keys preserve the legacy append contract',
    )
    const detail = await call('technical', `/issues/${first.id}`)
    await call('technical', `/issues/${first.id}`, 'PATCH', {
      title: detail.title,
      description: detail.description,
      severity: detail.severity,
      ownerId: accounts.otherBuyer!.id,
      targetDate: detail.targetDate,
      reason: '岗位交接',
      expectedVersion: detail.version,
      expectedModifiedAt: detail.modifiedAt,
    })
    await call('procurement', `/issues/${first.id}/notes`, 'POST', body, 403)
    await call('otherBuyer', `/issues/${first.id}/notes`, 'POST', body, 201)
  })
  await test('Issue amendments require reason and version; native transitions retain processing history', async () => {
    const first = await call('technical', `/issues/${issueId}`)
    const patch = {
      expectedVersion: first.version,
      expectedModifiedAt: first.modifiedAt,
      title: first.title,
      description: first.description,
      ownerId: first.ownerId,
      severity: first.severity,
      targetDate: '2026-10-19',
      reason: '协调交付计划后调整目标',
    }
    await call(
      'technical',
      `/issues/${issueId}`,
      'PATCH',
      { ...patch, reason: '' },
      422,
    )
    await call('technical', `/issues/${issueId}`, 'PATCH', patch)
    await call('technical', `/issues/${issueId}`, 'PATCH', patch, 409)
    await call(
      'procurement',
      `/issues/${issueId}/notes`,
      'POST',
      { message: '已联系供应商核查排产' },
      201,
    )
    const invalid = await call('procurement', `/issues/${issueId}`)
    await call(
      'procurement',
      `/issues/${issueId}/transition`,
      'POST',
      {
        expectedVersion: invalid.version,
        expectedModifiedAt: invalid.modifiedAt,
        toState: 'Closed',
        comments: '不能跳过处理',
      },
      400,
    )
    for (const toState of ['InProgress', 'Resolved', 'Verified', 'Closed']) {
      const current = await call('procurement', `/issues/${issueId}`)
      await call('procurement', `/issues/${issueId}/transition`, 'POST', {
        expectedVersion: current.version,
        expectedModifiedAt: current.modifiedAt,
        toState,
        comments: `已处理：${toState}`,
      })
      if (toState === 'Resolved')
        assert.equal(
          (await call('technical', `/projects/${projectId}`))
            .criticalIssueCount,
          1,
        )
    }
    const final = await call('technical', `/issues/${issueId}`)
    assert.equal(final.state, 'Closed')
    assert.ok(
      final.history.some(
        (h: { toState: string; comments: string }) =>
          h.toState === 'Closed' && h.comments === '已处理：Closed',
      ),
    )
    assert.ok(
      final.notes.some(
        (n: { action: string; detail: { message: string } }) =>
          n.action === 'ISSUE_NOTE' &&
          n.detail.message === '已联系供应商核查排产',
      ),
    )
    assert.equal(
      (await call('technical', `/projects/${projectId}`)).criticalIssueCount,
      0,
    )
  })
  await test('Manufacturing completion is atomic, versioned, authorized and audited; all five stages close the native Program', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '制造完成与阶段验收',
        motorModel: 'STAGE-TEST',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const path = `/projects/${p.id}`
    const detail = () => call('technical', path)
    const batchPath = `${path}/manufacturing-completion`
    const initial = await detail()
    const date = '2026-09-01'
    const batch = {
      expectedVersion: initial.plan.version,
      actualDates: { process: date, tooling: date },
    }
    for (const role of ['technical', 'procurement', 'supervisor', 'otherTech'])
      await call(role, batchPath, 'POST', batch, 403)
    for (const actualDates of [
      {},
      [],
      { unknown: date },
      { process: '' },
      { process: date, tooling: '2099-01-01' },
    ])
      await call(
        'manufacturing',
        batchPath,
        'POST',
        { ...batch, actualDates },
        422,
      )
    const rolledBack = await detail()
    assert.equal(rolledBack.plan.version, initial.plan.version)
    assert.ok(
      rolledBack.items.every(
        (i: { actualCompleteDate: unknown }) => !i.actualCompleteDate,
      ),
    )
    const auditCount = async () =>
      (
        await client`select count(*)::int as n from npi_events where program_id=${p.id} and action in ('COMPLETED','MANUFACTURING_COMPLETED')`
      )[0]!.n
    assert.equal(await auditCount(), 0)
    const done = await call('manufacturing', batchPath, 'POST', batch)
    assert.equal(done.completedIds.length, 2)
    assert.equal(done.version, initial.plan.version + 1)
    assert.equal(await auditCount(), 3)
    await call('manufacturing', batchPath, 'POST', batch, 409)
    const noop = await call('manufacturing', batchPath, 'POST', {
      ...batch,
      expectedVersion: done.version,
    })
    assert.deepEqual(noop.completedIds, [])
    assert.equal(noop.version, done.version)
    assert.equal(await auditCount(), 3)
    await call(
      'manufacturing',
      batchPath,
      'POST',
      {
        expectedVersion: done.version,
        actualDates: { kit: date, process: '2026-09-02' },
      },
      400,
    )
    assert.equal(
      (await detail()).items.find(
        (i: { trackingType: string }) => i.trackingType === 'kit',
      ).actualCompleteDate,
      null,
    )
    const account = accounts.manufacturing!
    const races = await Promise.all(
      ['kit', 'assembly'].map((key) =>
        fetch(base + batchPath, {
          method: 'POST',
          headers: {
            cookie: `session=${account.token}`,
            origin: base,
            'x-npi-actor': account.id,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            expectedVersion: done.version,
            actualDates: { [key]: date },
          }),
        }),
      ),
    )
    assert.deepEqual(races.map((r) => r.status).sort(), [200, 409])
    const afterRace = await detail()
    assert.equal(afterRace.plan.version, done.version + 1)
    // Single-node completion updates the same plan version; an old batch cannot overwrite it.
    const last = afterRace.items.find(
      (i: { actualCompleteDate: unknown }) => !i.actualCompleteDate,
    )
    await call('manufacturing', `/tracking/${last.id}/complete`, 'POST', {
      expectedVersion: last.version,
      actualCompleteDate: date,
    })
    await call(
      'manufacturing',
      batchPath,
      'POST',
      {
        expectedVersion: afterRace.plan.version,
        actualDates: { [last.trackingType]: date },
      },
      409,
    )
    const afterSingle = await detail()
    await call('manufacturing', `/tracking/${last.id}/complete`, 'POST', {
      expectedVersion: last.version,
      actualCompleteDate: date,
    })
    assert.equal((await detail()).plan.version, afterSingle.plan.version)
    const purchase = await call(
      'technical',
      `${path}/external-items`,
      'POST',
      {
        name: '待验收关键采购件',
        qty: '1',
        trackingType: 'purchase',
        ownerId: accounts.procurement!.id,
        requiredDate: '2026-10-15',
        affectsKit: true,
      },
      201,
    )
    await call(
      'technical',
      `${path}/stage`,
      'PATCH',
      { expectedVersion: (await detail()).version, currentNpiStage: 'test' },
      400,
    )
    await call(
      'technical',
      `${path}/stage`,
      'PATCH',
      {
        expectedVersion: (await detail()).version,
        currentNpiStage: 'manufacturing',
        drawingCompleteDate: '2099-01-01',
      },
      422,
    )
    for (const stage of ['manufacturing', 'prototype', 'test']) {
      const current = await detail()
      const payload = {
        expectedVersion: current.version,
        currentNpiStage: stage,
        drawingCompleteDate: date,
      }
      await call('supervisor', `${path}/stage`, 'PATCH', payload, 403)
      await call('technical', `${path}/stage`, 'PATCH', payload)
      await call('technical', `${path}/stage`, 'PATCH', payload, 409)
    }
    const beforeClose = await detail()
    await call(
      'technical',
      `${path}/stage`,
      'PATCH',
      { expectedVersion: beforeClose.version, currentNpiStage: 'completed' },
      400,
    )
    assert.equal((await detail()).currentNpiStage, 'test')
    assert.notEqual(
      (await client`select status from programs where id=${p.id}`)[0]!.status,
      'Completed',
    )
    await call('procurement', `/tracking/${purchase.id}/complete`, 'POST', {
      expectedVersion: purchase.version,
      actualCompleteDate: date,
    })
    await call('technical', `${path}/stage`, 'PATCH', {
      expectedVersion: (await detail()).version,
      currentNpiStage: 'completed',
    })
    const closed = await detail()
    assert.equal(closed.currentNpiStage, 'completed')
    assert.equal(closed.drawingCompleteDate, date)
    assert.equal(
      (await client`select status from programs where id=${p.id}`)[0]!.status,
      'Completed',
    )
    assert.equal(
      (
        await client`select count(*)::int as n from npi_events where program_id=${p.id} and action='STAGE_CHANGED'`
      )[0]!.n,
      4,
    )
    await call(
      'manufacturing',
      batchPath,
      'POST',
      { expectedVersion: closed.plan.version, actualDates: { process: date } },
      400,
    )
    await call(
      'manufacturing',
      `/tracking/${last.id}/promise`,
      'POST',
      { expectedVersion: last.version, committedDate: date },
      400,
    )
  })
  await test('Supervisor planning is reasoned, versioned and audited without granting replies, completion or administration', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '主管计划调整验收',
        motorModel: 'SUPERVISOR-PLAN',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const path = `/projects/${p.id}`
    const detail = () => call('supervisor', path)
    const item = await call(
      'technical',
      `${path}/external-items`,
      'POST',
      {
        name: '主管协调采购件',
        qty: '1',
        ownerId: accounts.procurement!.id,
        requiredDate: '2026-10-15',
        affectsKit: true,
      },
      201,
    )
    const reply = await call(
      'procurement',
      `/tracking/${item.id}/promise`,
      'POST',
      {
        expectedVersion: item.version,
        committedDate: '2026-10-18',
      },
    )
    const planPayload = {
      expectedVersion: reply.version,
      requiredDate: '2026-10-17',
      ownerId: accounts.otherBuyer!.id,
      reason: '主管协调采购责任与要求日期',
    }
    await call(
      'supervisor',
      `/tracking/${item.id}/plan`,
      'PATCH',
      { ...planPayload, reason: '' },
      400,
    )
    await call(
      'supervisor',
      `/tracking/${item.id}/plan`,
      'PATCH',
      { ...planPayload, expectedVersion: reply.version - 1 },
      409,
    )
    await call(
      'supervisor',
      `/tracking/${item.id}/plan`,
      'PATCH',
      { ...planPayload, ownerId: accounts.manufacturing!.id },
      422,
    )
    const adjusted = await call(
      'supervisor',
      `/tracking/${item.id}/plan`,
      'PATCH',
      planPayload,
    )
    assert.equal(adjusted.ownerId, accounts.otherBuyer!.id)
    assert.equal(adjusted.requiredDate, '2026-10-17')
    assert.equal(adjusted.firstCommittedDate, reply.firstCommittedDate)
    assert.equal(adjusted.currentCommittedDate, reply.currentCommittedDate)
    await call(
      'procurement',
      `/tracking/${item.id}/promise`,
      'POST',
      {
        expectedVersion: adjusted.version,
        committedDate: '2026-10-19',
        reason: '原采购已交接',
      },
      403,
    )
    await call(
      'supervisor',
      `/tracking/${item.id}/promise`,
      'POST',
      {
        expectedVersion: adjusted.version,
        committedDate: '2026-10-19',
        reason: '不可代填',
      },
      403,
    )
    await call(
      'supervisor',
      `/tracking/${item.id}/complete`,
      'POST',
      { expectedVersion: adjusted.version, actualCompleteDate: '2026-09-15' },
      403,
    )
    await call(
      'supervisor',
      `/tracking/${item.id}/completion-correction`,
      'POST',
      {
        expectedVersion: adjusted.version,
        actualCompleteDate: '2026-09-15',
        reason: '不可更正实际',
      },
      403,
    )
    const original = await detail()
    const process = original.items.find(
      (i: { trackingType: string }) => i.trackingType === 'process',
    )
    await call('supervisor', `/tracking/${process.id}/plan`, 'PATCH', {
      expectedVersion: process.version,
      requiredDate: '2026-10-09',
      reason: '工艺单独要求',
    })
    const issue = await call(
      'technical',
      `${path}/issues`,
      'POST',
      {
        title: '随技术负责人交接的问题',
        description: '保持原生问题和审计',
        severity: 'Medium',
        ownerId: accounts.technical!.id,
        targetDate: '2026-10-12',
      },
      201,
    )
    const proposal = {
      expectedVersion: (await detail()).version,
      technicalOwnerId: accounts.otherTech!.id,
      requiredKitDate: '2026-10-17',
      prototypeRequiredDate: '2026-10-23',
      customer: '主管核对客户',
      reason: '主管协调新品目标与技术交接',
    }
    await call(
      'supervisor',
      `${path}/change-preview`,
      'POST',
      { ...proposal, reason: '' },
      422,
    )
    const preview = await call(
      'supervisor',
      `${path}/change-preview`,
      'POST',
      proposal,
    )
    assert.equal(preview.canContinue, true)
    await call(
      'supervisor',
      `${path}/plan`,
      'PATCH',
      { ...proposal, expectedSnapshot: 'stale' },
      409,
    )
    // Permissions are checked again at submission, not inherited from preview.
    await client`update npi_user_roles set role='procurement' where user_id=${accounts.supervisor!.id}`
    try {
      await call(
        'supervisor',
        `${path}/plan`,
        'PATCH',
        { ...proposal, expectedSnapshot: preview.expectedSnapshot },
        403,
      )
      await call(
        'supervisor',
        `/tracking/${item.id}/plan`,
        'PATCH',
        { ...planPayload, expectedVersion: adjusted.version },
        403,
      )
    } finally {
      await client`update npi_user_roles set role='supervisor' where user_id=${accounts.supervisor!.id}`
    }
    const applied = await call('supervisor', `${path}/plan`, 'PATCH', {
      ...proposal,
      expectedSnapshot: preview.expectedSnapshot,
    })
    assert.equal(applied.canContinue, true)
    await call('technical', path, 'GET', undefined, 403)
    const latest = await detail()
    assert.equal(latest.technicalOwnerId, accounts.otherTech!.id)
    assert.equal(latest.requiredKitDate, '2026-10-17')
    assert.equal(latest.prototypeRequiredDate, '2026-10-23')
    assert.equal(latest.profile.customer, '主管核对客户')
    assert.equal(
      latest.items.find((i: { id: string }) => i.id === process.id)
        .requiredDate,
      '2026-10-09',
    )
    assert.equal(
      (await call('supervisor', `/issues/${issue.id}`)).ownerId,
      accounts.otherTech!.id,
    )
    const current = latest.items.find((i: { id: string }) => i.id === item.id)
    assert.equal(current.firstCommittedDate, reply.firstCommittedDate)
    assert.equal(current.currentCommittedDate, reply.currentCommittedDate)
    assert.equal(
      (
        await client`select count(*)::int as n from npi_promise_history where object_id=${item.id}`
      )[0]!.n,
      1,
    )
    const events =
      await client`select actor_id,action,detail from npi_events where program_id=${p.id} and action in ('PROJECT_CHANGED','TRACKING_PLAN_ADJUSTED')`
    assert.ok(events.length >= 3)
    assert.ok(
      events.every(
        (e) => e.actor_id === accounts.supervisor!.id && e.detail.reason,
      ),
    )
    await call(
      'supervisor',
      `${path}/manufacturing-plan`,
      'PUT',
      { expectedVersion: latest.plan.version, processCommitted: '2026-10-10' },
      403,
    )
    await call(
      'supervisor',
      `${path}/manufacturing-completion`,
      'POST',
      {
        expectedVersion: latest.plan.version,
        actualDates: { process: '2026-09-15' },
      },
      403,
    )
    await call(
      'supervisor',
      `${path}/stage`,
      'PATCH',
      {
        expectedVersion: latest.version,
        currentNpiStage: 'manufacturing',
        drawingCompleteDate: '2026-09-15',
      },
      403,
    )
    await call(
      'supervisor',
      `${path}/external-items`,
      'POST',
      {
        name: '不可新增',
        qty: '1',
        ownerId: accounts.procurement!.id,
        requiredDate: '2026-10-15',
      },
      403,
    )
    await call(
      'supervisor',
      '/roles',
      'PUT',
      { userId: accounts.otherTech!.id, role: 'admin' },
      403,
    )
    // A closed-project fixture exercises the new permission's existing read-only boundary.
    await client`update npi_projects set current_npi_stage='completed' where program_id=${p.id}`
    await call(
      'supervisor',
      `${path}/change-preview`,
      'POST',
      { ...proposal, expectedVersion: latest.version },
      400,
    )
    await call(
      'supervisor',
      `/tracking/${item.id}/plan`,
      'PATCH',
      { ...planPayload, expectedVersion: current.version },
      400,
    )
  })
  await test('Planning handoff and completion correction retain promises and audit, revoke old ownership, and enforce project controls', async () => {
    // The earlier inactive-account test revoked this session; sign in again for handoff checks.
    accounts.otherBuyer!.token = (
      await SessionManager.createSession(accounts.otherBuyer!.id)
    ).sessionToken
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '计划调整与实际更正验收',
        motorModel: 'AMENDMENT-TEST',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const detail = () => call('technical', `/projects/${p.id}`)
    const item = await call(
      'technical',
      `/projects/${p.id}/external-items`,
      'POST',
      {
        name: '交接采购件',
        qty: '2',
        ownerId: accounts.procurement!.id,
        requiredDate: '2026-10-15',
        affectsKit: true,
      },
      201,
    )
    const replied = await call(
      'procurement',
      `/tracking/${item.id}/promise`,
      'POST',
      {
        expectedVersion: item.version,
        committedDate: '2026-10-18',
      },
    )
    const plan = `/tracking/${item.id}/plan`
    const correction = `/tracking/${item.id}/completion-correction`
    const payload = {
      expectedVersion: replied.version,
      ownerId: accounts.otherBuyer!.id,
      requiredDate: '2026-10-20',
      reason: '采购交接与客户计划调整',
    }
    for (const role of ['procurement', 'otherBuyer', 'otherTech']) {
      await call(role, plan, 'PATCH', payload, 403)
      await call(
        role,
        correction,
        'POST',
        {
          expectedVersion: replied.version,
          actualCompleteDate: '2026-09-01',
          reason: '无权更正',
        },
        403,
      )
    }
    await call('technical', plan, 'PATCH', { ...payload, reason: '' }, 400)
    await call(
      'technical',
      plan,
      'PATCH',
      { ...payload, ownerId: accounts.technical!.id },
      422,
    )
    await call(
      'technical',
      plan,
      'PATCH',
      { ...payload, requiredDate: '2026-02-30' },
      422,
    )
    await call(
      'technical',
      correction,
      'POST',
      {
        expectedVersion: replied.version,
        actualCompleteDate: '2026-09-01',
        reason: '尚未完成',
      },
      400,
    )
    const changed = await call('technical', plan, 'PATCH', payload)
    assert.equal(changed.firstCommittedDate, '2026-10-18')
    assert.equal(changed.currentCommittedDate, '2026-10-18')
    assert.equal(changed.ownerId, accounts.otherBuyer!.id)
    assert.equal(changed.status, 'normal')
    assert.equal(
      (await call('procurement', '/workbench/procurement')).items.some(
        (i: { id: string }) => i.id === item.id,
      ),
      false,
    )
    assert.equal(
      (await call('otherBuyer', '/workbench/procurement')).items.some(
        (i: { id: string }) => i.id === item.id,
      ),
      true,
    )
    await call(
      'procurement',
      `/tracking/${item.id}/promise`,
      'POST',
      {
        expectedVersion: changed.version,
        committedDate: '2026-10-19',
        reason: '旧负责人失权',
      },
      403,
    )
    await call(
      'procurement',
      `/tracking/${item.id}/complete`,
      'POST',
      { expectedVersion: changed.version, actualCompleteDate: '2026-09-01' },
      403,
    )
    await call('technical', plan, 'PATCH', payload, 409)
    const unchanged = await call('technical', plan, 'PATCH', {
      ...payload,
      expectedVersion: changed.version,
    })
    assert.equal(unchanged.version, changed.version)
    const beforeComplete = await detail()
    assert.equal(beforeComplete.history.length, 1)
    const audit = beforeComplete.events.filter(
      (e: { action: string }) => e.action === 'TRACKING_PLAN_ADJUSTED',
    )
    assert.equal(audit.length, 1)
    assert.equal(audit[0].detail.before.ownerId, accounts.procurement!.id)
    assert.equal(audit[0].detail.after.requiredDate, '2026-10-20')
    assert.equal(audit[0].actorId, accounts.technical!.id)
    const completed = await call(
      'otherBuyer',
      `/tracking/${item.id}/complete`,
      'POST',
      { expectedVersion: changed.version, actualCompleteDate: '2026-09-01' },
    )
    const correct = {
      expectedVersion: completed.version,
      actualCompleteDate: '2026-09-02',
      reason: '验收单日期录入有误',
    }
    await call('technical', correction, 'POST', { ...correct, reason: '' }, 400)
    await call(
      'technical',
      correction,
      'POST',
      { ...correct, actualCompleteDate: null },
      422,
    )
    await call(
      'technical',
      correction,
      'POST',
      { ...correct, actualCompleteDate: '2099-01-01' },
      422,
    )
    await call(
      'technical',
      plan,
      'PATCH',
      { ...payload, expectedVersion: completed.version },
      400,
    )
    const fixed = await call('manufacturing', correction, 'POST', correct)
    assert.equal(fixed.actualCompleteDate, '2026-09-02')
    assert.equal(fixed.status, 'completed')
    assert.equal(fixed.firstCommittedDate, '2026-10-18')
    await call('technical', correction, 'POST', correct, 409)
    const noChange = await call('technical', correction, 'POST', {
      ...correct,
      expectedVersion: fixed.version,
    })
    assert.equal(noChange.version, fixed.version)
    const after = await detail()
    const corrections = after.events.filter(
      (e: { action: string }) => e.action === 'COMPLETION_CORRECTED',
    )
    assert.equal(corrections.length, 1)
    assert.equal(corrections[0].detail.before.actualCompleteDate, '2026-09-01')
    assert.equal(corrections[0].detail.after.actualCompleteDate, '2026-09-02')
    assert.equal(corrections[0].detail.reason, correct.reason)
    assert.equal(
      after.events.find((e: { action: string }) => e.action === 'COMPLETED')
        .detail.actualCompleteDate,
      '2026-09-01',
    )
    assert.equal(after.history.length, 1)
    const node = after.items.find(
      (i: { trackingType: string }) => i.trackingType === 'process',
    )
    await call(
      'technical',
      `/tracking/${node.id}/plan`,
      'PATCH',
      {
        expectedVersion: node.version,
        ownerId: accounts.technical!.id,
        reason: '节点不能单独移交',
      },
      422,
    )
    await call('technical', `/tracking/${node.id}/plan`, 'PATCH', {
      expectedVersion: node.version,
      requiredDate: '2026-10-12',
      reason: '工艺需要提前',
    })
    const newPlan = (await detail()).plan
    assert.equal(newPlan.version, after.plan.version + 1)
    await call(
      'manufacturing',
      `/projects/${p.id}/manufacturing-plan`,
      'PUT',
      { expectedVersion: newPlan.version, processRequired: '2026-10-13' },
      400,
    )
    await call('manufacturing', `/projects/${p.id}/manufacturing-plan`, 'PUT', {
      expectedVersion: newPlan.version,
      processRequired: '2026-10-13',
      changeReasons: { processRequired: '产线窗口调整' },
    })
    const nodes = await detail()
    await call(
      'manufacturing',
      `/projects/${p.id}/manufacturing-completion`,
      'POST',
      {
        expectedVersion: nodes.plan.version,
        actualDates: {
          process: '2026-09-01',
          tooling: '2026-09-01',
          kit: '2026-09-01',
          assembly: '2026-09-01',
        },
      },
    )
    const beforeNodeCorrection = await detail()
    const doneNode = beforeNodeCorrection.items.find(
      (i: { id: string }) => i.id === node.id,
    )
    await call(
      'technical',
      `/tracking/${node.id}/completion-correction`,
      'POST',
      {
        expectedVersion: doneNode.version,
        actualCompleteDate: '2026-09-02',
        reason: '工艺签字日期修正',
      },
    )
    assert.equal(
      (await detail()).plan.version,
      beforeNodeCorrection.plan.version + 1,
    )
    for (const stage of ['manufacturing', 'prototype', 'test', 'completed'])
      await call('technical', `/projects/${p.id}/stage`, 'PATCH', {
        expectedVersion: (await detail()).version,
        currentNpiStage: stage,
        drawingCompleteDate: '2026-09-01',
      })
    await call(
      'technical',
      correction,
      'POST',
      {
        ...correct,
        expectedVersion: fixed.version,
        actualCompleteDate: '2026-09-03',
      },
      400,
    )
  })
  await test('Project change preview is scoped, invalidated by intervening work, atomic across native issues and preserves custom/completed dates', async () => {
    const newMfg = crypto.randomUUID()
    await client`insert into users(id,email,name,active) values(${newMfg},${newMfg + '@test.invalid'},'接任制造',true)`
    await client`insert into npi_user_roles(user_id,role) values(${newMfg},'manufacturing')`
    accounts.nextMfg = {
      id: newMfg,
      token: (await SessionManager.createSession(newMfg)).sessionToken,
    }
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '项目整体交接验收',
        motorModel: 'CHANGE-PROJECT',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const path = `/projects/${p.id}`
    const detail = (role = 'technical') => call(role, path)
    const material = await call(
      'technical',
      `${path}/external-items`,
      'POST',
      {
        name: '旧技术负责的试制件',
        qty: '1',
        trackingType: 'material',
        ownerId: accounts.technical!.id,
        requiredDate: '2026-10-12',
        affectsKit: true,
      },
      201,
    )
    const purchase = await call(
      'technical',
      `${path}/external-items`,
      'POST',
      {
        name: '独立采购责任保留',
        qty: '1',
        ownerId: accounts.procurement!.id,
        requiredDate: '2026-10-12',
        affectsKit: true,
      },
      201,
    )
    const start = await detail()
    const tooling = start.items.find(
      (i: { trackingType: string }) => i.trackingType === 'tooling',
    )
    const assembly = start.items.find(
      (i: { trackingType: string }) => i.trackingType === 'assembly',
    )
    const process = start.items.find(
      (i: { trackingType: string }) => i.trackingType === 'process',
    )
    await call('manufacturing', `/tracking/${tooling.id}/plan`, 'PATCH', {
      expectedVersion: tooling.version,
      requiredDate: '2026-10-10',
      reason: '工装单独排产',
    })
    await call('manufacturing', `/tracking/${assembly.id}/complete`, 'POST', {
      expectedVersion: assembly.version,
      actualCompleteDate: '2026-09-01',
    })
    const issue = await call(
      'technical',
      `${path}/issues`,
      'POST',
      {
        title: '需要交接的装配问题',
        description: '装配配合核验',
        severity: 'High',
        ownerId: accounts.manufacturing!.id,
        targetDate: '2026-10-16',
      },
      201,
    )
    const closedIssue = await call(
      'technical',
      `${path}/issues`,
      'POST',
      {
        title: '已经关闭的技术问题',
        description: '保留历史责任人',
        severity: 'Medium',
        ownerId: accounts.technical!.id,
        targetDate: '2026-10-16',
      },
      201,
    )
    for (const state of ['InProgress', 'Resolved', 'Verified', 'Closed']) {
      const current = await call('technical', `/issues/${closedIssue.id}`)
      await call('technical', `/issues/${closedIssue.id}/transition`, 'POST', {
        expectedVersion: current.version,
        expectedModifiedAt: current.modifiedAt,
        toState: state,
        comments: '历史问题已完成核验',
      })
    }
    const before = await detail()
    const members =
      await client`select * from program_members where program_id=${p.id} order by id`
    const proposal = {
      expectedVersion: before.version,
      name: '交接后的新品',
      motorModel: 'CHANGE-UPDATED',
      technicalOwnerId: accounts.otherTech!.id,
      manufacturingOwnerId: newMfg,
      requiredKitDate: '2026-10-17',
      prototypeRequiredDate: '2026-10-23',
      reason: '客户计划调整并完成负责人交接',
    }
    for (const role of ['manufacturing', 'procurement', 'otherTech']) {
      await call(role, `${path}/change-preview`, 'POST', proposal, 403)
      await call(role, `${path}/plan`, 'PATCH', proposal, 403)
    }
    await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      { ...proposal, reason: '' },
      422,
    )
    await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      { ...proposal, requiredKitDate: null },
      422,
    )
    await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      { ...proposal, requiredKitDate: '2026-10-24' },
      422,
    )
    await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      { ...proposal, manufacturingOwnerId: accounts.procurement!.id },
      422,
    )
    const preview = await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      proposal,
    )
    assert.equal(preview.tracking.length, 5)
    assert.equal(preview.issues.length, 1)
    assert.equal(preview.retainedDates.length, 2)
    assert.equal(preview.canContinue, false)
    await call(
      'technical',
      `${path}/plan`,
      'PATCH',
      {
        ...proposal,
        requiredKitDate: '2026-10-16',
        expectedSnapshot: preview.expectedSnapshot,
      },
      409,
    )
    await call('manufacturing', `/tracking/${process.id}/promise`, 'POST', {
      expectedVersion: process.version,
      committedDate: '2026-10-19',
    })
    await call(
      'technical',
      `${path}/plan`,
      'PATCH',
      { ...proposal, expectedSnapshot: preview.expectedSnapshot },
      409,
    )
    const fresh = await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      proposal,
    )
    const beforeFailure = await detail()
    const { mock } = await import('node:test')
    const { ItemService } =
      await import('../packages/core/src/lib/items/services/ItemService')
    const fault = mock.method(ItemService, 'update', () => {
      throw new Error('Synthetic native issue update failure')
    })
    try {
      await call(
        'technical',
        `${path}/plan`,
        'PATCH',
        { ...proposal, expectedSnapshot: fresh.expectedSnapshot },
        500,
      )
    } finally {
      fault.mock.restore()
    }
    const rolledBack = await detail()
    assert.equal(rolledBack.version, beforeFailure.version)
    assert.deepEqual(rolledBack.items, beforeFailure.items)
    assert.equal(rolledBack.plan.version, beforeFailure.plan.version)
    assert.equal(rolledBack.events.length, beforeFailure.events.length)
    assert.equal(rolledBack.name, beforeFailure.name)
    assert.equal(
      (await call('technical', `/issues/${issue.id}`)).ownerId,
      accounts.manufacturing!.id,
    )
    const applied = await call('technical', `${path}/plan`, 'PATCH', {
      ...proposal,
      expectedSnapshot: fresh.expectedSnapshot,
    })
    assert.equal(applied.canContinue, false)
    await call('technical', path, 'GET', undefined, 403)
    await call('manufacturing', path, 'GET', undefined, 403)
    await call(
      'technical',
      `/tracking/${material.id}/promise`,
      'POST',
      { expectedVersion: material.version, committedDate: '2026-10-18' },
      403,
    )
    const changed = await detail('otherTech')
    assert.equal(changed.version, before.version + 1)
    assert.equal(changed.name, '交接后的新品')
    assert.equal(changed.manufacturingOwnerId, newMfg)
    const handoffAudit = changed.events.find(
      (e: { action: string }) => e.action === 'PROJECT_CHANGED',
    )
    assert.equal(
      handoffAudit.detail.before.technicalOwnerId,
      accounts.technical!.id,
    )
    assert.equal(
      handoffAudit.detail.after.technicalOwnerId,
      accounts.otherTech!.id,
    )
    assert.equal(
      changed.items.find((i: { id: string }) => i.id === material.id).ownerId,
      accounts.otherTech!.id,
    )
    assert.equal(
      changed.items.find((i: { id: string }) => i.id === purchase.id).ownerId,
      accounts.procurement!.id,
    )
    assert.equal(
      changed.items.find((i: { id: string }) => i.id === process.id)
        .requiredDate,
      '2026-10-17',
    )
    assert.equal(
      changed.items.find((i: { id: string }) => i.id === process.id)
        .firstCommittedDate,
      '2026-10-19',
    )
    assert.equal(
      changed.items.find((i: { id: string }) => i.id === tooling.id)
        .requiredDate,
      '2026-10-10',
    )
    assert.equal(
      changed.items.find((i: { id: string }) => i.id === assembly.id)
        .requiredDate,
      '2026-10-20',
    )
    assert.equal(
      changed.items.find((i: { id: string }) => i.id === assembly.id)
        .actualCompleteDate,
      '2026-09-01',
    )
    assert.ok(
      changed.items
        .filter((i: { sourceType: string }) => i.sourceType === 'MANUFACTURING')
        .every((i: { ownerId: string }) => i.ownerId === newMfg),
    )
    assert.equal(changed.plan.version, beforeFailure.plan.version + 1)
    assert.deepEqual(changed.history, beforeFailure.history)
    assert.deepEqual(
      await client`select * from program_members where program_id=${p.id} order by id`,
      members,
    )
    const native = (
      await client`select name,target_end_date from programs where id=${p.id}`
    )[0]!
    assert.equal(native.name, '交接后的新品')
    assert.equal(
      new Date(native.target_end_date).toISOString(),
      '2026-10-22T16:00:00.000Z',
    )
    const historicalIssue = await call('otherTech', `/issues/${closedIssue.id}`)
    assert.equal(historicalIssue.ownerId, accounts.technical!.id)
    assert.equal(historicalIssue.state, 'Closed')
    const movedIssue = await call('otherTech', `/issues/${issue.id}`)
    assert.equal(movedIssue.ownerId, newMfg)
    assert.equal(movedIssue.state, 'Open')
    assert.equal(movedIssue.version, 2)
    await call('manufacturing', `/issues/${issue.id}`, 'GET', undefined, 403)
    await call(
      'nextMfg',
      `/issues/${issue.id}/notes`,
      'POST',
      {
        message: '已接手装配核验',
      },
      201,
    )
    const unchangedProposal = { ...proposal, expectedVersion: changed.version }
    const noChanges = await call(
      'otherTech',
      `${path}/change-preview`,
      'POST',
      unchangedProposal,
    )
    const noOp = await call('otherTech', `${path}/plan`, 'PATCH', {
      ...unchangedProposal,
      expectedSnapshot: noChanges.expectedSnapshot,
    })
    assert.equal(noOp.version, changed.version)
    assert.equal(
      (await detail('otherTech')).events.filter(
        (e: { action: string }) => e.action === 'PROJECT_CHANGED',
      ).length,
      1,
    )
    // Renaming NPI must not overwrite an independently edited native Program date.
    await client`update programs set target_end_date='2030-01-01T00:00:00Z' where id=${p.id}`
    const rename = {
      expectedVersion: changed.version,
      name: '只调整项目名称',
      reason: '名称核对',
    }
    const renamePreview = await call(
      'otherTech',
      `${path}/change-preview`,
      'POST',
      rename,
    )
    await call('otherTech', `${path}/plan`, 'PATCH', {
      ...rename,
      expectedSnapshot: renamePreview.expectedSnapshot,
    })
    const nativeDate = (
      await client`select target_end_date from programs where id=${p.id}`
    )[0]!.target_end_date
    assert.equal(new Date(nativeDate).toISOString(), '2030-01-01T00:00:00.000Z')
  })
  await test('Project profile uses native customer/description and namespaced motor data, preserves unrelated attributes and audits authorized changes', async () => {
    const data = {
      name: `电机补充信息验收-${crypto.randomUUID()}`,
      motorModel: 'XYT160M18P8',
      technicalOwnerId: accounts.technical!.id,
      manufacturingOwnerId: accounts.manufacturing!.id,
      requiredKitDate: '2026-10-15',
      prototypeRequiredDate: '2026-10-20',
      customer: '协同机电',
      application: '轴流风机',
      ratedPowerKw: '7.500',
      ratedVoltageV: 380,
      poles: 8,
      description: '样机开发\n验证温升',
    }
    await call(
      'technical',
      '/projects',
      'POST',
      { ...data, ratedPowerKw: -1 },
      422,
    )
    assert.equal(
      (
        await client`select count(*)::int as n from programs where name=${data.name}`
      )[0]!.n,
      0,
    )
    const p = await call('technical', '/projects', 'POST', data, 201),
      path = `/projects/${p.id}`
    const original = await call('technical', path)
    assert.deepEqual(original.profile, {
      customer: '协同机电',
      application: '轴流风机',
      ratedPowerKw: '7.5',
      ratedVoltageV: '380',
      poles: '8',
      description: '样机开发\n验证温升',
    })
    assert.equal(original.createdBy, accounts.technical!.id)
    assert.equal(
      original.events.find(
        (e: { action: string }) => e.action === 'PROJECT_CREATED',
      ).detail.profile.ratedPowerKw,
      '7.5',
    )
    assert.ok(!Object.hasOwn(original, 'attributes'))
    assert.equal((await call('supervisor', path)).profile.ratedVoltageV, '380')
    await call('procurement', path, 'GET', undefined, 403)
    await call('otherTech', path, 'GET', undefined, 403)
    await client`update programs set attributes=jsonb_set(attributes || '{"externalPlugin":{"keep":true}}'::jsonb,'{npiMotorSpec,insulationClass}','"F"'::jsonb),target_end_date='2030-01-01T00:00:00Z' where id=${p.id}`
    const proposal = {
      expectedVersion: original.version,
      customer: null,
      ratedPowerKw: '11.000',
      description: '参数核对后更新',
      reason: '客户确认额定功率',
    }
    for (const role of ['manufacturing', 'procurement', 'otherTech'])
      await call(role, `${path}/change-preview`, 'POST', proposal, 403)
    await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      { ...proposal, reason: '' },
      422,
    )
    await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      { ...proposal, poles: '8.5' },
      422,
    )
    const first = await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      proposal,
    )
    assert.ok(
      first.changes.some(
        (c: { key: string; before: string; after: string }) =>
          c.key === 'ratedPowerKw' && c.before === '7.5' && c.after === '11',
      ),
    )
    await client`update programs set description='原生项目另行调整' where id=${p.id}`
    await call(
      'technical',
      `${path}/plan`,
      'PATCH',
      { ...proposal, expectedSnapshot: first.expectedSnapshot },
      409,
    )
    const preview = await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      proposal,
    )
    await call('technical', `${path}/plan`, 'PATCH', {
      ...proposal,
      expectedSnapshot: preview.expectedSnapshot,
    })
    const updated = await call('technical', path)
    assert.equal(updated.profile.ratedPowerKw, '11')
    assert.equal(updated.profile.customer, '')
    assert.equal(updated.profile.description, '参数核对后更新')
    assert.equal(updated.version, original.version + 1)
    assert.equal(updated.plan.version, original.plan.version)
    assert.deepEqual(updated.items, original.items)
    assert.deepEqual(updated.history, original.history)
    const native = (
      await client`select customer,description,attributes,target_end_date from programs where id=${p.id}`
    )[0]!
    assert.equal(native.customer, null)
    assert.equal(native.description, '参数核对后更新')
    assert.deepEqual(native.attributes, {
      npi: true,
      externalPlugin: { keep: true },
      npiMotorSpec: {
        application: '轴流风机',
        ratedPowerKw: '11',
        ratedVoltageV: '380',
        poles: '8',
        insulationClass: 'F',
      },
    })
    assert.equal(
      new Date(native.target_end_date).toISOString(),
      '2030-01-01T00:00:00.000Z',
    )
    const audit = updated.events.find(
      (e: { action: string }) => e.action === 'PROJECT_CHANGED',
    )
    assert.equal(audit.detail.before.profile.description, '原生项目另行调整')
    assert.equal(audit.detail.after.profile.ratedPowerKw, '11')
    const clear = {
      expectedVersion: updated.version,
      application: null,
      ratedVoltageV: '',
      reason: '待重新确认应用要求',
    }
    const clearPreview = await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      clear,
    )
    await call('technical', `${path}/plan`, 'PATCH', {
      ...clear,
      expectedSnapshot: clearPreview.expectedSnapshot,
    })
    const cleared = await call('technical', path)
    assert.equal(cleared.profile.application, '')
    assert.equal(cleared.profile.ratedVoltageV, '')
    assert.equal(cleared.profile.poles, '8')
    const noChange = {
      expectedVersion: cleared.version,
      ratedPowerKw: '11.0',
      reason: '数值格式核对',
    }
    const same = await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      noChange,
    )
    assert.equal(same.changes.length, 0)
    assert.equal(
      (
        await call('technical', `${path}/plan`, 'PATCH', {
          ...noChange,
          expectedSnapshot: same.expectedSnapshot,
        })
      ).version,
      cleared.version,
    )
    await client`update npi_projects set current_npi_stage='completed' where program_id=${p.id}`
    await call(
      'technical',
      `${path}/change-preview`,
      'POST',
      { ...noChange, customer: '结项后修改' },
      400,
    )
  })
  await test('Today dashboard uses all scoped audit rows, excludes first promises and compares overdue with the previous business day', async () => {
    const { today } = await import('../packages/core/src/lib/npi/domain')
    const { businessDayRange } =
      await import('../packages/core/src/lib/npi/activity')
    const day = today(),
      range = businessDayRange(day)
    const date = (offset: number) =>
      new Date(new Date(day + 'T00:00:00Z').getTime() + offset * 86400000)
        .toISOString()
        .slice(0, 10)
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '今日变化统计验收',
        motorModel: 'ACTIVITY',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: date(10),
        prototypeRequiredDate: date(15),
      },
      201,
    )
    const make = async (name: string, committedDate?: string) => {
      const item = await call(
        'technical',
        `/projects/${p.id}/external-items`,
        'POST',
        {
          name,
          qty: '1',
          ownerId: accounts.procurement!.id,
          requiredDate: date(10),
          affectsKit: true,
        },
        201,
      )
      if (!committedDate) return item
      const replied = await call(
        'procurement',
        `/tracking/${item.id}/promise`,
        'POST',
        { expectedVersion: item.version, committedDate },
      )
      await client`update npi_tracking_items set created_at=${new Date(range.start.getTime() - 3 * 86400000).toISOString()} where id=${item.id}`
      await client`update npi_promise_history set changed_at=${new Date(range.start.getTime() - 2 * 86400000).toISOString()} where object_id=${item.id}`
      return replied
    }
    const old = await make('昨日已逾期', date(-2))
    const clock = await make('今天跨日逾期', date(-1))
    const amended = await make('今日核实为逾期', date(3))
    const firstChange = await call(
      'procurement',
      `/tracking/${amended.id}/promise`,
      'POST',
      {
        expectedVersion: amended.version,
        committedDate: date(-2),
        reason: '核实供应商记录',
      },
    )
    await call('procurement', `/tracking/${amended.id}/promise`, 'POST', {
      expectedVersion: firstChange.version,
      committedDate: date(-3),
      reason: '复核运输记录',
    })
    const completed = await make('今天补确认昨日到货')
    await call('procurement', `/tracking/${completed.id}/complete`, 'POST', {
      expectedVersion: completed.version,
      actualCompleteDate: date(-1),
    })
    await client`update npi_events set created_at=${new Date(range.start.getTime() + 1000).toISOString()} where object_id=${completed.id} and action='COMPLETED'`
    await client`insert into npi_events(program_id,object_id,action,detail,actor_id,created_at) select ${p.id}::uuid,${p.id},'DETAILS_UPDATED','{}'::jsonb,${accounts.technical!.id}::uuid,${new Date(range.start.getTime() + 5000).toISOString()} from generate_series(1,130)`
    const project = await call('technical', `/projects/${p.id}`)
    assert.equal(project.events.length, 100)
    assert.ok(
      !project.events.some((e: { action: string }) => e.action === 'COMPLETED'),
    )
    assert.equal(
      project.items.find((i: { id: string }) => i.id === amended.id)
        .changeCount,
      2,
    )
    const dashboard = await call('technical', '/dashboard')
    assert.equal(dashboard.todayActivity.day, day)
    const filter = (rows: Array<{ projectId: string }>) =>
      rows.filter((r) => r.projectId === p.id)
    const due = filter(dashboard.todayActivity.newOverdue) as Array<{
      projectId: string
      itemId: string
    }>
    assert.deepEqual(
      due.map((r) => r.itemId).sort(),
      [clock.id, amended.id].sort(),
    )
    assert.ok(!due.some((r) => r.itemId === old.id))
    assert.equal(filter(dashboard.todayActivity.promiseChanges).length, 2)
    const completions = filter(dashboard.todayActivity.completions) as Array<{
      projectId: string
      itemId: string
      actualDate: string
    }>
    assert.equal(completions.length, 1)
    assert.equal(completions[0]!.itemId, completed.id)
    assert.equal(completions[0]!.actualDate, date(-1))
    const supervisor = await call('supervisor', '/dashboard')
    assert.equal(filter(supervisor.todayActivity.completions).length, 1)
    const other = await call('otherTech', '/dashboard')
    for (const rows of Object.values(other.todayActivity))
      if (Array.isArray(rows))
        assert.ok(
          !rows.some((r: { projectId: string }) => r.projectId === p.id),
        )
    await call('procurement', '/dashboard', 'GET', undefined, 403)
  })
  await test('Similar project inheritance previews scope, rebuilds identities, resets commitments and rolls back conflicts atomically', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '继承来源',
        motorModel: 'SOURCE',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-01',
        prototypeRequiredDate: '2026-10-05',
        customer: '旧客户',
        ratedPowerKw: '7.5',
        ratedVoltageV: '380',
      },
      201,
    )
    const sourcePath = `/projects/${p.id}`
    const pv = await call(
      'technical',
      sourcePath + '/bom/import-preview',
      'POST',
      upload(),
    )
    const imp = await call(
      'technical',
      sourcePath + '/bom/import',
      'POST',
      { previewToken: pv.previewToken, activate: true },
      201,
    )
    const tree = await call('technical', sourcePath + '/bom/tree')
    const tracked = await call(
      'technical',
      `/bom-items/${tree.rows[0].id}/tracking`,
      'PATCH',
      {
        ownerId: accounts.procurement!.id,
        requiredDate: '2026-09-25',
        expectedVersion: 0,
        trackingEnabled: true,
        affectsKit: true,
      },
    )
    await call('procurement', `/tracking/${tracked.id}/promise`, 'POST', {
      committedDate: '2026-09-24',
      expectedVersion: tracked.version,
    })
    const ext = await call(
      'technical',
      sourcePath + '/external-items',
      'POST',
      {
        name: '临时接线盒',
        trackingType: 'material',
        ownerId: accounts.technical!.id,
        requiredDate: '2026-09-24',
        qty: '2',
        unit: '只',
        specification: '铝合金',
        supplier: '原供应商',
        remark: '配置备注',
      },
      201,
    )
    await client`update npi_tracking_items set actual_complete_date='2026-09-23',first_committed_date='2026-09-24',current_committed_date='2026-09-24' where id=${ext.id}`
    await client`update npi_projects set current_npi_stage='completed' where program_id=${p.id}`
    const before = await call('technical', sourcePath)
    const body = {
      code: `COPY-${crypto.randomUUID()}`,
      name: '继承新项目',
      motorModel: 'TARGET',
      technicalOwnerId: accounts.otherTech!.id,
      manufacturingOwnerId: accounts.manufacturing!.id,
      procurementOwnerId: accounts.otherBuyer!.id,
      requiredKitDate: '2026-12-01',
      prototypeRequiredDate: '2026-12-05',
      copyBom: true,
      copyExternal: true,
      customer: '新客户',
      ratedPowerKw: '11',
    }
    for (const role of [
      'manufacturing',
      'procurement',
      'supervisor',
      'otherTech',
    ])
      await call(role, sourcePath + '/inheritance-preview', 'POST', body, 403)
    await call(
      'technical',
      sourcePath + '/inheritance-preview',
      'POST',
      { ...body, procurementOwnerId: accounts.technical!.id },
      422,
    )
    const preview = await call(
      'technical',
      sourcePath + '/inheritance-preview',
      'POST',
      body,
    )
    assert.deepEqual(preview.counts, {
      bomRows: 2,
      bomTracking: 1,
      external: 1,
    })
    assert.equal(
      preview.assignments.find(
        (a: { sourceItemId: string }) => a.sourceItemId === ext.id,
      ).ownerId,
      accounts.otherTech!.id,
    )
    assert.equal(
      preview.assignments.find(
        (a: { sourceItemId: string }) => a.sourceItemId === tracked.id,
      ).ownerId,
      accounts.otherBuyer!.id,
    )
    assert.equal(
      (await client`select id from programs where code=${body.code}`).length,
      0,
    )
    await client`update programs set description='源项目发生更新' where id=${p.id}`
    await call(
      'technical',
      sourcePath + '/inherit',
      'POST',
      { ...body, expectedSnapshot: preview.expectedSnapshot },
      409,
    )
    const fresh = await call(
      'technical',
      sourcePath + '/inheritance-preview',
      'POST',
      body,
    )
    const created = await call(
      'technical',
      sourcePath + '/inherit',
      'POST',
      { ...body, expectedSnapshot: fresh.expectedSnapshot },
      201,
    )
    assert.equal(created.canContinue, false)
    await call('technical', `/projects/${created.id}`, 'GET', undefined, 403)
    const target = await call('otherTech', `/projects/${created.id}`)
    assert.equal(target.currentNpiStage, 'design')
    assert.equal(target.profile.customer, '新客户')
    assert.equal(target.profile.ratedPowerKw, '11')
    assert.equal(target.profile.ratedVoltageV, '380')
    assert.equal(target.items.length, 6)
    assert.equal(target.history.length, 0)
    assert.equal(target.imports.length, 1)
    assert.equal(target.imports[0].versionNo, 1)
    for (const item of target.items) {
      assert.equal(item.firstCommittedDate, null)
      assert.equal(item.currentCommittedDate, null)
      assert.equal(item.actualCompleteDate, null)
      assert.equal(item.version, 1)
      assert.equal(
        item.requiredDate,
        item.trackingType === 'assembly'
          ? body.prototypeRequiredDate
          : body.requiredKitDate,
      )
    }
    const targetBom = await call(
      'otherTech',
      `/projects/${created.id}/bom/tree`,
    )
    const oldIds = new Set(tree.rows.map((r: { id: string }) => r.id)),
      newIds = new Set(targetBom.rows.map((r: { id: string }) => r.id))
    assert.equal(newIds.size, 2)
    for (const row of targetBom.rows) {
      assert.equal(oldIds.has(row.id), false)
      if (row.parentId) assert.ok(newIds.has(row.parentId))
    }
    assert.ok(
      target.items
        .filter((t: { sourceType: string }) => t.sourceType === 'ERP_BOM')
        .every((t: { bomItemId: string }) => newIds.has(t.bomItemId)),
    )
    const [copied] =
      await client`select source_base64,source_hash from npi_bom_imports where program_id=${created.id}`
    assert.deepEqual(Buffer.from(copied!.source_base64, 'base64'), source)
    assert.equal(
      target.events.find(
        (e: { action: string }) => e.action === 'PROJECT_INHERITED',
      ).detail.sourceProgramId,
      p.id,
    )
    const after = await call('technical', sourcePath)
    assert.deepEqual(after.items, before.items)
    assert.deepEqual(after.history, before.history)
    assert.equal(after.activeBomImportId, imp.importId)
    assert.equal(after.version, before.version)
    await call(
      'technical',
      sourcePath + '/inherit',
      'POST',
      { ...body, expectedSnapshot: fresh.expectedSnapshot },
      409,
    )
    // Profile-only option creates the standard four blank manufacturing nodes.
    const basic = {
      ...body,
      code: `COPY-${crypto.randomUUID()}`,
      copyBom: false,
      copyExternal: false,
      procurementOwnerId: undefined,
    }
    const bp = await call(
      'technical',
      sourcePath + '/inheritance-preview',
      'POST',
      basic,
    )
    const bc = await call(
      'technical',
      sourcePath + '/inherit',
      'POST',
      { ...basic, expectedSnapshot: bp.expectedSnapshot },
      201,
    )
    const bd = await call('otherTech', `/projects/${bc.id}`)
    assert.equal(bd.items.length, 4)
    assert.equal(bd.imports.length, 0)
    // A broken original must roll back even though project creation began inside the same transaction.
    const bad = { ...body, code: `COPY-${crypto.randomUUID()}` }
    const badPreview = await call(
      'technical',
      sourcePath + '/inheritance-preview',
      'POST',
      bad,
    )
    await client`update npi_bom_imports set source_base64='broken' where id=${imp.importId}`
    try {
      await call(
        'technical',
        sourcePath + '/inherit',
        'POST',
        { ...bad, expectedSnapshot: badPreview.expectedSnapshot },
        400,
      )
      assert.equal(
        (await client`select id from programs where code=${bad.code}`).length,
        0,
      )
    } finally {
      await client`update npi_bom_imports set source_base64=${source.toString('base64')} where id=${imp.importId}`
    }
  })
  await test('Recent external purchase owner is actor-scoped, successful-only and valid at read time', async () => {
    const who = 'recentTech'
    const userId = crypto.randomUUID()
    await client`insert into users(id,email,name,active) values(${userId},${`${userId}@test.invalid`},'recent tester',true)`
    await client`insert into npi_user_roles(user_id,role) values(${userId},'technical')`
    const session = await SessionManager.createSession(userId)
    accounts[who] = { id: userId, token: session.sessionToken }
    assert.equal((await call(who, '/meta')).recentProcurementOwnerId, null)
    const otherBefore = (await call('technical', '/meta'))
      .recentProcurementOwnerId
    const p = await call(
      who,
      '/projects',
      'POST',
      {
        name: 'Recent buyer test',
        motorModel: 'RECENT',
        technicalOwnerId: userId,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const payload = {
      name: 'External',
      qty: '1',
      ownerId: accounts.procurement!.id,
      requiredDate: '2026-10-15',
    }
    const path = `/projects/${p.id}/external-items`
    await call(who, path, 'POST', payload, 201)
    assert.equal(
      (await call(who, '/meta')).recentProcurementOwnerId,
      accounts.procurement!.id,
    )
    await call(
      who,
      path,
      'POST',
      {
        ...payload,
        trackingType: 'material',
        ownerId: accounts.manufacturing!.id,
      },
      201,
    )
    assert.equal(
      (await call(who, '/meta')).recentProcurementOwnerId,
      accounts.procurement!.id,
    )
    const latest = await call(
      who,
      path,
      'POST',
      { ...payload, ownerId: accounts.otherBuyer!.id },
      201,
    )
    assert.equal(
      (await call(who, '/meta')).recentProcurementOwnerId,
      accounts.otherBuyer!.id,
    )
    await call(who, path, 'POST', { ...payload, qty: '0' }, 422)
    await call(
      who,
      path,
      'POST',
      { ...payload, ownerId: accounts.manufacturing!.id },
      422,
    )
    assert.equal(
      (await call(who, '/meta')).recentProcurementOwnerId,
      accounts.otherBuyer!.id,
    )
    assert.equal(
      (await call('technical', '/meta')).recentProcurementOwnerId,
      otherBefore,
    )
    assert.equal(
      (await call('procurement', '/meta')).recentProcurementOwnerId,
      null,
    )
    // The default follows the recorded selection, not later changes to the task owner.
    await client`update npi_tracking_items set owner_id=${accounts.procurement!.id} where id=${latest.id}`
    assert.equal(
      (await call(who, '/meta')).recentProcurementOwnerId,
      accounts.otherBuyer!.id,
    )
    try {
      await client`update users set active=false where id=${accounts.otherBuyer!.id}`
      assert.equal(
        (await call(who, '/meta')).recentProcurementOwnerId,
        accounts.procurement!.id,
      )
      await client`update users set active=true where id=${accounts.otherBuyer!.id}`
      await client`update npi_user_roles set role='manufacturing' where user_id=${accounts.otherBuyer!.id}`
      assert.equal(
        (await call(who, '/meta')).recentProcurementOwnerId,
        accounts.procurement!.id,
      )
      await client`update users set active=false where id=${accounts.procurement!.id}`
      assert.equal((await call(who, '/meta')).recentProcurementOwnerId, null)
    } finally {
      await client`update users set active=true where id in (${accounts.procurement!.id},${accounts.otherBuyer!.id})`
      await client`update npi_user_roles set role='procurement' where user_id=${accounts.otherBuyer!.id}`
    }
    // Historical events did not capture ownerId. They must not guess today's owner.
    await client`update npi_events set detail='{"name":"legacy external"}'::jsonb where object_id=${latest.id} and action='EXTERNAL_CREATED'`
    assert.equal(
      (await call(who, '/meta')).recentProcurementOwnerId,
      accounts.procurement!.id,
    )
  })
  await test('Manufacturing exception is atomic, owner-scoped, versioned and preserves promise history', async () => {
    const created = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: 'Manufacturing exception test',
        motorModel: 'EXCEPTION',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const path = `/projects/${created.id}`
    const preview = await call(
      'technical',
      path + '/bom/import-preview',
      'POST',
      upload(),
    )
    await call(
      'technical',
      path + '/bom/import',
      'POST',
      { previewToken: preview.previewToken },
      201,
    )
    const tree = await call('technical', path + '/bom/tree')
    const before = await call('manufacturing', path)
    const payload = {
      expectedProjectVersion: before.version,
      activeImportId: tree.importId,
      bomItemId: tree.rows[0].id,
      expectedVersion: 0,
      committedDate: '2026-10-18',
      reason: '机壳返工需要三天',
      affectsKit: true,
    }
    const endpoint = path + '/manufacturing-exceptions'
    for (const role of ['technical', 'procurement', 'supervisor', 'otherTech'])
      await call(role, endpoint, 'POST', payload, 403)
    await call(
      'manufacturing',
      endpoint,
      'POST',
      { ...payload, reason: '' },
      422,
    )
    // Date validation occurs after creating the tracking row inside the transaction.
    await call(
      'manufacturing',
      endpoint,
      'POST',
      { ...payload, committedDate: '2026-02-30' },
      422,
    )
    const rejected = await call('manufacturing', path)
    assert.deepEqual(rejected.items, before.items)
    assert.deepEqual(rejected.history, before.history)
    assert.deepEqual(rejected.events, before.events)
    const first = await call('manufacturing', endpoint, 'POST', payload)
    assert.equal(first.ownerId, accounts.manufacturing!.id)
    assert.equal(first.sourceType, 'ERP_BOM')
    assert.equal(first.trackingType, 'material')
    assert.equal(first.firstCommittedDate, '2026-10-18')
    assert.equal(first.trackingEnabled, true)
    await call('manufacturing', endpoint, 'POST', payload, 409)
    await call(
      'manufacturing',
      endpoint,
      'POST',
      {
        ...payload,
        expectedVersion: first.version,
        committedDate: 'bad-date',
        affectsKit: false,
      },
      422,
    )
    const afterInvalid = await call('manufacturing', path)
    assert.deepEqual(
      afterInvalid.items.find((i: { id: string }) => i.id === first.id),
      {
        ...first,
        bomReference: {
          materialCode: '00123',
          rowNo: 6,
          versionNo: 1,
          current: true,
        },
        ownerName: 'manufacturing',
        changeCount: 0,
      },
    )
    assert.equal(
      afterInvalid.history.filter(
        (h: { objectId: string }) => h.objectId === first.id,
      ).length,
      1,
    )
    await call('manufacturing', path + '/manufacturing-plan', 'PUT', {
      expectedVersion: afterInvalid.plan.version,
      processCommitted: '2026-10-15',
      toolingCommitted: '2026-10-15',
      kitCommitted: '2026-10-16',
      assemblyCommitted: '2026-10-20',
    })
    const kit = await call('manufacturing', path)
    assert.equal(kit.kit.bottleneck.id, first.id)
    assert.equal(kit.kit.predictedKitDate, '2026-10-18')
    assert.ok(
      kit.kit.alerts.some(
        (a: { code: string }) => a.code === 'DETAIL_VS_COMMIT_CONFLICT',
      ),
    )
    const actor = accounts.manufacturing!
    const replies = await Promise.all(
      ['2026-10-20', '2026-10-21'].map((committedDate) =>
        fetch(base + endpoint, {
          method: 'POST',
          headers: {
            cookie: `session=${actor.token}`,
            origin: base,
            'x-npi-actor': actor.id,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            ...payload,
            expectedVersion: first.version,
            committedDate,
            reason: '再次核实加工时间',
          }),
        }),
      ),
    )
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409])
    await Promise.all(replies.map((r) => r.json()))
    const afterRace = await call('manufacturing', path)
    const latest = afterRace.items.find(
      (i: { id: string }) => i.id === first.id,
    )
    assert.equal(latest.firstCommittedDate, first.firstCommittedDate)
    assert.equal(
      afterRace.history.filter(
        (h: { objectId: string }) => h.objectId === first.id,
      ).length,
      2,
    )
    assert.equal(
      afterRace.events.filter(
        (e: { action: string }) =>
          e.action === 'MANUFACTURING_EXCEPTION_REPORTED',
      ).length,
      2,
    )
    const purchase = await call(
      'technical',
      `/bom-items/${tree.rows[1].id}/tracking`,
      'PATCH',
      {
        expectedVersion: 0,
        ownerId: accounts.procurement!.id,
        requiredDate: '2026-10-15',
        affectsKit: true,
        trackingEnabled: true,
      },
    )
    await call(
      'manufacturing',
      endpoint,
      'POST',
      {
        ...payload,
        bomItemId: tree.rows[1].id,
        expectedVersion: purchase.version,
      },
      403,
    )
    const otherTree = await call('technical', `/projects/${projectId}/bom/tree`)
    await call(
      'manufacturing',
      endpoint,
      'POST',
      { ...payload, bomItemId: otherTree.rows[0].id },
      404,
    )
    await call(
      'manufacturing',
      endpoint,
      'POST',
      { ...payload, expectedProjectVersion: before.version - 1 },
      409,
    )
    const actual = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    const complete = await call(
      'manufacturing',
      `/tracking/${first.id}/complete`,
      'POST',
      { expectedVersion: latest.version, actualCompleteDate: actual },
    )
    await call(
      'manufacturing',
      endpoint,
      'POST',
      { ...payload, expectedVersion: complete.version },
      400,
    )
    const secondPreview = await call(
      'technical',
      path + '/bom/import-preview',
      'POST',
      upload(),
    )
    await call(
      'technical',
      path + '/bom/import',
      'POST',
      { previewToken: secondPreview.previewToken },
      201,
    )
    const current = await call('manufacturing', path)
    const newTree = await call('manufacturing', path + '/bom/tree')
    await call(
      'manufacturing',
      endpoint,
      'POST',
      { ...payload, expectedProjectVersion: current.version },
      409,
    )
    await call(
      'manufacturing',
      endpoint,
      'POST',
      {
        ...payload,
        expectedProjectVersion: current.version,
        activeImportId: newTree.importId,
      },
      404,
    )
    const needsReview = await call(
      'manufacturing',
      endpoint,
      'POST',
      {
        ...payload,
        expectedProjectVersion: current.version,
        activeImportId: newTree.importId,
        bomItemId: newTree.rows[1].id,
      },
      409,
    )
    assert.equal(needsReview.code, 'BOM_REVIEW_REQUIRED')
    const adminAdded = await call('admin', endpoint, 'POST', {
      ...payload,
      expectedProjectVersion: current.version,
      activeImportId: newTree.importId,
      bomItemId: newTree.rows[0].id,
    })
    assert.equal(adminAdded.ownerId, accounts.manufacturing!.id)
    await client`update npi_projects set current_npi_stage='completed' where program_id=${created.id}`
    try {
      await call(
        'manufacturing',
        endpoint,
        'POST',
        { ...payload, expectedProjectVersion: current.version },
        400,
      )
    } finally {
      await client`update npi_projects set current_npi_stage='design' where program_id=${created.id}`
    }
  })
  await test('Tracking history is object-scoped, counted consistently and follows current ownership', async () => {
    const created = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '采购历史隔离验收',
        motorModel: 'HISTORY',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    let purchase = await call(
      'technical',
      `/projects/${created.id}/external-items`,
      'POST',
      {
        name: '历史验收采购件',
        ownerId: accounts.procurement!.id,
        requiredDate: '2026-10-10',
        qty: 1,
      },
      201,
    )
    const path = `/tracking/${purchase.id}`
    const empty = await call('procurement', path + '/history')
    assert.deepEqual(empty.history, [])
    assert.equal(empty.item.changeCount, 0)
    for (const role of ['otherBuyer', 'otherTech'])
      await call(role, path + '/history', 'GET', undefined, 403)
    await call(
      'procurement',
      '/tracking/invalid/history',
      'GET',
      undefined,
      422,
    )
    await call(
      'procurement',
      `/tracking/${crypto.randomUUID()}/history`,
      'GET',
      undefined,
      404,
    )
    for (const date of ['2026-10-09', '2026-10-12', '2026-10-14'])
      purchase = await call('procurement', path + '/promise', 'POST', {
        expectedVersion: purchase.version,
        committedDate: date,
        reason: `交期确认 ${date}`,
      })
    purchase = await call('procurement', path + '/promise', 'POST', {
      expectedVersion: purchase.version,
      committedDate: '2026-10-14',
      supplier: '仅更新供应商',
    })
    const result = await call('procurement', path + '/history')
    assert.equal(result.item.changeCount, 2)
    assert.equal(result.item.firstCommittedDate, '2026-10-09')
    assert.equal(result.item.currentCommittedDate, '2026-10-14')
    assert.equal(result.history.length, 3)
    assert.equal(result.history[2].reason, '交期确认 2026-10-14')
    assert.equal(result.history[2].actorName, 'procurement')
    assert.equal('programId' in result.item, false)
    assert.equal('ownerId' in result.item, false)
    for (const role of ['technical', 'manufacturing', 'supervisor', 'admin'])
      assert.deepEqual(await call(role, path + '/history'), result)
    const work = await call('procurement', '/workbench/procurement')
    assert.equal(
      work.items.find((i: { id: string }) => i.id === purchase.id).changeCount,
      2,
    )
    const currentProject = await call('technical', `/projects/${created.id}`)
    const node = currentProject.items.find(
      (i: { sourceType: string }) => i.sourceType === 'MANUFACTURING',
    )
    await call(
      'procurement',
      `/tracking/${node.id}/history`,
      'GET',
      undefined,
      403,
    )
    purchase = await call('technical', path + '/plan', 'PATCH', {
      expectedVersion: purchase.version,
      ownerId: accounts.otherBuyer!.id,
      requiredDate: purchase.requiredDate,
      reason: '采购负责人交接',
    })
    await call('procurement', path + '/history', 'GET', undefined, 403)
    assert.deepEqual(await call('otherBuyer', path + '/history'), result)
    assert.equal(
      (await call('otherBuyer', '/workbench/procurement')).items.find(
        (i: { id: string }) => i.id === purchase.id,
      ).changeCount,
      2,
    )
    purchase = await call('otherBuyer', path + '/complete', 'POST', {
      expectedVersion: purchase.version,
      actualCompleteDate: '2026-09-14',
    })
    assert.deepEqual(await call('otherBuyer', path + '/history'), result)
    await client`update npi_projects set current_npi_stage='completed' where program_id=${created.id}`
    assert.deepEqual(await call('otherBuyer', path + '/history'), result)
    await client`update users set active=false where id=${accounts.otherBuyer!.id}`
    try {
      await call('otherBuyer', path + '/history', 'GET', undefined, 401)
    } finally {
      await client`update users set active=true where id=${accounts.otherBuyer!.id}`
    }
  })
  await test('Mother confirmation is actor-owned, survives draft updates, preserves bytes and cannot bypass row errors', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '母件确认验收',
        motorModel: 'MOTHER',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const path = `/projects/${p.id}/bom`
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(
      new Uint8Array(source) as unknown as Parameters<typeof book.xlsx.load>[0],
    )
    book.worksheets[0]!.getCell('A4').value = ''
    const original = Buffer.from(await book.xlsx.writeBuffer())
    const input = {
      code: 'MANUAL-001',
      name: '人工确认电机',
      spec: 'M160',
      reason: '根据设计图纸核对',
      confirmedBy: accounts.otherTech!.id,
    }
    const form = (confirmation?: unknown, bytes = original) => {
      const data = new FormData()
      data.set('file', new File([new Uint8Array(bytes)], 'missing-mother.xlsx'))
      data.set('templateId', defaultTemplate.id)
      if (confirmation !== undefined)
        data.set(
          'motherConfirmation',
          typeof confirmation === 'string'
            ? confirmation
            : JSON.stringify(confirmation),
        )
      return data
    }
    const missing = await call(
      'technical',
      path + '/import-preview',
      'POST',
      form(),
    )
    assert.equal(missing.previewToken, null)
    for (const role of ['manufacturing', 'procurement', 'otherTech'])
      await call(role, path + '/import-preview', 'POST', form(input), 403)
    for (const invalid of ['{bad', null, { ...input, reason: '' }])
      await call(
        'technical',
        path + '/import-preview',
        'POST',
        form(invalid),
        422,
      )
    const fixed = await call(
      'technical',
      path + '/import-preview',
      'POST',
      form(input),
    )
    assert.equal(fixed.summary.errors, 0)
    assert.equal(fixed.mother.code, input.code)
    assert.equal(fixed.motherConfirmation.original.code, '')
    assert.equal(fixed.motherConfirmation.confirmedBy, accounts.technical!.id)
    const saved = await call('technical', path + '/drafts', 'POST', {
      previewToken: fixed.previewToken,
    })
    let resumed = await call(
      'technical',
      path + `/drafts/${saved.draftId}/resume`,
      'POST',
      {},
    )
    assert.deepEqual(resumed.motherConfirmation, fixed.motherConfirmation)
    resumed = await call(
      'technical',
      path + `/drafts/${saved.draftId}/resume`,
      'POST',
      {
        motherConfirmation: {
          ...input,
          code: 'MANUAL-002',
          reason: '图纸版本复核',
        },
      },
    )
    await call('technical', path + '/drafts', 'POST', {
      previewToken: resumed.previewToken,
    })
    const latest = await call(
      'technical',
      path + `/drafts/${saved.draftId}/resume`,
      'POST',
      {},
    )
    assert.deepEqual(latest.motherConfirmation, resumed.motherConfirmation)
    const imported = await call(
      'technical',
      path + '/import',
      'POST',
      {
        previewToken: latest.previewToken,
        activate: true,
        mother: { code: 'FORGED' },
      },
      201,
    )
    const records =
      await client`select mother,source_base64,source_hash from npi_bom_imports where id=${imported.importId}`
    assert.equal(records[0]!.mother.code, 'MANUAL-002')
    assert.deepEqual(Buffer.from(records[0]!.source_base64, 'base64'), original)
    assert.equal(
      records[0]!.source_hash,
      createHash('sha256').update(original).digest('hex'),
    )
    const events =
      await client`select detail from npi_events where program_id=${p.id} and action='BOM_IMPORTED'`
    assert.deepEqual(
      events[0]!.detail.motherConfirmation,
      latest.motherConfirmation,
    )
    await call(
      'technical',
      path + '/import',
      'POST',
      { previewToken: latest.previewToken, activate: true },
      409,
    )
    book.worksheets[0]!.getCell('E6').value = -1
    const bad = await call(
      'technical',
      path + '/import-preview',
      'POST',
      form(input, Buffer.from(await book.xlsx.writeBuffer())),
    )
    assert.ok(bad.summary.errors > 0)
    assert.equal(bad.previewToken, null)
    assert.equal(
      (await call('technical', `/projects/${p.id}`)).imports.length,
      1,
    )
  })
  await test('Tracking identity preserves ERP codes, duplicate rows, version provenance and buyer scope across reconciliation', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '物料编码识别验收',
        motorModel: 'IDENTITY',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const path = `/projects/${p.id}`
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(
      new Uint8Array(source) as unknown as Parameters<typeof book.xlsx.load>[0],
    )
    const sh = book.worksheets[0]!
    sh.getCell('D7').value = '关键机壳'
    const preview = await service.createPreview(
      accounts.technical!.id,
      p.id,
      new File(
        [new Uint8Array(await book.xlsx.writeBuffer())],
        'identity.xlsx',
      ),
      defaultTemplate.id,
    )
    await call(
      'technical',
      path + '/bom/import',
      'POST',
      { previewToken: preview.previewToken, activate: true },
      201,
    )
    const tree = await call('technical', path + '/bom/tree')
    const tracked: Array<{ id: string }> = []
    for (const [index, ownerRole] of ['procurement', 'otherBuyer'].entries()) {
      tracked.push(
        await call(
          'technical',
          `/bom-items/${tree.rows[index].id}/tracking`,
          'PATCH',
          {
            ownerId: accounts[ownerRole]!.id,
            trackingType: 'purchase',
            requiredDate: '2026-10-15',
            trackingEnabled: true,
            affectsKit: true,
            expectedVersion: 0,
          },
        ),
      )
    }
    accounts.otherBuyer!.token = (
      await SessionManager.createSession(accounts.otherBuyer!.id)
    ).sessionToken
    const original = {
      materialCode: '00123',
      versionNo: 1,
      rowNo: 6,
      current: true,
    }
    const project = await call('technical', path)
    assert.deepEqual(
      project.items.find((i: { id: string }) => i.id === tracked[0]!.id)
        .bomReference,
      original,
    )
    assert.equal(
      project.items.find(
        (i: { sourceType: string }) => i.sourceType === 'MANUFACTURING',
      ).bomReference,
      null,
    )
    const owned = (
      await call('procurement', '/workbench/procurement')
    ).items.filter((i: { programId: string }) => i.programId === p.id)
    assert.equal(owned.length, 1)
    assert.deepEqual(owned[0].bomReference, original)
    assert.equal(owned[0].projectCode, p.code)
    for (const key of ['bomRow', 'rawData', 'sourceBase64', 'sourceHash'])
      assert.equal(key in owned[0], false)
    assert.deepEqual(
      (await call('procurement', `/tracking/${tracked[0]!.id}/history`)).item
        .bomReference,
      original,
    )
    await call(
      'otherBuyer',
      `/tracking/${tracked[0]!.id}/history`,
      'GET',
      undefined,
      403,
    )
    const nextPreview = await service.createPreview(
      accounts.technical!.id,
      p.id,
      new File(
        [new Uint8Array(await book.xlsx.writeBuffer())],
        'identity-v2.xlsx',
      ),
      defaultTemplate.id,
    )
    await call(
      'technical',
      path + '/bom/import',
      'POST',
      { previewToken: nextPreview.previewToken, activate: true },
      201,
    )
    const before = await call(
      'procurement',
      `/tracking/${tracked[0]!.id}/history`,
    )
    assert.deepEqual(before.item.bomReference, { ...original, current: false })
    const review = await call('technical', path + '/bom/reconciliation')
    const item = review.items.find(
      (r: { item: { id: string } }) => r.item.id === tracked[0]!.id,
    )
    await call('technical', path + '/bom/reconciliation', 'POST', {
      action: 'migrate',
      trackingItemId: tracked[0]!.id,
      targetBomItemId: item.suggestedId,
      expectedVersion: item.item.version,
      expectedProjectVersion: review.projectVersion,
      activeImportId: review.activeImportId,
      reason: '按物料编码和原表行号复核',
    })
    const after = await call(
      'procurement',
      `/tracking/${tracked[0]!.id}/history`,
    )
    assert.deepEqual(after.item.bomReference, { ...original, versionNo: 2 })
    assert.deepEqual(after.history, before.history)
    const finalWork = (
      await call('procurement', '/workbench/procurement')
    ).items.find((i: { id: string }) => i.id === tracked[0]!.id)
    assert.deepEqual(finalWork.bomReference, after.item.bomReference)
  })
  await test('Template activation honors create/update, preserves omitted state, rejects stale writes and retains imported snapshots', async () => {
    const tid = `editor-${crypto.randomUUID()}`
    const config = { ...defaultTemplate, id: tid, name: '表单模板验收' }
    for (const role of ['technical', 'manufacturing', 'procurement'])
      await call(role, '/templates', 'PUT', { config, expectedVersion: 0 }, 403)
    await call(
      'admin',
      '/templates',
      'PUT',
      { config, expectedVersion: 0, enabled: 'false' },
      422,
    )
    assert.equal(
      (await client`select id from npi_import_templates where id=${tid}`)
        .length,
      0,
    )
    await call('admin', '/templates', 'PUT', {
      config,
      expectedVersion: 0,
      enabled: false,
    })
    let row = (
      await client`select * from npi_import_templates where id=${tid}`
    )[0]!
    assert.equal(row.enabled, false)
    await call('admin', '/templates', 'PUT', {
      config: { ...config, name: '停用时编辑' },
      expectedVersion: row.version,
    })
    row = (await client`select * from npi_import_templates where id=${tid}`)[0]!
    assert.equal(row.enabled, false)
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '模板导入验收',
        motorModel: 'TEMPLATE',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const data = () => {
      const f = upload()
      f.set('templateId', tid)
      return f
    }
    await call(
      'technical',
      `/projects/${p.id}/bom/import-preview`,
      'POST',
      data(),
      400,
    )
    await call('admin', '/templates', 'PUT', {
      config,
      enabled: true,
      expectedVersion: row.version,
    })
    const preview = await call(
      'technical',
      `/projects/${p.id}/bom/import-preview`,
      'POST',
      data(),
    )
    row = (await client`select * from npi_import_templates where id=${tid}`)[0]!
    await call('admin', '/templates', 'PUT', {
      config,
      enabled: false,
      expectedVersion: row.version,
    })
    await call(
      'technical',
      `/projects/${p.id}/bom/import`,
      'POST',
      { previewToken: preview.previewToken, activate: true },
      400,
    )
    await call(
      'admin',
      '/templates',
      'PUT',
      { config, enabled: true, expectedVersion: row.version },
      409,
    )
    row = (await client`select * from npi_import_templates where id=${tid}`)[0]!
    assert.equal(row.enabled, false)
    await call('admin', '/templates', 'PUT', {
      config,
      enabled: true,
      expectedVersion: row.version,
    })
    const next = await call(
      'technical',
      `/projects/${p.id}/bom/import-preview`,
      'POST',
      data(),
    )
    const imported = await call(
      'technical',
      `/projects/${p.id}/bom/import`,
      'POST',
      { previewToken: next.previewToken, activate: true },
      201,
    )
    row = (await client`select * from npi_import_templates where id=${tid}`)[0]!
    await call('admin', '/templates', 'PUT', {
      config: { ...config, name: '之后改名' },
      enabled: false,
      expectedVersion: row.version,
    })
    const snapshot = (
      await client`select template_snapshot from npi_bom_imports where id=${imported.importId}`
    )[0]!
    assert.deepEqual(snapshot.template_snapshot, config)
    const event = (
      await client`select detail from npi_events where object_id=${tid} and action='TEMPLATE_UPDATED' order by created_at desc limit 1`
    )[0]!
    assert.equal(event.detail.enabled, false)
  })
  await test('Decimal XLSX quantities survive preview, storage, tracking and precise version comparison without binary loss', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '数量精度验收',
        motorModel: 'DECIMAL',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const path = `/projects/${p.id}/bom`
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(
      new Uint8Array(source) as unknown as Parameters<typeof book.xlsx.load>[0],
    )
    const make = async (qty: string) => {
      book.worksheets[0]!.getCell('E6').value = qty
      const bytes = Buffer.from(await book.xlsx.writeBuffer())
      const f = new FormData()
      f.set('file', new File([new Uint8Array(bytes)], 'decimal.xlsx'))
      f.set('templateId', defaultTemplate.id)
      return {
        bytes,
        data: await call('technical', path + '/import-preview', 'POST', f),
      }
    }
    const first = await make('999999999999.123456')
    assert.equal(first.data.previewRows[0].qty, '999999999999.123456')
    assert.equal(
      first.data.validation.some(
        (v: { code: string }) => v.code === 'QTY_ROUNDED',
      ),
      false,
    )
    const imported = await call(
      'technical',
      path + '/import',
      'POST',
      { previewToken: first.data.previewToken, activate: true },
      201,
    )
    const tree = await call('technical', path + '/tree')
    assert.equal(tree.rows[0].qty, '999999999999.123456')
    const item = await call(
      'technical',
      `/bom-items/${tree.rows[0].id}/tracking`,
      'PATCH',
      {
        ownerId: accounts.manufacturing!.id,
        requiredDate: '2026-10-15',
        expectedVersion: 0,
        affectsKit: true,
        trackingEnabled: true,
      },
    )
    assert.equal(item.qty, '999999999999.123456')
    const second = await make('999999999999.123457')
    const updated = await call(
      'technical',
      path + '/import',
      'POST',
      { previewToken: second.data.previewToken, activate: true },
      201,
    )
    const difference = await call(
      'technical',
      path + `/diff?before=${imported.importId}&after=${updated.importId}`,
    )
    assert.equal(
      difference.find(
        (d: { after?: { materialCode: string } }) =>
          d.after?.materialCode === '00123',
      ).type,
      'QTY_CHANGED',
    )
    const stored = (
      await client`select source_base64 from npi_bom_imports where id=${imported.importId}`
    )[0]!
    assert.deepEqual(Buffer.from(stored.source_base64, 'base64'), first.bytes)
    assert.equal(
      (await call('technical', path + `/tree?importId=${imported.importId}`))
        .rows[0].qty,
      '999999999999.123456',
    )
    const review = await call('technical', path + '/reconciliation')
    const change = review.items.find(
      (r: { item: { id: string } }) => r.item.id === item.id,
    )
    assert.equal(change.changeType, 'QTY_CHANGED')
    const migrated = await call('technical', path + '/reconciliation', 'POST', {
      action: 'migrate',
      trackingItemId: item.id,
      targetBomItemId: change.suggestedId,
      expectedVersion: item.version,
      expectedProjectVersion: review.projectVersion,
      activeImportId: review.activeImportId,
      reason: '复核六位小数用量',
    })
    assert.equal(migrated.qty, '999999999999.123457')
    const rounded = await make('1.2345675')
    assert.equal(rounded.data.previewRows[0].qty, '1.234568')
    assert.ok(
      rounded.data.validation.some(
        (v: { code: string; message: string }) =>
          v.code === 'QTY_ROUNDED' && v.message.includes('1.234568'),
      ),
    )
    for (const invalid of [
      '999999999999.9999995',
      '0.0000004',
      '1e1000000000',
    ]) {
      const result = await make(invalid)
      assert.equal(result.data.previewToken, null)
      assert.ok(result.data.summary.errors > 0)
    }
    assert.equal(
      (await call('technical', `/projects/${p.id}`)).imports.length,
      2,
    )
  })
  await test('BOM tree contract filters tracked identities, preserves ancestors and flags, isolates versions and rejects invalid queries', async () => {
    const project = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: 'BOM树筛选契约',
        motorModel: 'TREE-CONTRACT',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const path = `/projects/${project.id}/bom/tree`
    assert.deepEqual(await call('technical', `${path}?trackingOnly=true`), {
      importId: null,
      versionNo: null,
      nodes: [],
      rows: [],
    })
    const book = new ExcelJS.Workbook()
    const tab = book.addWorksheet(defaultTemplate.sheetName)
    tab.getCell('A4').value = 'TREE-CONTRACT'
    tab.getCell('B4').value = '树筛选验证'
    tab.getCell('C4').value = 'TREE'
    tab.getRow(5).values = sheet.getRow(5).values
    const definitions = [
      ['+', 'ROOT-A'],
      ['++', 'DUPLICATE'],
      ['+++', 'DEEP'],
      ['++', 'UNRELATED'],
      ['+', 'ROOT-B'],
      ['++', 'DUPLICATE'],
      ['+', 'KIT-ONLY'],
      ['+', 'STOPPED'],
    ]
    definitions.forEach(([level, code], i) => {
      tab.getRow(i + 6).values = [level, i + 1, code, `物料${i + 1}`, 1, '只']
    })
    const bytes = new Uint8Array(await book.xlsx.writeBuffer())
    const importTree = async () => {
      const form = new FormData()
      form.set('templateId', defaultTemplate.id)
      form.set('file', new File([bytes], 'tree.xlsx'))
      const preview = await call(
        'technical',
        `/projects/${project.id}/bom/import-preview`,
        'POST',
        form,
      )
      assert.equal(preview.summary.errors, 0)
      return call(
        'technical',
        `/projects/${project.id}/bom/import`,
        'POST',
        {
          previewToken: preview.previewToken,
          activate: true,
        },
        201,
      )
    }
    const imported = await importTree()
    const original = await call('technical', path)
    type Row = {
      id: string
      parentId: string | null
      trackingEnabled: boolean
      affectsKit: boolean
    }
    type Node = Row & { children: Array<Node> }
    const rows = original.rows as Array<Row>
    const flatten = (nodes: Array<Node>): Array<Row> =>
      nodes.flatMap((node) => [node, ...flatten(node.children)])
    const ids = (entries: Array<Row>) => entries.map((row) => row.id)
    assert.equal(rows.length, 8)
    assert.ok(
      rows.every(
        (row) => row.trackingEnabled === false && row.affectsKit === false,
      ),
    )
    assert.deepEqual(
      (await call('technical', `${path}?trackingOnly=true`)).rows,
      [],
    )
    const track = (
      index: number,
      trackingEnabled: boolean,
      affectsKit: boolean,
      expectedVersion = 0,
    ) =>
      call('manufacturing', `/bom-items/${rows[index]!.id}/tracking`, 'PATCH', {
        ownerId: accounts.manufacturing!.id,
        requiredDate: '2026-10-15',
        trackingEnabled,
        affectsKit,
        expectedVersion,
        reason: '树筛选测试调整',
      })
    const deep = await track(2, true, true)
    const duplicate = await track(5, true, false)
    await track(6, false, true)
    const stopped = await track(7, true, false)
    await track(7, false, false, stopped.version)
    const all = await call('technical', path)
    assert.deepEqual(all, await call('technical', `${path}?trackingOnly=false`))
    assert.deepEqual(ids(all.rows), ids(rows))
    assert.equal(all.rows[6].trackingEnabled, false)
    assert.equal(all.rows[6].affectsKit, true)
    assert.equal(all.rows[7].trackingEnabled, false)
    const selected = await call('technical', `${path}?trackingOnly=true`)
    const expected = [rows[0]!, rows[1]!, rows[2]!, rows[4]!, rows[5]!]
    assert.deepEqual(ids(selected.rows), ids(expected))
    assert.deepEqual(ids(flatten(selected.nodes)), ids(expected))
    assert.equal(selected.nodes[0].trackingEnabled, false)
    assert.equal(selected.nodes[0].affectsKit, false)
    assert.equal(selected.nodes[0].children[0].trackingEnabled, false)
    assert.equal(selected.nodes[0].children[0].children[0].id, rows[2]!.id)
    assert.equal(
      selected.nodes[0].children[0].children[0].trackingEnabled,
      true,
    )
    assert.equal(selected.nodes[1].children[0].id, rows[5]!.id)
    assert.equal(selected.nodes[1].children[0].affectsKit, false)
    for (const role of ['manufacturing', 'supervisor', 'admin'])
      assert.deepEqual(await call(role, `${path}?trackingOnly=true`), selected)
    for (const role of ['procurement', 'otherTech'])
      await call(role, `${path}?trackingOnly=true`, 'GET', undefined, 403)
    for (const query of ['1', '0', 'TRUE', '', 'false&trackingOnly=true']) {
      const invalid = await call(
        'technical',
        `${path}?trackingOnly=${query}`,
        'GET',
        undefined,
        422,
      )
      assert.equal(invalid.code, 'VALIDATION_ERROR')
    }
    // Completion does not silently remove a still-tracked BOM definition.
    await call('manufacturing', `/tracking/${duplicate.id}/complete`, 'POST', {
      expectedVersion: duplicate.version,
      actualCompleteDate: new Date().toISOString(),
    })
    assert.deepEqual(
      await call('technical', `${path}?trackingOnly=true`),
      selected,
    )
    await track(2, false, false, deep.version)
    await track(1, true, true)
    const parentOnly = await call('technical', `${path}?trackingOnly=true`)
    assert.deepEqual(
      ids(parentOnly.rows),
      ids([rows[0]!, rows[1]!, rows[4]!, rows[5]!]),
    )
    assert.equal(parentOnly.nodes[0].children[0].children.length, 0)
    const historyBefore = await call('technical', `/projects/${project.id}`)
    const newer = await importTree()
    assert.equal(newer.versionNo, imported.versionNo + 1)
    assert.deepEqual(
      (await call('technical', `${path}?trackingOnly=true`)).rows,
      [],
    )
    const newAll = await call('technical', path)
    assert.ok(
      newAll.rows.every((row: Row) => !row.trackingEnabled && !row.affectsKit),
    )
    assert.deepEqual(
      await call(
        'technical',
        `${path}?importId=${imported.importId}&trackingOnly=true`,
      ),
      parentOnly,
    )
    assert.deepEqual(
      (await call('technical', `/projects/${project.id}`)).history,
      historyBefore.history,
    )
    await call(
      'technical',
      `${path}?importId=${importId}&trackingOnly=true`,
      'GET',
      undefined,
      404,
    )
  })
  await test('BOM validation preserves row diagnostics, withholds invalid tokens and rejects inconsistent stored previews without writes', async () => {
    const project = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: 'BOM错误契约验证',
        motorModel: 'ERROR-CONTRACT',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const path = `/projects/${project.id}`
    const before = await call('technical', path)
    const cases = [
      { changes: [['A7', '+++']], code: 'INVALID_LEVEL_SEQUENCE', row: 7 },
      { changes: [['A7', 'wrong']], code: 'INVALID_LEVEL_SEQUENCE', row: 7 },
      { changes: [['C6', '']], code: 'INVALID_BOM_FORMAT', row: 6 },
      { changes: [['E6', 'invalid']], code: 'INVALID_BOM_FORMAT', row: 6 },
      {
        changes: [
          ['E6', 'invalid'],
          ['A7', '+++'],
        ],
        code: 'INVALID_LEVEL_SEQUENCE',
        row: 7,
      },
    ]
    for (const [index, fixture] of cases.entries()) {
      const book = new ExcelJS.Workbook()
      await book.xlsx.load(
        new Uint8Array(source) as unknown as Parameters<
          typeof book.xlsx.load
        >[0],
      )
      for (const [cell, value] of fixture.changes)
        book.worksheets[0]!.getCell(cell!).value = value!
      const form = new FormData()
      form.set('templateId', defaultTemplate.id)
      form.set(
        'file',
        new File(
          [new Uint8Array(await book.xlsx.writeBuffer())],
          'invalid.xlsx',
        ),
      )
      const invalid = await call(
        'technical',
        `${path}/bom/import-preview`,
        'POST',
        form,
      )
      assert.ok(invalid.summary.errors > 0)
      assert.equal(invalid.previewToken, null)
      assert.ok(
        invalid.validation.some(
          (entry: { severity: string; code: string; rowNo: number }) =>
            entry.severity === 'ERROR' &&
            entry.code === fixture.code &&
            entry.rowNo === fixture.row,
        ),
      )
      await call(
        'technical',
        `${path}/bom/import`,
        'POST',
        {
          previewToken: invalid.previewToken,
          activate: true,
        },
        422,
      )
      // Explicit fault injection: normal invalid uploads never create a token.
      // Exercise old/inconsistent server-side data without trusting caller rows.
      const valid = await call(
        'technical',
        `${path}/bom/import-preview`,
        'POST',
        upload(),
      )
      const { previewToken: _invalidToken, ...stored } = invalid
      if (index % 2 === 0) stored.summary.errors = 0
      await client`update npi_bom_previews set preview=${JSON.stringify(stored)}::jsonb where id=${valid.previewToken}`
      for (let attempt = 0; attempt < 2; attempt++) {
        const rejected = await call(
          'technical',
          `${path}/bom/import`,
          'POST',
          {
            previewToken: valid.previewToken,
            activate: true,
            summary: { errors: 0 },
            validation: [],
            previewRows: valid.previewRows,
          },
          400,
        )
        assert.equal(rejected.code, fixture.code)
        assert.match(rejected.error, new RegExp(`第${fixture.row}行`))
        assert.match(rejected.error, /重新预览/)
      }
      const [record] =
        await client`select consumed_import_id from npi_bom_previews where id=${valid.previewToken}`
      assert.equal(record!.consumed_import_id, null)
      const after = await call('technical', path)
      assert.equal(after.version, before.version)
      assert.equal(after.activeBomImportId, null)
      assert.equal(after.imports.length, 0)
      assert.deepEqual(after.history, before.history)
      assert.deepEqual(after.items, before.items)
      const [count] =
        await client`select count(*)::int as n from npi_bom_imports where program_id=${project.id}`
      assert.equal(count!.n, 0)
    }
    const good = await call(
      'technical',
      `${path}/bom/import-preview`,
      'POST',
      upload(),
    )
    assert.equal(good.summary.errors, 0)
    assert.ok(
      good.validation.some(
        (entry: { severity: string }) => entry.severity === 'WARNING',
      ),
    )
    const saved = await call(
      'technical',
      `${path}/bom/import`,
      'POST',
      {
        previewToken: good.previewToken,
        activate: true,
      },
      201,
    )
    assert.equal(saved.versionNo, 1)
    assert.equal(saved.rowCount, 2)
  })
  await test('Assigned material workbench and history are owner-scoped without granting project access', async () => {
    const project = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '跨项目物料分配',
        motorModel: 'ASSIGNMENT',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const item = await call(
      'technical',
      `/projects/${project.id}/external-items`,
      'POST',
      {
        name: '其他技术人员的临时件',
        trackingType: 'material',
        qty: '1',
        ownerId: accounts.otherTech!.id,
        requiredDate: '2026-10-15',
        affectsKit: true,
      },
      201,
    )
    const own = await call('otherTech', '/workbench/materials')
    assert.equal(own.actorId, accounts.otherTech!.id)
    assert.ok(own.items.some((row: { id: string }) => row.id === item.id))
    assert.ok(
      own.items.every(
        (row: { ownerId: string; trackingType: string }) =>
          row.ownerId === accounts.otherTech!.id &&
          row.trackingType === 'material',
      ),
    )
    await call('otherTech', `/projects/${project.id}`, 'GET', undefined, 403)
    await call(
      'otherTech',
      `/projects/${project.id}/bom/tree`,
      'GET',
      undefined,
      403,
    )
    assert.equal(
      (await call('otherTech', `/tracking/${item.id}/history`)).history.length,
      0,
    )
    await call('otherTech', `/tracking/${item.id}/promise`, 'POST', {
      expectedVersion: item.version,
      committedDate: '2026-10-14',
    })
    const history = await call('otherTech', `/tracking/${item.id}/history`)
    assert.equal(history.item.firstCommittedDate, '2026-10-14')
    for (const role of ['procurement', 'supervisor', 'admin'])
      await call(role, '/workbench/materials', 'GET', undefined, 403)
    const current = (
      await call('technical', `/projects/${project.id}`)
    ).items.find((row: { id: string }) => row.id === item.id)
    await call('technical', `/tracking/${item.id}/plan`, 'PATCH', {
      expectedVersion: current.version,
      ownerId: accounts.manufacturing!.id,
      requiredDate: current.requiredDate,
      reason: '移交制造负责人',
    })
    assert.ok(
      !(await call('otherTech', '/workbench/materials')).items.some(
        (row: { id: string }) => row.id === item.id,
      ),
    )
    await call(
      'otherTech',
      `/tracking/${item.id}/history`,
      'GET',
      undefined,
      403,
    )
    assert.ok(
      (await call('manufacturing', '/workbench/materials')).items.some(
        (row: { id: string }) => row.id === item.id,
      ),
    )
    assert.equal(
      (await call('manufacturing', `/tracking/${item.id}/history`)).item
        .firstCommittedDate,
      '2026-10-14',
    )
  })
  await test('Other external materials preserve category, scoped replies, completion and inheritance without changing recent buyer', async () => {
    const p = await call(
      'technical',
      '/projects',
      'POST',
      {
        name: '其他物料类型验证',
        motorModel: 'OTHER-MATERIAL',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: '2026-10-15',
        prototypeRequiredDate: '2026-10-20',
      },
      201,
    )
    const path = `/projects/${p.id}`
    const recent = (await call('technical', '/meta')).recentProcurementOwnerId
    const payload = {
      name: '特殊试验用品',
      specification: '高温测试',
      qty: '2.5',
      unit: '套',
      trackingType: 'other',
      ownerId: accounts.otherTech!.id,
      requiredDate: '2026-10-15',
      affectsKit: true,
      remark: '试验用途',
    }
    const item = await call(
      'technical',
      path + '/external-items',
      'POST',
      payload,
      201,
    )
    assert.equal(item.trackingType, 'other')
    assert.equal(item.sourceType, 'EXTERNAL')
    assert.equal(item.status, 'pending_reply')
    assert.equal(
      (await call('technical', '/meta')).recentProcurementOwnerId,
      recent,
    )
    const work = await call('otherTech', '/workbench/materials')
    assert.equal(
      work.items.find((row: { id: string }) => row.id === item.id).trackingType,
      'other',
    )
    await call('otherTech', path, 'GET', undefined, 403)
    await call(
      'procurement',
      `/tracking/${item.id}/history`,
      'GET',
      undefined,
      403,
    )
    await call('otherTech', `/tracking/${item.id}/promise`, 'POST', {
      expectedVersion: 1,
      committedDate: '2026-10-16',
    })
    const detail = await call('technical', path)
    assert.equal(detail.kit.predictedKitDate, '2026-10-16')
    assert.equal(detail.kit.bottleneck.id, item.id)
    assert.equal(
      (await call('otherTech', `/tracking/${item.id}/history`)).history.length,
      1,
    )
    const updated = detail.items.find(
      (row: { id: string }) => row.id === item.id,
    )
    await call('otherTech', `/tracking/${item.id}/complete`, 'POST', {
      expectedVersion: updated.version,
      actualCompleteDate: new Date().toISOString(),
    })
    assert.equal(
      (await call('otherTech', '/workbench/materials')).items.find(
        (row: { id: string }) => row.id === item.id,
      ).status,
      'completed',
    )
    const before = (await call('technical', path)).items.length
    for (const trackingType of ['', null, 'OTHER', 'typo', {}]) {
      const invalid = await call(
        'technical',
        path + '/external-items',
        'POST',
        { ...payload, trackingType, ownerId: accounts.procurement!.id },
        422,
      )
      assert.equal(invalid.code, 'VALIDATION_ERROR')
    }
    await call(
      'technical',
      path + '/external-items',
      'POST',
      { ...payload, ownerId: accounts.procurement!.id },
      422,
    )
    assert.equal((await call('technical', path)).items.length, before)
    const copy = {
      name: '继承其他物料',
      code: `OTHER-${crypto.randomUUID()}`,
      motorModel: 'OTHER-COPY',
      technicalOwnerId: accounts.technical!.id,
      manufacturingOwnerId: accounts.manufacturing!.id,
      requiredKitDate: '2026-11-15',
      prototypeRequiredDate: '2026-11-20',
      copyBom: false,
      copyExternal: true,
    }
    const preview = await call(
      'technical',
      path + '/inheritance-preview',
      'POST',
      copy,
    )
    const inherited = await call(
      'technical',
      path + '/inherit',
      'POST',
      { ...copy, expectedSnapshot: preview.expectedSnapshot },
      201,
    )
    const target = await call('technical', `/projects/${inherited.id}`)
    const copied = target.items.find(
      (row: { sourceType: string }) => row.sourceType === 'EXTERNAL',
    )
    assert.equal(copied.trackingType, 'other')
    assert.equal(copied.name, payload.name)
    assert.equal(copied.qty, payload.qty)
    assert.equal(copied.ownerId, accounts.manufacturing!.id)
    assert.equal(copied.firstCommittedDate, null)
    assert.equal(copied.currentCommittedDate, null)
    assert.equal(copied.actualCompleteDate, null)
    assert.equal(target.history.length, 0)
  })
  await test('Database import/version uniqueness and program FK integrity', async () => {
    const result =
      await client`select count(*)::int as count from npi_bom_items bi left join npi_bom_imports b on bi.import_id=b.id where b.id is null`
    assert.equal(result[0]!.count, 0)
    await assert.rejects(
      client`insert into npi_manufacturing_plan(program_id) values(${projectId})`,
    )
    const p = await call('technical', `/projects/${projectId}`)
    assert.equal(p.imports.length, 2)
    await assert.rejects(
      client`update npi_bom_imports set version_no=1 where program_id=${projectId} and version_no=2`,
      { code: '23505' },
    )
    await assert.rejects(client`delete from programs where id=${projectId}`)
  })
} finally {
  // All fixtures live only in the explicit test database. Preserve rows for
  // diagnosis; random UUIDs make a repeated run independent.
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  )
  await client.end()
  const database = await import('../packages/core/src/lib/db')
  await (database.db as unknown as { $client: postgres.Sql }).$client.end()
  await database.migrationClient.end()
}
