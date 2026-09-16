// SPDX-License-Identifier: AGPL-3.0-or-later
// Focused supervisor planning UI; removes only its own UUID fixtures in finally.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import postgres from 'postgres'
import type { Browser } from '@playwright/test'

const url = process.env.TEST_DATABASE_URL
if (!url) throw Error('Explicit TEST_DATABASE_URL required')
const target = new URL(url)
if (
  !target.pathname.endsWith('_test') ||
  !['localhost', '127.0.0.1', '[::1]', '::1'].includes(target.hostname) ||
  target.searchParams.has('host')
)
  throw Error('Only a local _test database is allowed')
process.env.DATABASE_URL = url
const { SessionManager } = await import('../packages/core/src/lib/auth/session')
const service = await import('../packages/core/src/lib/npi/service')
const database = await import('../packages/core/src/lib/db')
const client = postgres(url, { max: 1 })
const appRoot = process.env.NPI_BROWSER_APP_ROOT || process.cwd()
const resultPath = '/tmp/npi-supervisor-plan-browser-result.json'
const fixturePath = '/tmp/npi-supervisor-plan-browser-fixtures.json'
if (
  fs.existsSync(fixturePath) &&
  !JSON.parse(fs.readFileSync(fixturePath, 'utf8')).cleaned
)
  throw Error('Prior scoped fixtures require cleanup')
fs.rmSync(resultPath, { force: true })
const users = Object.fromEntries(
  [
    'technical',
    'nextTechnical',
    'manufacturing',
    'procurement',
    'nextBuyer',
    'supervisor',
  ].map((role) => [role, crypto.randomUUID()]),
)
const userIds = Object.values(users)
let browser: Browser | undefined, server: ReturnType<typeof spawn> | undefined
let cleaned = false,
  passed = false
const errors: Array<string> = [],
  checks: Array<string> = []
const record = (extra: Record<string, unknown> = {}) =>
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({ userIds, cleaned, ...extra }, null, 2),
  )
record()
const probe = createServer()
await new Promise<void>((resolve, reject) => {
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', resolve)
})
const address = probe.address()
assert.ok(address && typeof address !== 'string')
const port = address.port,
  base = `http://127.0.0.1:${port}`
