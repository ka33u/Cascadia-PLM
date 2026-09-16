// SPDX-License-Identifier: AGPL-3.0-or-later
import 'dotenv/config'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'

if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw Error('Explicit _test database required')
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const service = await import('../packages/core/src/lib/npi/service')
const database = await import('../packages/core/src/lib/db')
const schema = await import('../packages/core/src/lib/db/schema')
let queryCount = 0
const client = postgres(process.env.TEST_DATABASE_URL, {
  max: 1,
  debug: (_id, query) => {
    if (query.trim().toLowerCase().startsWith('select')) queryCount++
  },
})
const defaultClient = (database.db as unknown as { $client: postgres.Sql })
  .$client
const testDb = drizzle(client, { schema })
database.setTestDb(testDb)
const baselineRoot = process.env.NPI_BASELINE_APP_ROOT
const baseline: typeof service | undefined = baselineRoot
  ? await import(
      pathToFileURL(
        path.join(baselineRoot, 'packages/core/src/lib/npi/service.ts'),
      ).href
    )
  : undefined
const baselineDatabase: typeof database | undefined = baselineRoot
  ? await import(
      pathToFileURL(
        path.join(baselineRoot, 'packages/core/src/lib/db/index.ts'),
      ).href
    )
  : undefined
const baselineDefaultClient =
  baselineDatabase &&
  (baselineDatabase.db as unknown as { $client: postgres.Sql }).$client
baselineDatabase?.setTestDb(testDb)
const users: Record<string, string> = {},
  projects: Array<string> = []
const measures: Array<Record<string, string | number>> = []
const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
const date = (offset: number) =>
  new Date(Date.parse(day) + offset * 86400000).toISOString().slice(0, 10)
