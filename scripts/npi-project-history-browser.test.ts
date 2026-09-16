// SPDX-License-Identifier: AGPL-3.0-or-later
import 'dotenv/config'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import postgres from 'postgres'
import type { Browser } from '@playwright/test'

if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw new Error('Explicit isolated _test database required')
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const { SessionManager } = await import('../packages/core/src/lib/auth/session')
const service = await import('../packages/core/src/lib/npi/service')
const database = await import('../packages/core/src/lib/db')
const client = postgres(process.env.TEST_DATABASE_URL, { max: 1 })
const users: Record<string, string> = {}
const sessions: Array<string> = []
let browser: Browser | undefined
let server: ReturnType<typeof spawn> | undefined
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
  probe.close((error) => (error ? reject(error) : resolve())),
)
const log = fs.openSync('/tmp/npi-project-history-browser-server.log', 'w')
const projects: Array<string> = []
const releases: Array<() => void> = []
const errors: Array<string> = []
try {
  const marker = `历史查看-${crypto.randomUUID().slice(0, 8)}`
  for (const role of [
    'technical',
    'manufacturing',
    'supervisor',
    'admin',
    'otherManufacturing',
  ]) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@project-history.test.invalid'},${role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role === 'otherManufacturing' ? 'manufacturing' : role})`
  }
  for (const suffix of ['A', 'B']) {
    const project = await service.createProject(users.technical!, {
      name: marker + suffix,
      motorModel: 'QUICK-' + suffix,
      technicalOwnerId: users.technical,
      manufacturingOwnerId: users.manufacturing,
      requiredKitDate: '2026-10-15',
      prototypeRequiredDate: '2026-10-20',
    })
    projects.push(project.id)
  }
  const firstId = projects[0]!,
    secondId = projects[1]!
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const day = (offset: number) =>
    new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10)
  const initial = await service.projectDetail(users.manufacturing!, firstId)
  const node = initial.items.find((i) => i.trackingType === 'process')!
  let version = node.version
  for (let i = 0; i < 53; i++) {
    const item = await service.updatePromise(users.manufacturing!, node.id, {
      expectedVersion: version,
      committedDate: day(10 + (i % 2)),
      reason: i === 7 ? '稀有承诺原因' : '历史承诺验证' + i,
    })
    version = item.version
  }
  await client`with ordered as (select id, row_number() over(order by changed_at,id) as position from npi_promise_history where object_id=${node.id}) update npi_promise_history h set changed_at=${today + 'T12:00:00.123000+08:00'}::timestamptz+ordered.position*interval '1 microsecond' from ordered where h.id=ordered.id`
  await client`insert into npi_events(program_id,object_id,action,detail,actor_id,created_at) select ${firstId},${node.id},case when g=133 then 'COMPLETION_CORRECTED' when g%2=0 then 'COMPLETED' else 'DETAILS_UPDATED' end,jsonb_build_object('reason','历史验收记录'||lpad(g::text,3,'0'),'actualCompleteDate',${day(-3)}::text,'before',jsonb_build_object('actualCompleteDate',${day(-5)}::text),'after',jsonb_build_object('actualCompleteDate',${day(-4)}::text),'actorName','历史操作者','itemName','工艺准备','remark',case when g=132 then repeat('LONGREMARK',24) else '' end),${users.manufacturing!},${day(-2) + 'T12:00:00.000000+08:00'}::timestamptz+g*interval '1 microsecond' from generate_series(1,133) g`
  await client`insert into npi_events(program_id,object_id,action,detail,actor_id) values(${secondId},${secondId},'PROJECT_CREATED','{"reason":"B项目专属动态"}',${users.technical!})`
  const expectedIds = (
    await client`select id from npi_events where program_id=${firstId} and detail->>'reason' like '历史验收记录%' order by created_at desc,id desc`
  ).map((r) => r.id as string)

  const appRoot = process.env.NPI_BROWSER_APP_ROOT || process.cwd()
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
  for (let i = 0; i < 80; i++) {
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
  const session = await SessionManager.createSession(users.supervisor!)
  sessions.push(session.session.id)
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  })
  context.setDefaultTimeout(20000)
  await context.addCookies([
    { name: 'session', value: session.sessionToken, url: base },
  ])
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  const nav = page.getByRole('navigation', { name: '主导航' })
  const writes: Array<string> = []
  let eventReads = 0
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/npi') && r.method() !== 'GET')
      writes.push(r.url())
    if (r.url().includes('/events?')) eventReads++
  })
  const openProject = async (suffix: string) => {
    await nav.getByRole('button', { name: '新品项目', exact: true }).click()
    await page.getByLabel('模块项目搜索').fill(marker + suffix)
    await page.getByRole('button', { name: '项目详情 ↗', exact: true }).click()
  }
  await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
  await openProject('A')
  // Keep the failure active through initial effect replays in development StrictMode.
  // Restore the endpoint only after the user-visible error is verified.
  const failurePattern = `**/api/v1/npi/projects/${firstId}/events?*`
  let failedEventReads = 0
  await page.route(failurePattern, (route) => {
    failedEventReads++
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '专项模拟历史读取失败' }),
    })
  })
  await page.getByRole('tab', { name: '承诺与动态', exact: true }).click()
  const promises = page.getByRole('region', { name: '项目承诺历史' }),
    events = page.getByRole('region', { name: '项目全部动态' })
  const promisePager = promises.getByRole('navigation', {
      name: '承诺历史顶部翻页',
    }),
    eventPager = events.getByRole('navigation', { name: '项目动态顶部翻页' })
  await expect(events.getByRole('alert')).toContainText('专项模拟历史读取失败')
  await expect(events.locator('[data-event-id]')).toHaveCount(0)
  assert.ok(failedEventReads > 0)
  await page.unroute(failurePattern)
  await events.getByRole('button', { name: '重试读取动态' }).click()
  await expect(events.locator('[data-event-id]')).toHaveCount(25)
  await expect(promises).toContainText('项目共 53 条')
  await expect(promises.locator('[data-promise-id]').first()).toContainText(
    '历史承诺验证52',
  )
  await promisePager.getByRole('button', { name: '末页', exact: true }).click()
  await expect(promises.locator('[data-promise-id]')).toHaveCount(3)
  const readsBeforePromiseFilter = eventReads
  await promises.getByLabel('承诺历史搜索').fill('稀有承诺原因')
  await expect(promises.locator('[data-promise-id]')).toHaveCount(1)
  await promises.getByLabel('承诺历史搜索').fill('')
  await promises.getByLabel('承诺记录类型').selectOption('first')
  await expect(promises.locator('[data-promise-id]')).toHaveCount(1)
  await expect(promises.locator('[data-promise-id]')).toContainText('首次回复')
  await promises.getByLabel('承诺记录类型').selectOption('changes')
  await expect(promises).toContainText('符合条件 52 条')
  await promises.getByLabel('承诺记录类型').selectOption('all')
  await promises.getByLabel('承诺时间顺序').selectOption('oldest')
  await expect(promises.locator('[data-promise-id]').first()).toContainText(
    '首次回复',
  )
  assert.equal(eventReads, readsBeforePromiseFilter)
  await page
    .getByRole('navigation', { name: '历史区域跳转' })
    .getByRole('button', { name: '项目动态', exact: true })
    .click()
  await expect(
    events.getByRole('heading', { name: '项目动态', exact: true }),
  ).toBeInViewport()
  const apply = async (q: string, category = 'all', from = '', to = '') => {
    await events.getByLabel('项目动态搜索').fill(q)
    await events.getByLabel('项目动态类型').selectOption(category)
    await events.getByLabel('动态开始日期').fill(from)
    await events.getByLabel('动态结束日期').fill(to)
    await events.getByRole('button', { name: '查询动态', exact: true }).click()
  }
  await apply('历史验收记录', 'all', day(-2), day(-2))
  await expect(events.locator('[data-event-id]')).toHaveCount(25)
  const found: Array<string> = []
  for (let i = 0; i < 6; i++) {
    await expect(eventPager).toContainText(`第${i + 1}页`)
    await expect(events.locator('[data-event-id]')).toHaveCount(
      i === 5 ? 8 : 25,
    )
    found.push(
      ...(await events
        .locator('[data-event-id]')
        .evaluateAll((rows) =>
          rows.map((r) => r.getAttribute('data-event-id')!),
        )),
    )
    if (i < 5)
      await eventPager
        .getByRole('button', { name: '更早记录', exact: true })
        .click()
  }
  assert.deepEqual(found, expectedIds)
  await expect(
    eventPager.getByRole('button', { name: '更早记录', exact: true }),
  ).toBeDisabled()
  await eventPager.getByRole('button', { name: '上一页', exact: true }).click()
  await expect(eventPager).toContainText('第5页')
  await expect(events.locator('[data-event-id]')).toHaveCount(25)
  await apply('历史验收记录133', 'completion', day(-2), day(-2))
  await expect(events.locator('[data-event-id]')).toHaveCount(1)
  await expect(events.locator('[data-event-id]')).toContainText(
    '更正实际完成日期',
  )
  await expect(events.locator('[data-event-id]')).toContainText(
    `${day(-5)} → ${day(-4)}`,
  )
  await expect(events.locator('[data-event-id]')).toContainText('manufacturing')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await events.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/npi-project-history-desktop.png' })
  await apply('历史验收记录132', 'completion')
  await expect(events.locator('[data-event-id]')).toHaveCount(1)
  await expect(events.locator('[data-event-id]')).toContainText(
    '实际完成：' + day(-3),
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await events.scrollIntoViewIfNeeded()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await events.screenshot({ path: '/tmp/npi-project-history-mobile.png' })
  // A late filtered response must never replace a newer filter's result.
  let release!: () => void, start!: () => void
  const held = new Promise<void>((r) => {
      release = r
      releases.push(r)
    }),
    started = new Promise<void>((r) => {
      start = r
    })
  const pattern = `**/api/v1/npi/projects/${firstId}/events?*`
  await page.route(pattern, async (route) => {
    if (
      new URL(route.request().url()).searchParams.get('q') !== '历史验收记录001'
    ) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    start()
    await held
    await route.fulfill({ response })
  })
  await apply('历史验收记录001')
  await started
  await apply('没有这条动态')
  await expect(events).toContainText('没有符合条件的动态')
  const late = page.waitForResponse(
    (r) => new URL(r.url()).searchParams.get('q') === '历史验收记录001',
  )
  release()
  await (await late).finished()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(events.locator('[data-event-id]')).toHaveCount(0)
  await page.unroute(pattern)
  // Switching projects while an event request is pending isolates the new timeline.
  let releaseProject!: () => void, startProject!: () => void
  const heldProject = new Promise<void>((r) => {
      releaseProject = r
      releases.push(r)
    }),
    startedProject = new Promise<void>((r) => {
      startProject = r
    })
  await page.route(
    pattern,
    async (route) => {
      const response = await route.fetch()
      startProject()
      await heldProject
      await route.fulfill({ response })
    },
    { times: 1 },
  )
  await apply('历史验收记录')
  await startedProject
  await openProject('B')
  await page.getByRole('tab', { name: '承诺与动态', exact: true }).click()
  await expect(events).toContainText('B项目专属动态')
  const projectLate = page.waitForResponse((r) =>
    r.url().includes(`/projects/${firstId}/events?`),
  )
  releaseProject()
  await (await projectLate).finished()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(events).toContainText('B项目专属动态')
  await expect(events).not.toContainText('历史验收记录')
  await expect(promises).toContainText('暂无承诺记录')
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-project-history-browser-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        eventRecordsTraversed: found.length,
        eventPages: 6,
        promiseRecords: 53,
        promiseSearchAndType: true,
        promiseMicrosecondOrderPreserved: true,
        independentTimelines: true,
        allEventsBeyond100: true,
        previousPage: true,
        categoryAndDateFilters: true,
        readFailureRetry: true,
        failedEventReads,
        lateFilterIgnored: true,
        projectIsolation: true,
        actorAndCorrectionVisible: true,
        mobileOverflow: false,
        supervisorWrites: writes,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: full project event browsing beyond 100, promise search/paging, independent filters, actor/correction details, retry and stale-response isolation; desktop/mobile and supervisor read-only.',
  )
} finally {
  for (const release of releases) release()
  if (browser) await browser.close()
  if (server) {
    const child = server,
      running = () => child.exitCode === null && child.signalCode === null
    if (running()) child.kill('SIGTERM')
    for (let i = 0; i < 25 && running(); i++) await delay(200)
    if (running()) child.kill('SIGKILL')
  }
  fs.closeSync(log)
  for (const session of sessions) await SessionManager.deleteSession(session)
  await (database.db as unknown as { $client: postgres.Sql }).$client.end({
    timeout: 5,
  })
  await database.migrationClient.end({ timeout: 5 })
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
}