await new Promise<void>((resolve, reject) =>
  probe.close((e) => (e ? reject(e) : resolve())),
)
const log = fs.openSync('/tmp/npi-supervisor-plan-browser-server.log', 'w')
try {
  for (const [name, id] of Object.entries(users)) {
    const role =
      name === 'nextTechnical'
        ? 'technical'
        : name === 'nextBuyer'
          ? 'procurement'
          : name
    await client`insert into users(id,email,name,active) values(${id},${id + '@supervisor-plan.invalid'},${name},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role})`
  }
  const marker = `主管计划专项-${crypto.randomUUID().slice(0, 8)}`
  const project = await service.createProject(users.technical!, {
    code: 'SUP-' + crypto.randomUUID(),
    name: marker,
    motorModel: 'PLAN',
    technicalOwnerId: users.technical,
    manufacturingOwnerId: users.manufacturing,
    requiredKitDate: '2026-10-15',
    prototypeRequiredDate: '2026-10-20',
  })
  record({ projectId: project.id })
  const purchase = await service.addExternal(users.technical!, project.id, {
    name: '计划核查采购件',
    trackingType: 'purchase',
    ownerId: users.procurement,
    qty: '1',
    requiredDate: '2026-10-15',
    affectsKit: true,
  })
  await service.updatePromise(users.procurement!, purchase.id, {
    expectedVersion: purchase.version,
    committedDate: '2026-10-12',
    reason: '责任人首次承诺',
  })
  const completed = await service.addExternal(users.technical!, project.id, {
    name: '已完成核查件',
    trackingType: 'material',
    ownerId: users.manufacturing,
    qty: '1',
    requiredDate: '2026-10-15',
    affectsKit: true,
  })
  await service.completeItem(users.manufacturing!, completed.id, {
    expectedVersion: completed.version,
    actualCompleteDate: '2026-09-15',
  })
  const session = await SessionManager.createSession(users.supervisor!)
  server = spawn(
    process.execPath,
    [path.join(appRoot, '.output/cascadia/server/index.mjs')],
    {
      cwd: appRoot,
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        BASE_URL: base,
        APP: 'cascadia',
      },
    },
  )
  server.on('error', () => {})
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error('Test server exited')
    try {
      if (
        (
          await fetch(base + '/api/v1/npi/meta', {
            signal: AbortSignal.timeout(1000),
          })
        ).status === 401
      ) {
        ready = true
        break
      }
    } catch {
      /* startup */
    }
    await delay(200)
  }
  assert.ok(ready)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  context.setDefaultTimeout(30000)
  await context.addCookies([
    { name: 'session', value: session.sessionToken, url: base },
  ])
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
  const nav = page.getByRole('navigation', { name: '主导航' })
  await expect(nav.getByRole('button')).toHaveText([
    '首页',
    '新品项目',
    'BOM管理',
    '制造准备',
    '采购管理',
    '报表看板',
  ])
  const openProject = async () => {
    await nav.getByRole('button', { name: '新品项目', exact: true }).click()
    await page.getByLabel('模块项目搜索').fill(marker)
    await page.getByRole('button', { name: '项目详情 ↗', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: new RegExp(marker) }),
    ).toBeVisible()
  }
  await openProject()
  await expect(
    page.getByText(
      '主管可调整项目及物料计划，修改须说明原因。承诺回复与完成确认由责任人办理。',
    ),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '项目计划与交接', exact: true }),
  ).toBeVisible()
  await page.getByRole('tab', { name: '样机齐套', exact: true }).click()
  await page
    .getByRole('region', { name: '齐套物料清单' })
    .getByRole('button', { name: '全部跟踪', exact: true })
    .click()
  const row = page.locator(`[data-npi-item="${purchase.id}"]`)
  await expect(
    row.getByRole('button', { name: '调整计划', exact: true }),
  ).toBeVisible()
  await expect(
    row.getByRole('button', { name: /^(回复|改期|到货|完成|更正日期)$/ }),
  ).toHaveCount(0)
  await row.getByRole('button', { name: '调整计划', exact: true }).click()
  const plan = page.getByRole('dialog', { name: '调整物料计划', exact: true })
  await expect(plan.getByLabel('调整原因')).toHaveAttribute('required', '')
  await plan.getByLabel('回复责任人').selectOption(users.nextBuyer!)
  await plan.getByLabel('调整后的要求日期').fill('2026-10-16')
  await plan.getByLabel('调整原因').fill('主管统筹采购计划')
  await plan.getByRole('button', { name: '保存', exact: true }).click()
  await expect(plan).toHaveCount(0)
  await expect(row).toContainText('2026-10-16')
  await expect(row).toContainText('nextBuyer')
  await expect(row).toContainText('2026-10-12')
  await row.getByRole('button', { name: '计划核查采购件承诺历史' }).click()
  const history = page.getByRole('dialog')
  await expect(history).toContainText('首次承诺：2026-10-12')
  await expect(history.locator('.npi-history')).toHaveCount(1)
  await expect(history).toContainText('procurement')
  await page.keyboard.press('Escape')
  await expect(history).toHaveCount(0)
  await page.screenshot({ path: '/tmp/npi-supervisor-plan-desktop.png' })
  checks.push(
    'Desktop: six modules; material date/owner adjustment with required reason; original promise/author retained; no reply or completion buttons',
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', { name: '项目计划与交接', exact: true })
    .click()
  const edit = page.getByRole('dialog')
  await edit.getByLabel('要求齐套日期', { exact: true }).fill('2026-10-17')
  await edit.getByLabel('样机要求日期', { exact: true }).fill('2026-10-22')
  await edit
    .getByLabel('技术负责人', { exact: true })
    .selectOption(users.nextTechnical!)
  await edit
    .getByLabel('变更原因', { exact: true })
    .fill('主管协调项目日期及技术交接')
  await edit.getByRole('button', { name: '预览变更', exact: true }).click()
  await expect(
    edit.getByRole('region', { name: '项目变更预览' }),
  ).toContainText('2026-10-17')
  await expect(edit).toContainText('nextTechnical')
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await page.screenshot({ path: '/tmp/npi-supervisor-plan-mobile.png' })
  await edit.getByRole('button', { name: '确认变更', exact: true }).click()
  await expect(edit).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '项目计划与交接', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: new RegExp(marker) }),
  ).toBeVisible()
  const detail = await service.projectDetail(users.supervisor!, project.id)
  assert.equal(detail.technicalOwnerId, users.nextTechnical)
  assert.equal(detail.requiredKitDate, '2026-10-17')
  const material = detail.items.find((i) => i.id === purchase.id)!
  assert.equal(material.firstCommittedDate, '2026-10-12')
  assert.equal(material.currentCommittedDate, '2026-10-12')
  assert.equal(material.ownerId, users.nextBuyer)
  checks.push(
    'Mobile: preview, required reason and project dates/technical handoff persist; supervisor stays in project; no horizontal overflow',
  )

  // Exercise real HTTP denial even though the corresponding buttons are hidden.
  for (const [suffix, payload] of [
    [
      'promise',
      {
        expectedVersion: material.version,
        committedDate: '2026-10-18',
        reason: '越权核查',
      },
    ],
    [
      'complete',
      { expectedVersion: material.version, actualCompleteDate: '2026-09-15' },
    ],
  ] as const) {
    const denied = await context.request.post(
      base + `/api/v1/npi/tracking/${purchase.id}/${suffix}`,
      {
        headers: { origin: base, 'x-npi-actor': users.supervisor! },
        data: payload,
      },
    )
    assert.equal(denied.status(), 403)
  }
  const audits =
    await client`select actor_id, action, detail from npi_events where program_id=${project.id} and actor_id=${users.supervisor!}`
  assert.ok(audits.some((event) => event.action === 'PROJECT_CHANGED'))
  assert.ok(audits.some((event) => event.action === 'TRACKING_PLAN_ADJUSTED'))
  assert.ok(
    audits.some((event) =>
      JSON.stringify(event.detail).includes('主管统筹采购计划'),
    ),
  )
  assert.ok(
    audits.some((event) =>
      JSON.stringify(event.detail).includes('主管协调项目日期及技术交接'),
    ),
  )
  checks.push(
    'Real HTTP denies supervisor promise/completion; both changes retain supervisor actor and reason in audit',
  )

  const done = page.locator(`[data-npi-item="${completed.id}"]`)
  await expect(done).toBeVisible()
  await expect(
    done.getByRole('button', { name: /^(调整计划|更正日期)$/ }),
  ).toHaveCount(0)
  await page.getByRole('tab', { name: '制造准备', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '集中回复', exact: true }),
  ).toHaveCount(0)

  // A former manufacturing owner must lose reply UI when reassigned to supervisor.
  await client`update npi_user_roles set role='supervisor' where user_id=${users.manufacturing!}`
  const formerSession = await SessionManager.createSession(users.manufacturing!)
  const formerContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  })
  formerContext.setDefaultTimeout(30000)
  await formerContext.addCookies([
    { name: 'session', value: formerSession.sessionToken, url: base },
  ])
  const former = await formerContext.newPage()
  former.on('pageerror', (e) => errors.push(e.message))
  await former.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
  await former
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '制造准备', exact: true })
    .click()
  const tasks = former.getByRole('region', { name: '制造四节点任务' })
  await tasks.getByLabel('业务任务搜索').fill(marker)
  await expect(tasks.locator('tbody tr')).toHaveCount(4)
  await expect(
    tasks.getByRole('button', { name: /集中回复|确认完成/ }),
  ).toHaveCount(0)
  await tasks
    .getByRole('button', { name: '查看制造准备 ↗', exact: true })
    .first()
    .click()
  await expect(
    former.getByRole('button', {
      name: /^(集中回复|集中确认完成|添加异常件)$/,
    }),
  ).toHaveCount(0)
  await expect(
    former.getByRole('button', { name: '调整计划', exact: true }),
  ).toHaveCount(4)
  await former.getByRole('tab', { name: '样机齐套', exact: true }).click()
  await expect(
    former.getByRole('button', { name: '保存制造回复', exact: true }),
  ).toHaveCount(0)
  await formerContext.close()
  checks.push(
    'Former manufacturing owner changed to supervisor loses reply/completion/exception entry in task and project views while retaining plan adjustment',
  )
  await client`update npi_projects set current_npi_stage='completed' where program_id=${project.id}`
  await openProject()
  await expect(
    page.getByRole('button', { name: '项目计划与交接', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('tab', { name: '样机齐套', exact: true }).click()
  await page
    .getByRole('region', { name: '齐套物料清单' })
    .getByRole('button', { name: '全部跟踪', exact: true })
    .click()
  await expect(
    row.getByRole('button', { name: '调整计划', exact: true }),
  ).toHaveCount(0)
  checks.push(
    'Completed material has no correction/plan buttons; completed project has no planning entry',
  )
  assert.deepEqual(errors, [])
  passed = true
} finally {
  if (browser) await browser.close()
  if (server) {
    const child = server,
      running = () => child.exitCode === null && child.signalCode === null
    if (running()) child.kill('SIGTERM')
    for (let i = 0; i < 25 && running(); i++) await delay(200)
    if (running()) {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  }
  fs.closeSync(log)
  try {
    const own =
      await client`select id from programs where created_by in ${client(userIds)}`
    const projectIds = own.map((r) => String(r.id))
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
      await client`select (select count(*)::int from users where id in ${client(userIds)}) as users, (select count(*)::int from programs where created_by in ${client(userIds)}) as projects, (select count(*)::int from npi_events where actor_id in ${client(userIds)}) as events, (select count(*)::int from sessions where user_id in ${client(userIds)}) as sessions`
    )[0]!
    assert.ok(Object.values(residuals).every((v) => v === 0))
    cleaned = true
    record({ projectIds, residuals })
    fs.writeFileSync(
      resultPath,
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          passed,
          checks,
          cleaned,
          residuals,
          pageErrors: errors,
          applicationRoot: appRoot,
          scope:
            'Supervisor plan-only UI and matching endpoint denials. No full API/browser suite; own synthetic fixtures deleted.',
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
console.log(
  'PASS: supervisor planning desktop/mobile UI and HTTP denials; zero fixture rows remain.',
)