const serialize = (value: unknown) => JSON.parse(JSON.stringify(value))
const projectSummary = (
  p:
    | Awaited<ReturnType<typeof service.projectDetail>>
    | Awaited<ReturnType<typeof service.dashboard>>['projects'][number],
) => {
  const output = { ...p } as Record<string, unknown>
  for (const key of ['history', 'events', 'profile', 'createdBy', 'plan'])
    delete output[key]
  output.imports = p.imports
    .map(({ id, versionNo, rowCount, sourceName }) => ({
      id,
      versionNo,
      rowCount,
      sourceName,
    }))
    .sort((a, b) => b.versionNo - a.versionNo)
  output.items = [...p.items].sort((a, b) => a.id.localeCompare(b.id))
  return serialize(output)
}
const normalize = (data: Awaited<ReturnType<typeof service.dashboard>>) => ({
  metrics: data.metrics,
  projects: [...data.projects]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(projectSummary),
  todayActivity: {
    day: data.todayActivity.day,
    newOverdue: [...data.todayActivity.newOverdue].sort((a, b) =>
      a.itemId.localeCompare(b.itemId),
    ),
    promiseChanges: [...data.todayActivity.promiseChanges].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    completions: [...data.todayActivity.completions].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  },
})
const measured = async (label: string, api: typeof service, userId: string) => {
  queryCount = 0
  const start = performance.now()
  const result = await api.dashboard(userId)
  const measure = {
    label,
    projects: result.projects.length,
    selectQueries: queryCount,
    elapsedMs: Math.round(performance.now() - start),
    responseBytes: Buffer.byteLength(JSON.stringify(result)),
  }
  measures.push(measure)
  console.log(JSON.stringify(measure))
  return { result, measure }
}
try {
  await client`select 1`
  for (const role of [
    'technical',
    'manufacturing',
    'procurement',
    'supervisor',
    'admin',
    'otherTech',
    'empty',
  ]) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@dashboard-load.test.invalid'},${role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${['otherTech', 'empty'].includes(role) ? 'technical' : role})`
  }
  for (const suffix of ['A', 'B', 'C']) {
    const technical = suffix === 'C' ? users.otherTech! : users.technical!
    const p = await service.createProject(technical, {
      name: '聚合验证-' + crypto.randomUUID().slice(0, 8) + suffix,
      motorModel: 'LOAD-' + suffix,
      technicalOwnerId: technical,
      manufacturingOwnerId: users.manufacturing,
      requiredKitDate: date(10),
      prototypeRequiredDate: date(20),
    })
    projects.push(p.id)
  }
  const [a, b, c] = projects as [string, string, string]
  const purchase = await service.addExternal(users.technical!, a, {
    name: '汇总保留改期的采购件',
    ownerId: users.procurement,
    qty: '3.000001',
    unit: '件',
    requiredDate: date(10),
    affectsKit: true,
  })
  let version = purchase.version
  for (const committedDate of [date(6), date(8), date(12)]) {
    const updated = await service.updatePromise(
      users.procurement!,
      purchase.id,
      { expectedVersion: version, committedDate, reason: '测试交期更新' },
    )
    version = updated.version
  }
  await client`update npi_promise_history set changed_at=${date(-1) + 'T09:00:00+08:00'} where object_id=${purchase.id} and new_committed_date<>${date(12)}`
  await service.updatePromise(users.procurement!, purchase.id, {
    expectedVersion: version,
    committedDate: date(12),
    supplier: '已补充供应商',
    remark: '补充详情不会增加改期次数',
  })
  await service.addExternal(users.technical!, a, {
    name: '仍待回复的关键件',
    ownerId: users.procurement,
    qty: '1',
    requiredDate: date(10),
    affectsKit: true,
  })
  const plan = (await service.projectDetail(users.technical!, a)).plan!
  await service.manufacturingPlan(users.manufacturing!, a, {
    expectedVersion: plan.version,
    processCommitted: date(5),
    toolingCommitted: date(5),
    kitCommitted: date(10),
    assemblyCommitted: date(20),
  })
  // Synthetic completed fixture; stage transition rules are covered by the HTTP suite.
  await client`update npi_tracking_items set actual_complete_date=${day} where program_id=${b}`
  await client`update npi_projects set current_npi_stage='completed' where program_id=${b}`
  const overdue = await service.addExternal(users.otherTech!, c, {
    name: '其他技术项目的新逾期件',
    ownerId: users.procurement,
    qty: '1',
    requiredDate: date(-1),
    affectsKit: true,
  })
  await service.updatePromise(users.procurement!, overdue.id, {
    expectedVersion: overdue.version,
    committedDate: date(-1),
  })
  await client`update npi_tracking_items set created_at=${date(-3) + 'T09:00:00+08:00'} where id=${overdue.id}`
  await client`update npi_promise_history set changed_at=${date(-3) + 'T09:00:00+08:00'} where object_id=${overdue.id}`
  await client`insert into npi_events(program_id,object_id,action,detail,actor_id) select ${a},${purchase.id},'LOAD_TEST_NOISE',jsonb_build_object('note',repeat('保留详情',400)),${users.technical!} from generate_series(1,120)`
  const own = await measured('optimized-technical', service, users.technical!)
  assert.deepEqual(own.result.projects.map((p) => p.id).sort(), [a, b].sort())
  assert.equal(own.result.metrics.completed, 1)
  assert.equal(own.result.metrics.onTime, 1)
  const risk = own.result.projects.find((p) => p.id === a)!
  assert.equal(risk.riskStatus, 'risk')
  assert.equal(risk.kit.predictedKitDate, date(12))
  assert.equal(risk.kit.predictionComplete, false)
  assert.ok(risk.kit.alerts.some((r) => r.code === 'DETAIL_VS_COMMIT_CONFLICT'))
  assert.equal(risk.items.find((i) => i.id === purchase.id)!.changeCount, 2)
  assert.equal(
    risk.items.find((i) => i.id === purchase.id)!.firstCommittedDate,
    date(6),
  )
  assert.equal(risk.items.find((i) => i.id === purchase.id)!.qty, '3.000001')
  assert.equal(
    own.result.todayActivity.promiseChanges.filter(
      (r) => r.itemId === purchase.id,
    ).length,
    1,
  )
  assert.equal(
    own.result.todayActivity.newOverdue.some((r) => r.itemId === overdue.id),
    false,
  )
  for (const p of own.result.projects) {
    for (const field of ['history', 'events', 'profile', 'plan'])
      assert.equal(field in p, false)
    const detail = await service.projectDetail(users.technical!, p.id)
    assert.deepEqual(projectSummary(detail), projectSummary(p))
    if (p.id === a) {
      assert.equal(
        detail.history.filter((h) => h.objectId === purchase.id).length,
        3,
      )
      assert.equal(detail.events.length, 100)
      assert.ok(detail.plan)
      assert.ok(detail.profile)
    }
    if (baseline)
      assert.deepEqual(
        serialize(detail),
        serialize(await baseline.projectDetail(users.technical!, p.id)),
      )
  }
  const scoped = await measured('optimized-empty', service, users.empty!)
  assert.equal(scoped.result.projects.length, 0)
  assert.deepEqual(scoped.result.todayActivity, {
    day,
    newOverdue: [],
    promiseChanges: [],
    completions: [],
  })
  await assert.rejects(() => service.dashboard(users.procurement!), {
    code: 'NPI_PERMISSION_DENIED',
  })
  const other = await service.dashboard(users.otherTech!)
  assert.deepEqual(
    other.projects.map((p) => p.id),
    [c],
  )
  assert.equal(other.projects[0]!.riskStatus, 'overdue')
  assert.ok(other.todayActivity.newOverdue.some((r) => r.itemId === overdue.id))
  const full = await measured(
    'optimized-supervisor',
    service,
    users.supervisor!,
  )
  assert.ok(
    full.measure.selectQueries <= 12,
    'Dashboard SELECT count must remain bounded as project count grows',
  )
  assert.equal(full.measure.selectQueries, own.measure.selectQueries)
  const admin = await service.dashboard(users.admin!)
  assert.deepEqual(
    serialize(normalize(admin)),
    serialize(normalize(full.result)),
  )
  const manufacturing = await service.dashboard(users.manufacturing!)
  assert.deepEqual(
    manufacturing.projects.map((p) => p.id).sort(),
    projects.slice().sort(),
  )
  if (baseline) {
    const oldOwn = await measured(
      'baseline-technical',
      baseline,
      users.technical!,
    )
    assert.deepEqual(
      serialize(normalize(oldOwn.result)),
      serialize(normalize(own.result)),
    )
    const oldFull = await measured(
      'baseline-supervisor',
      baseline,
      users.supervisor!,
    )
    assert.deepEqual(
      serialize(normalize(oldFull.result)),
      serialize(normalize(full.result)),
    )
    assert.ok(
      full.measure.responseBytes < oldFull.measure.responseBytes * 0.8,
      'Remove unused detail payload from aggregate response',
    )
    assert.ok(
      full.measure.selectQueries < oldFull.measure.selectQueries,
      'Avoid per-project query fan-out',
    )
  }
  fs.writeFileSync(
    '/tmp/npi-dashboard-load-result.json',
    JSON.stringify(
      {
        passed: true,
        baselineCompared: !!baseline,
        sharedProjectSummary: true,
        rolesChecked: [
          'technical',
          'manufacturing',
          'procurement',
          'supervisor',
          'admin',
          'otherTechnical',
          'emptyTechnical',
        ],
        allTimeChangeCounts: true,
        todayHistoryScoped: true,
        detailHistoryPreserved: true,
        exactQuantityPreserved: true,
        measures,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: bounded dashboard queries, scoped visibility, risk/kit/metrics, all-time counts versus today activity, exact quantities and intact project detail; baseline parity when provided.',
  )
} finally {
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
  database.resetDb()
  baselineDatabase?.resetDb()
  await client.end({ timeout: 5 })
  await defaultClient.end({ timeout: 5 })
  await database.migrationClient.end({ timeout: 5 })
  if (baselineDefaultClient && baselineDefaultClient !== defaultClient)
    await baselineDefaultClient.end({ timeout: 5 })
  if (baselineDatabase && baselineDatabase !== database)
    await baselineDatabase.migrationClient.end({ timeout: 5 })
}
