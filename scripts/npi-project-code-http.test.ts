// SPDX-License-Identifier: AGPL-3.0-or-later
// Focused SRS47 project-code conflict test; never runs the full HTTP suite.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mock } from 'node:test'
import { PgDatabase } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import { serve } from '@hono/node-server'
import type * as DatabaseModule from '../packages/core/src/lib/db'
import type * as RouteModule from '../packages/core/src/server/routes/npi'
import type * as SessionModule from '../packages/core/src/lib/auth/session'
import type * as ProgramModule from '../packages/core/src/lib/db/schema/programs'

const url = process.env.TEST_DATABASE_URL
if (!url) throw Error('Explicit TEST_DATABASE_URL required')
const target = new URL(url)
if (
  !target.pathname.endsWith('_test') ||
  !['localhost', '127.0.0.1', '[::1]', '::1'].includes(target.hostname) ||
  target.searchParams.has('host')
)
  throw Error('Only an explicit local _test database is allowed')
process.env.DATABASE_URL = url
const tag = process.env.NPI_PROJECT_CODE_TAG || 'candidate'
if (!/^[a-z-]+$/.test(tag)) throw Error('Invalid test tag')
const recordPath = `/tmp/npi-project-code-${tag}-fixtures.json`
const resultPath = `/tmp/npi-project-code-${tag}-result.json`
if (
  fs.existsSync(recordPath) &&
  !JSON.parse(fs.readFileSync(recordPath, 'utf8')).cleaned
)
  throw Error('Prior scoped fixtures need cleanup')
fs.rmSync(resultPath, { force: true })
const sourceRoot =
  process.env.NPI_PROJECT_CODE_SOURCE_ROOT ||
  new URL('../packages/core/src/', import.meta.url).href
const database = (await import(
  sourceRoot + 'lib/db/index.ts'
)) as typeof DatabaseModule
const { default: app } = (await import(
  sourceRoot + 'server/routes/npi.ts'
)) as typeof RouteModule
const { SessionManager } = (await import(
  sourceRoot + 'lib/auth/session.ts'
)) as typeof SessionModule
const { programs } = (await import(
  sourceRoot + 'lib/db/schema/programs.ts'
)) as typeof ProgramModule
const client = postgres(url, { max: 1 })
const userIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
const tokens: Array<string> = []
const raceCode = 'RACE-' + crypto.randomUUID()
const otherCode = 'OTHER-' + crypto.randomUUID()
const requests: Array<
  Promise<{ status: number; body: Record<string, unknown> }>
> = []
const active = new Set<Promise<Response>>()
const participants = 5
let arrivals = 0
let release!: () => void
const gate = new Promise<void>((resolve) => (release = resolve))
let insertMock: ReturnType<typeof mock.method> | undefined
let raceActive = false
let cleaned = false
let outcome: Record<string, unknown> = { passed: false, sourceRoot }
const record = (extra: Record<string, unknown> = {}) =>
  fs.writeFileSync(
    recordPath,
    JSON.stringify(
      {
        sourceRoot,
        ownerPid: process.pid,
        userIds,
        codes: [raceCode, otherCode],
        cleaned,
        ...extra,
      },
      null,
      2,
    ),
  )
record()

