// SPDX-License-Identifier: AGPL-3.0-or-later
import 'dotenv/config'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import postgres from 'postgres'
import { serve } from '@hono/node-server'
import type { ProjectEventsPage } from '../packages/core/src/lib/npi/project-events'

if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw Error('Explicit _test database required')
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const service = await import('../packages/core/src/lib/npi/service')
const database = await import('../packages/core/src/lib/db')
const { default: app } = await import('../packages/core/src/server/routes/npi')
const { SessionManager } = await import('../packages/core/src/lib/auth/session')
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
const call = async (role: string, id: string, query = '', expected = 200) => {
  const r = await fetch(
    `${base}/projects/${id}/events${query ? '?' + query : ''}`,
    { headers: tokens[role] ? { cookie: `session=${tokens[role]}` } : {} },
  )
  const body = await r.json()
  assert.equal(r.status, expected, JSON.stringify(body))
  assert.equal(r.headers.get('cache-control'), 'no-store')
  return body as ProjectEventsPage
}
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
    await client`insert into users(id,email,name,active) values(${id},${id + '@project-events.test.invalid'},${'动态验证-' + role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role === 'otherTechnical' ? 'technical' : role === 'otherManufacturing' ? 'manufacturing' : role})`
    const session = await SessionManager.createSession(id)
    sessions.push(session.session.id)
    tokens[role] = session.sessionToken
  }
  for (let i = 0; i < 2; i++) {
    const p = await service.createProject(users.technical!, {
      name: '动态验证-' + crypto.randomUUID().slice(0, 8),
      motorModel: 'EVENTS',
      technicalOwnerId: users.technical,
      manufacturingOwnerId: users.manufacturing,
      requiredKitDate: day(5),
      prototypeRequiredDate: day(10),
    })
    projects.push(p.id)
  }
  const [id, otherId] = projects as [string, string]
  const detail = await service.projectDetail(users.technical!, id)
  const node = detail.items.find((i) => i.trackingType === 'process')!
  await client`insert into npi_events(program_id,object_id,action,detail,actor_id,created_at) select ${id},${node.id},case when g%2=0 then 'COMPLETED' else 'DETAILS_UPDATED' end,jsonb_build_object('reason',case when g=137 then '验证100%_文本' else '追溯-'||g::text end,'actualCompleteDate',${today}::text),${users.manufacturing!},${today + 'T00:00:00.123000+08:00'}::timestamptz + g*interval '1 microsecond' from generate_series(1,137) g`
  const [previous] =
    await client`insert into npi_events(program_id,object_id,action,detail,actor_id,created_at) values(${id},${node.id},'COMPLETED','{}',${users.manufacturing!},${day(-1) + 'T23:59:59.999999+08:00'}) returning id`
  const [next] =
    await client`insert into npi_events(program_id,object_id,action,detail,actor_id,created_at) values(${id},${node.id},'COMPLETED','{}',${users.manufacturing!},${day(1) + 'T00:00:00+08:00'}) returning id`
  const expected = (
    await client`select id from npi_events where program_id=${id} order by created_at desc,id desc`
  ).map((r) => r.id as string)
  const first = await call('technical', id)
  assert.equal(first.items.length, 25)
  assert.equal(first.projectId, id)
  const [added] =
    await client`insert into npi_events(program_id,object_id,action,detail,actor_id,created_at) values(${id},${node.id},'DETAILS_UPDATED','{"reason":"翻页期间新增"}',${users.technical!},${day(2) + 'T12:00:00+08:00'}) returning id`
  const collected = first.items.map((r) => r.id)
  let cursor = first.nextCursor,
    pages = 1
  while (cursor) {
    const page = await call('technical', id, 'before=' + cursor)
    assert.ok(page.items.length <= 25)
    collected.push(...page.items.map((r) => r.id))
    cursor = page.nextCursor
    pages++
    assert.ok(pages < 20)
  }
  assert.deepEqual(collected, expected)
  assert.equal(new Set(collected).size, expected.length)
  assert.ok(collected.length > 100)
  assert.equal(collected.includes(added!.id as string), false)
  assert.equal((await call('technical', id)).items[0]!.id, added!.id)
  const literal = await call(
    'manufacturing',
    id,
    'q=' + encodeURIComponent('100%_'),
  )
  assert.equal(literal.items.length, 1)
  assert.equal(literal.items[0]!.objectName, '工艺准备')
  assert.equal(literal.items[0]!.actorName, '动态验证-manufacturing')
  const dates = await call(
    'supervisor',
    id,
    `limit=100&from=${today}&to=${today}&category=completion`,
  )
  assert.equal(dates.items.length, 68)
  assert.ok(dates.items.every((r) => r.action === 'COMPLETED'))
  assert.equal(
    dates.items.some((r) => r.id === previous!.id || r.id === next!.id),
    false,
  )
  assert.equal(dates.nextCursor, null)
  for (const role of ['technical', 'manufacturing', 'supervisor', 'admin'])
    assert.equal((await call(role, id, 'limit=1')).items.length, 1)
  for (const role of ['procurement', 'otherTechnical', 'otherManufacturing'])
    await call(role, id, '', 403)
  await call('anonymous', id, '', 401)
  for (const query of [
    'limit=0',
    'limit=101',
    'limit=1.5',
    'limit=NaN',
    'before=bad',
    'category=not-a-category',
    'from=2026-02-30',
    'from=' + day(1) + '&to=' + today,
    'q=' + 'a'.repeat(201),
  ])
    await call('technical', id, query, 422)
  await call('technical', id, 'before=' + crypto.randomUUID(), 400)
  const foreign = (await call('technical', otherId)).items[0]!.id
  await call('technical', id, 'before=' + foreign, 400)
  await client`update npi_projects set manufacturing_owner_id=${users.otherManufacturing!} where program_id=${id}`
  await call('manufacturing', id, 'before=' + first.nextCursor, 403)
  assert.ok((await call('otherManufacturing', id)).items.length)
  // A cursor from within the same millisecond must preserve all PostgreSQL microseconds.
  const micros = (
    await client`select id from npi_events where program_id=${id} and created_at>=${today + 'T00:00:00.123000+08:00'} and created_at<${today + 'T00:00:00.124000+08:00'} order by created_at desc,id desc`
  ).map((r) => r.id as string)
  assert.equal(micros.length, 137)
  const afterMicro = await call(
    'technical',
    id,
    'limit=100&before=' + micros[60],
  )
  assert.deepEqual(
    afterMicro.items.slice(0, 76).map((r) => r.id),
    micros.slice(61),
  )
  fs.writeFileSync(
    '/tmp/npi-project-events-http-result.json',
    JSON.stringify(
      {
        passed: true,
        recordsTraversed: collected.length,
        pages,
        microsecondRecords: 137,
        stableCursor: true,
        noDuplicateOrMissingRecords: true,
        concurrentInsertRefresh: true,
        beijingDateBounds: true,
        literalSearch: true,
        actorAndObjectNames: true,
        roleIsolation: true,
        revokedOwnerDenied: true,
        invalidQueriesRejected: true,
        foreignCursorRejected: true,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: complete project event traversal beyond 100, exact microsecond cursors, concurrent insert behavior, filters, dates, actors and role/cursor isolation.',
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
}
