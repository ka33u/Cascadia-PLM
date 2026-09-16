// SPDX-License-Identifier: AGPL-3.0-or-later
import 'dotenv/config'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import postgres from 'postgres'
import { serve } from '@hono/node-server'
import type * as ServiceModule from '../packages/core/src/lib/npi/service'
import type * as DatabaseModule from '../packages/core/src/lib/db'
import type * as RouteModule from '../packages/core/src/server/routes/npi'
import type * as SessionModule from '../packages/core/src/lib/auth/session'

if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw Error('Explicit _test database required')
const fixtureRecord = '/tmp/npi-external-recovery-http-fixtures.json'
if (
  fs.existsSync(fixtureRecord) &&
  !JSON.parse(fs.readFileSync(fixtureRecord, 'utf8')).cleaned
)
  throw Error('Previous test fixtures need cleanup')
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const sourceRoot =
  process.env.NPI_EXTERNAL_SOURCE_ROOT ||
  new URL('../packages/core/src/', import.meta.url).href
const service = (await import(
  sourceRoot + 'lib/npi/service.ts'
)) as typeof ServiceModule
const database = (await import(
  sourceRoot + 'lib/db/index.ts'
)) as typeof DatabaseModule
const { default: app } = (await import(
  sourceRoot + 'server/routes/npi.ts'
)) as typeof RouteModule
const { SessionManager } = (await import(
  sourceRoot + 'lib/auth/session.ts'
)) as typeof SessionModule
const client = postgres(process.env.TEST_DATABASE_URL, { max: 1 })
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
await new Promise<void>((resolve) =>
  server.listening ? resolve() : server.once('listening', resolve),
)
const address = server.address()
assert.ok(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}`
const users: Record<string, string> = {},
  sessions: Array<string> = [],
  tokens: Record<string, string> = {},
  projects: Array<string> = []
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
const day = (offset: number) =>
  new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10)
try {
  for (const role of [
    'technical',
    'manufacturing',
    'procurement',
    'supervisor',
    'admin',
    'otherTechnical',
    'otherManufacturing',
  ]) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@external-retry.test.invalid'},${'新增重试-' + role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role === 'otherTechnical' ? 'technical' : role === 'otherManufacturing' ? 'manufacturing' : role})`
    const session = await SessionManager.createSession(id)
    sessions.push(session.session.id)
    tokens[role] = session.sessionToken
  }
  for (let i = 0; i < 2; i++) {
    const p = await service.createProject(users.technical!, {
      name: '新增重试-' + crypto.randomUUID().slice(0, 8),
      motorModel: 'EVENTS',
      technicalOwnerId: users.technical,
      manufacturingOwnerId: users.manufacturing,
      requiredKitDate: day(5),
      prototypeRequiredDate: day(10),
    })
    projects.push(p.id)
  }
  fs.writeFileSync(
    fixtureRecord,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        sourceRoot,
        ownerPid: process.pid,
        projectIds: projects,
        userIds: Object.values(users),
        cleaned: false,
      },
      null,
      2,
    ),
  )
  const { a, b } = { a: projects[0]!, b: projects[1]! }
  const call = async (
    role: string,
    projectId: string,
    body: Record<string, unknown>,
    expected = 201,
  ) => {
    const response = await fetch(
      `${base}/projects/${projectId}/external-items`,
      {
        method: 'POST',
        headers: {
          cookie: `session=${tokens[role]}`,
          'content-type': 'application/json',
          origin: base,
          'x-npi-actor': users[role]!,
        },
        body: JSON.stringify(body),
      },
    )
    const result = await response.json()
    assert.equal(response.status, expected, JSON.stringify(result))
    return result as Awaited<ReturnType<typeof service.addExternal>>
  }
  const requestId = crypto.randomUUID()
  const payload = {
    requestId,
    name: '重试编码器',
    specification: '带技术要求',
    qty: '999999999999.123456',
    unit: '件',
    ownerId: users.procurement!,
    requiredDate: day(8),
    affectsKit: true,
    supplier: '测试供应商',
    remark: '精确数量保留',
  }
  const concurrent = await Promise.all(
    Array.from({ length: 5 }, () => call('technical', a, payload)),
  )
  assert.equal(
    new Set(concurrent.map((row) => row.id)).size,
    1,
    'Concurrent identical retry key must create exactly one material',
  )
  const created = concurrent[0]!
  assert.equal(created.qty, payload.qty)
  assert.equal(created.status, 'pending_reply')
  const countCreated = async (projectId: string, itemId: string) =>
    Number(
      (
        await client`select count(*)::int as n from npi_events where program_id=${projectId} and object_id=${itemId} and action='EXTERNAL_CREATED'`
      )[0]!.n,
    )
  assert.equal(await countCreated(a, created.id), 1)
  assert.equal(
    (await service.procurement(users.procurement!)).items.filter(
      (i) => i.id === created.id,
    ).length,
    1,
  )
  assert.equal(
    (await service.metadata(users.technical!)).recentProcurementOwnerId,
    users.procurement,
  )
  await call('technical', a, { ...payload, qty: '2' }, 409)
  await call(
    'technical',
    a,
    { ...payload, ownerId: users.otherManufacturing! },
    409,
  )
  const [row] =
    await client`select * from npi_tracking_items where id=${created.id}`
  assert.equal(row!.qty, payload.qty)
  assert.equal(
    (
      await call('technical', a.toUpperCase(), {
        ...payload,
        ownerId: users.procurement!.toUpperCase(),
        requestId: requestId.toUpperCase(),
      })
    ).id,
    created.id,
  )
  // A retry returns the current item without overwriting its subsequent promises or supplier.
  await service.updatePromise(users.procurement!, created.id, {
    expectedVersion: created.version,
    committedDate: day(6),
    supplier: '已更新的供应商',
  })
  const replay = await call('technical', a, payload)
  assert.equal(replay.id, created.id)
  assert.equal(replay.currentCommittedDate, day(6))
  assert.equal(replay.supplier, '已更新的供应商')
  assert.equal(
    (await service.trackingHistory(users.procurement!, created.id)).history
      .length,
    1,
  )
  await client`update users set active=false where id=${users.procurement!}`
  assert.equal((await call('technical', a, payload)).id, created.id)
  await client`update users set active=true where id=${users.procurement!}`
  // Intentional new submissions, other actors and other projects are separate scopes.
  const intentional = await call('technical', a, {
    ...payload,
    requestId: crypto.randomUUID(),
  })
  const otherActor = await call('manufacturing', a, payload)
  const otherProject = await call('technical', b, payload)
  assert.equal(
    new Set([created.id, intentional.id, otherActor.id, otherProject.id]).size,
    4,
  )
  const legacy = { ...payload } as Record<string, unknown>
  delete legacy.requestId
  const legacyA = await call('technical', a, legacy),
    legacyB = await call('technical', a, legacy)
  assert.notEqual(legacyA.id, legacyB.id)
  const oldCount = (
    await service.projectDetail(users.technical!, a)
  ).items.filter((i) => i.sourceType === 'EXTERNAL').length
  await call('technical', a, { ...payload, requestId: 'not-a-uuid' }, 422)
  await call(
    'technical',
    a,
    { ...payload, requestId: crypto.randomUUID(), qty: '0' },
    422,
  )
  const correctedKey = crypto.randomUUID()
  await call(
    'technical',
    a,
    { ...payload, requestId: correctedKey, ownerId: users.supervisor },
    422,
  )
  const corrected = await call('technical', a, {
    ...payload,
    requestId: correctedKey,
  })
  assert.ok(corrected.id)
  assert.equal(
    (await service.projectDetail(users.technical!, a)).items.filter(
      (i) => i.sourceType === 'EXTERNAL',
    ).length,
    oldCount + 1,
  )
  await call('procurement', a, payload, 403)
  await call('supervisor', a, payload, 403)
  await call('otherTechnical', a, payload, 403)
  // Permission is checked before returning an earlier submission result, including after a handoff.
  await client`update npi_projects set technical_owner_id=${users.otherTechnical!} where program_id=${a}`
  await call('technical', a, payload, 403)
  await client`update npi_projects set technical_owner_id=${users.technical!} where program_id=${a}`
  await client`update npi_projects set current_npi_stage='completed' where program_id=${b}`
  await call('technical', b, payload, 400)
  assert.equal(await countCreated(a, created.id), 1)
  fs.writeFileSync(
    '/tmp/npi-external-recovery-http-result.json',
    JSON.stringify(
      {
        passed: true,
        sourceRoot,
        concurrentRequests: 5,
        concurrentUniqueMaterials: 1,
        creationEvents: 1,
        exactQuantity: created.qty,
        changedPayloadRejected: true,
        scopeIsolation: true,
        legacyRequestsIndependent: true,
        subsequentHistoryPreserved: true,
        inactiveOriginalBuyerReplay: true,
        permissionRechecked: true,
        completedProjectReadOnly: true,
        invalidInputsNoWrite: true,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: external creation retry identity, five concurrent requests, exact quantity, event uniqueness, payload conflict, current-state replay, actor/project/legacy scope and permission checks.',
  )
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  )
  for (const id of sessions) await SessionManager.deleteSession(id)
  for (const id of projects) {
    await client`delete from npi_promise_history where program_id=${id}`
    await client`delete from npi_tracking_items where program_id=${id}`
    await client`delete from npi_projects where program_id=${id}`
    await client`delete from programs where id=${id}`
  }
  for (const id of Object.values(users)) {
    await client`delete from npi_events where actor_id=${id} and program_id is null`
    await client`delete from users where id=${id}`
  }
  await client.end({ timeout: 5 })
  await (database.db as unknown as { $client: postgres.Sql }).$client.end({
    timeout: 5,
  })
  await database.migrationClient.end({ timeout: 5 })
  if (fs.existsSync(fixtureRecord))
    fs.writeFileSync(
      fixtureRecord,
      JSON.stringify(
        {
          ...JSON.parse(fs.readFileSync(fixtureRecord, 'utf8')),
          cleaned: true,
          cleanedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
}