// Test-only routes verify the error boundary without any database writes.
// These routes are added only to this isolated test process, before routing starts.
for (const [name, constraint, wrapped] of [
  ['raw-code', 'programs_code_unique', false],
  ['wrapped-code', 'programs_code_unique', true],
  ['raw-other', 'program_members_unique', false],
  ['wrapped-other', 'npi_bom_program_version', true],
] as const) {
  app.get('/__project-code-test/' + name, () => {
    const pg = Object.assign(new Error('Private SQL diagnostic fixture'), {
      code: '23505',
      constraint_name: constraint,
    })
    throw wrapped ? new Error('Query failed', { cause: pg }) : pg
  })
}
const server = serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const pending = Promise.resolve(app.fetch(request))
    active.add(pending)
    void pending.then(
      () => active.delete(pending),
      () => active.delete(pending),
    )
    return pending
  },
})
await new Promise<void>((resolve) =>
  server.listening ? resolve() : server.once('listening', resolve),
)
const address = server.address()
assert.ok(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}`
const call = async (
  actor: number,
  path: string,
  body?: Record<string, unknown>,
) => {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      cookie: `session=${tokens[actor]}`,
      'x-npi-actor': userIds[actor]!,
      'content-type': 'application/json',
      origin: base,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  }
}
const payload = (code: string) => ({
  code,
  name: '项目编号并发专项',
  motorModel: 'SRS47',
  technicalOwnerId: userIds[0],
  manufacturingOwnerId: userIds[2],
  requiredKitDate: '2026-10-10',
  prototypeRequiredDate: '2026-10-20',
})
try {
  const constraint =
    await client`select 1 from pg_constraint c join pg_class t on t.oid=c.conrelid where t.relname='programs' and c.conname='programs_code_unique' and c.contype='u'`
  assert.equal(constraint.length, 1)
  for (const [index, id] of userIds.entries()) {
    await client`insert into users(id,email,name,active) values(${id},${id + '@project-code.test.invalid'},'项目编号专项',true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${index === 2 ? 'manufacturing' : 'technical'})`
    tokens.push((await SessionManager.createSession(id)).sessionToken)
  }

  // Hold only this process's Program insert builders after their real prechecks.
  // Once all five requests arrive, execute the real PostgreSQL inserts together.
  // No table locks, fake SQL results, triggers or changes to database schema.
  insertMock = mock.method(
    PgDatabase.prototype,
    'insert',
    new Proxy(PgDatabase.prototype.insert, {
      apply(original, receiver, args) {
        const builder = Reflect.apply(original, receiver, args)
        if (!raceActive || args[0] !== programs) return builder
        return new Proxy(builder, {
          get(targetBuilder, property, targetReceiver) {
            if (property !== 'values')
              return Reflect.get(targetBuilder, property, targetReceiver)
            return (...values: Array<unknown>) => {
              const query = Reflect.apply(
                targetBuilder.values,
                targetBuilder,
                values,
              )
              assert.ok(query !== null && typeof query === 'object')
              return new Proxy(query, {
                get(targetQuery, key, queryReceiver) {
                  if (key !== 'returning')
                    return Reflect.get(targetQuery, key, queryReceiver)
                  return async (...selection: Array<unknown>) => {
                    arrivals++
                    if (arrivals === participants) release()
                    await gate
                    return Reflect.apply(
                      Reflect.get(targetQuery, 'returning'),
                      targetQuery,
                      selection,
                    )
                  }
                },
              })
            }
          },
        })
      },
    }),
  )
  raceActive = true
  for (let i = 0; i < participants; i++)
    requests.push(call(i % 2, '/projects', payload(raceCode)))
  const concurrent = await Promise.all(requests)
  raceActive = false
  insertMock.mock.restore()
  insertMock = undefined
  outcome = {
    ...outcome,
    arrivals,
    concurrent: concurrent.map(({ status, body }) => ({
      status,
      code: body.code,
      error: body.error,
      id: body.id,
    })),
  }
  const winners = concurrent.filter((row) => row.status === 201)
  const losers = concurrent.filter((row) => row.status === 409)
  assert.equal(
    arrivals,
    participants,
    'All requests must pass the real duplicate-code precheck before any insert',
  )
  assert.equal(winners.length, 1)
  assert.equal(losers.length, participants - 1)
  for (const row of losers)
    assert.deepEqual(row.body, {
      code: 'DUPLICATE_PROJECT_CODE',
      error: '项目编号已存在',
    })
  const id = winners[0]!.body.id as string
  const counts = (
    await client`select (select count(*)::int from programs where code=${raceCode}) as programs, (select count(*)::int from npi_projects where program_id=${id}) as projects, (select count(*)::int from npi_manufacturing_plan where program_id=${id}) as plans, (select count(*)::int from npi_tracking_items where program_id=${id}) as nodes, (select count(*)::int from npi_events where program_id=${id} and action='PROJECT_CREATED') as events`
  )[0]!
  assert.deepEqual(
    { ...counts },
    { programs: 1, projects: 1, plans: 1, nodes: 4, events: 1 },
  )
  const existing = await call(1, '/projects', payload(raceCode))
  assert.equal(existing.status, 409)
  assert.deepEqual(existing.body, {
    code: 'DUPLICATE_PROJECT_CODE',
    error: '项目编号已存在',
  })
  const other = await call(0, '/projects', payload(otherCode))
  assert.equal(other.status, 201)
  assert.equal(
    (
      await client`select count(*)::int as n from programs where created_by in ${client(userIds)}`
    )[0]!.n,
    2,
  )
  const boundary: Record<string, string> = {}
  for (const name of [
    'raw-code',
    'wrapped-code',
    'raw-other',
    'wrapped-other',
  ]) {
    const response = await call(0, '/__project-code-test/' + name)
    assert.equal(response.status, 409)
    const expected = name.endsWith('other')
      ? 'VERSION_CONFLICT'
      : 'DUPLICATE_PROJECT_CODE'
    assert.equal(response.body.code, expected)
    assert.ok(!JSON.stringify(response.body).includes('Private SQL'))
    boundary[name] = expected
  }
  outcome = {
    ...outcome,
    passed: true,
    counts,
    existingCodeRejected: true,
    otherCodeCreated: true,
    errorBoundaryControls: boundary,
  }
  console.log(
    'PASS: SRS47 duplicate project code; five real concurrent inserts, one project/four nodes/one event; precheck and unrelated unique conflicts preserved.',
  )
} finally {
  release()
  await Promise.allSettled(requests)
  await Promise.allSettled([...active])
  insertMock?.mock.restore()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  try {
    const own =
      await client`select id from programs where created_by in ${client(userIds)}`
    const projectIds = own.map((row) => String(row.id))
    record({ projectIds })
    await client.begin(async (tx) => {
      if (projectIds.length) {
        await tx`delete from npi_promise_history where program_id in ${tx(projectIds)}`
        await tx`delete from npi_events where program_id in ${tx(projectIds)}`
        await tx`delete from npi_tracking_items where program_id in ${tx(projectIds)}`
        await tx`delete from npi_manufacturing_plan where program_id in ${tx(projectIds)}`
        await tx`delete from npi_projects where program_id in ${tx(projectIds)}`
        await tx`delete from program_members where program_id in ${tx(projectIds)}`
        await tx`delete from programs where id in ${tx(projectIds)}`
      }
      await tx`delete from sessions where user_id in ${tx(userIds)}`
      await tx`delete from npi_user_roles where user_id in ${tx(userIds)}`
      await tx`delete from users where id in ${tx(userIds)}`
    })
    const residuals = (
      await client`select (select count(*)::int from programs where created_by in ${client(userIds)}) as programs, (select count(*)::int from users where id in ${client(userIds)}) as users, (select count(*)::int from sessions where user_id in ${client(userIds)}) as sessions, (select count(*)::int from npi_events where actor_id in ${client(userIds)}) as events`
    )[0]!
    assert.ok(Object.values(residuals).every((value) => value === 0))
    cleaned = true
    record({ projectIds, cleanedAt: new Date().toISOString(), residuals })
    fs.writeFileSync(
      resultPath,
      JSON.stringify(
        {
          ...outcome,
          verifiedAt: new Date().toISOString(),
          cleaned,
          residuals,
          scope:
            'Project creation duplicate-code conflict and error-boundary controls only; no full HTTP suite or BOM/browser/real-pilot acceptance.',
        },
        null,
        2,
      ) + '\n',
    )
  } finally {
    await client.end({ timeout: 5 })
    await (database.db as unknown as { $client: postgres.Sql }).$client.end({
      timeout: 5,
    })
    await database.migrationClient.end({ timeout: 5 })
  }
}
