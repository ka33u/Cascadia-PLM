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
const log = fs.openSync('/tmp/npi-dashboard-browsing-browser-server.log', 'w')
const projects: Array<string> = []
const errors: Array<string> = []
try {
  const marker = `首页浏览-${crypto.randomUUID().slice(0, 8)}`
  for (const role of ['technical', 'manufacturing']) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@dashboard-browsing.test.invalid'},${role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role})`
  }
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const day = (offset: number) =>
    new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10)
  for (let i = 0; i < 80; i++) {
    const kind = i < 27 ? '逾期' : i < 53 ? '风险' : i < 79 ? '正常' : '待回复'
    const p = await service.createProject(users.technical!, {
      name: marker + kind + String(i).padStart(3, '0'),
      motorModel: 'BROWSE-' + i,
      technicalOwnerId: users.technical,
      manufacturingOwnerId: users.manufacturing,
      requiredKitDate: day(kind === '风险' ? 1 : 7),
      prototypeRequiredDate: day(14),
    })
    projects.push(p.id)
    if (kind !== '待回复') {
      const committed = day(kind === '逾期' ? -2 : 3)
      await client`update npi_tracking_items set first_committed_date=${committed}, current_committed_date=${committed} where program_id=${p.id}`
    }
  }
  const expected = await service.dashboard(users.technical!)
  assert.equal(expected.projects.length, 80)
  const expectedWarnings = expected.projects.filter((p) =>
    ['overdue', 'risk'].includes(p.riskStatus),
  )
  const expectedTodos = expected.projects.flatMap((p) =>
    p.items
      .filter(
        (i) =>
          !i.actualCompleteDate &&
          (i.trackingEnabled || i.affectsKit) &&
          ['overdue', 'pending_reply'].includes(i.status),
      )
      .map((i) => ({ ...i, projectId: p.id })),
  )
  assert.equal(expectedWarnings.length, 53)
  assert.equal(
    expected.projects.filter((p) => p.riskStatus === 'normal').length,
    26,
  )
  const lateTodo = expectedTodos.find((i) => i.projectId === projects[26])!
  assert.ok(lateTodo)
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
  const session = await SessionManager.createSession(users.technical!)
  sessions.push(session.session.id)
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  context.setDefaultTimeout(20000)
  await context.addCookies([
    { name: 'session', value: session.sessionToken, url: base },
  ])
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  const writes: Array<string> = []
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/npi') && r.method() !== 'GET')
      writes.push(r.url())
  })
  await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle')
  const main = page.getByRole('region', { name: '项目进度列表' })
  const primary = main.getByRole('table', { name: '项目结果' })
  const mainPager = page.getByRole('navigation', { name: '项目概览顶部翻页' })
  await expect(primary.locator('[data-project-id]')).toHaveCount(25)
  await mainPager.getByRole('button', { name: '下一页', exact: true }).click()
  const primaryIds = await primary
    .locator('[data-project-id]')
    .evaluateAll((es) => es.map((e) => e.getAttribute('data-project-id')))
  await main.getByRole('button', { name: /正常项目（26）/ }).click()
  const normal = main.getByRole('table', { name: '正常项目' })
  await page
    .getByRole('navigation', { name: '正常项目顶部翻页' })
    .getByRole('button', { name: '末页', exact: true })
    .click()
  await expect(normal.locator('[data-project-id]')).toHaveCount(1)
  assert.deepEqual(
    await primary
      .locator('[data-project-id]')
      .evaluateAll((es) => es.map((e) => e.getAttribute('data-project-id'))),
    primaryIds,
  )
  await page.getByLabel('搜索项目').fill(marker + '待回复079')
  await expect(primary.locator('[data-project-id]')).toHaveCount(1)
  await expect(page.getByRole('group', { name: '项目指标' })).toContainText(
    '80',
  )
  await page.getByLabel('搜索项目').fill('')
  await expect(mainPager).toContainText('第1/3页')
  const todos = page.getByRole('region', { name: '今日待办' }),
    warnings = page.getByRole('region', { name: '风险预警' })
  await expect(todos.locator('[data-brief-id]')).toHaveCount(5)
  await expect(warnings.locator('[data-brief-id]')).toHaveCount(5)
  await todos.getByRole('button', { name: '查看全部待办', exact: true }).click()
  const todoPager = todos.getByRole('navigation', { name: '今日待办顶部翻页' })
  const foundTodos: Array<string> = []
  for (let i = 0; i < Math.ceil(expectedTodos.length / 25); i++) {
    foundTodos.push(
      ...(await todos
        .locator('[data-brief-id]')
        .evaluateAll((es) => es.map((e) => e.getAttribute('data-brief-id')!))),
    )
    if (i < Math.ceil(expectedTodos.length / 25) - 1)
      await todoPager
        .getByRole('button', { name: '下一页', exact: true })
        .click()
  }
  assert.deepEqual(
    [...foundTodos].sort(),
    expectedTodos.map((i) => i.id).sort(),
  )
  await todos.getByLabel('今日待办搜索').fill(marker + '逾期026')
  await todos.getByLabel('今日待办状态').selectOption('overdue')
  await expect(todos.locator('[data-brief-id]')).toHaveCount(4)
  await todos.getByLabel('今日待办搜索').fill('')
  await todoPager.getByRole('button', { name: '末页', exact: true }).click()
  const todoPageText = await todoPager.innerText()
  await warnings
    .getByRole('button', { name: '查看全部预警', exact: true })
    .click()
  const warningPager = warnings.getByRole('navigation', {
    name: '风险预警顶部翻页',
  })
  const foundWarnings: Array<string> = []
  for (let i = 0; i < 3; i++) {
    foundWarnings.push(
      ...(await warnings
        .locator('[data-brief-id]')
        .evaluateAll((es) => es.map((e) => e.getAttribute('data-brief-id')!))),
    )
    if (i < 2)
      await warningPager
        .getByRole('button', { name: '下一页', exact: true })
        .click()
  }
  assert.deepEqual(
    [...foundWarnings].sort(),
    expectedWarnings.map((p) => p.id).sort(),
  )
  assert.equal(await todoPager.innerText(), todoPageText)
  await warnings.getByLabel('风险预警搜索').fill(marker + '逾期026')
  await warnings.getByLabel('风险预警状态').selectOption('overdue')
  await expect(warnings.locator('[data-brief-id]')).toHaveCount(1)
  await warnings.getByLabel('风险预警状态').selectOption('risk')
  await expect(warnings).toContainText('没有符合条件的记录')
  await warnings.getByLabel('风险预警状态').selectOption('overdue')
  await todos.getByLabel('今日待办搜索').fill(marker + '逾期026')
  await page
    .locator('.npi-dashboard-briefs')
    .screenshot({ path: '/tmp/npi-dashboard-browsing-desktop.png' })
  // Main KPI drilldown must not reset the independently filtered briefs.
  await page
    .getByRole('group', { name: '项目指标' })
    .getByRole('button', { name: /逾期项目/ })
    .click()
  await expect(todos.getByLabel('今日待办搜索')).toHaveValue(marker + '逾期026')
  await expect(warnings.locator('[data-brief-id]')).toHaveCount(1)
  await page.setViewportSize({ width: 390, height: 844 })
  await todos.getByLabel('今日待办搜索').fill('')
  await expect(todos.locator('[data-brief-id]')).toHaveCount(25)
  await todoPager.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(todoPager).toContainText('第2/5页')
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await todos.evaluate((e) => e.scrollIntoView({ block: 'start' }))
  await page.screenshot({
    path: '/tmp/npi-dashboard-browsing-mobile-paging.png',
  })
  await todos.getByLabel('今日待办搜索').fill(marker + '逾期026')
  await expect(todos.locator('[data-brief-id]')).toHaveCount(4)
  await todos.screenshot({ path: '/tmp/npi-dashboard-browsing-mobile.png' })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  )
  assert.equal(overflow, false)
  await todos.locator(`[data-brief-id="${lateTodo.id}"]`).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    marker + '逾期026',
  )
  await expect(
    page.getByRole('tab', { name: '制造准备', exact: true }),
  ).toHaveAttribute('data-state', 'active')
  const nav = page.getByRole('navigation', { name: '主导航' })
  await nav.getByRole('button', { name: '首页', exact: true }).click()
  await warnings
    .getByRole('button', { name: '查看全部预警', exact: true })
    .click()
  await warnings.getByLabel('风险预警搜索').fill(marker + '逾期026')
  await warnings.locator('[data-brief-id]').click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    marker + '逾期026',
  )
  await expect(
    page.getByRole('tab', { name: '概览', exact: true }),
  ).toHaveAttribute('data-state', 'active')
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-dashboard-browsing-browser-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        projects: 80,
        normalProjects: 26,
        todosTraversed: foundTodos.length,
        warningsTraversed: foundWarnings.length,
        independentPaging: true,
        allRecordSearch: true,
        overdueOnlyIncluded: true,
        taskNavigation: true,
        projectNavigation: true,
        mobileOverflow: overflow,
        mobilePaging: true,
        businessWrites: writes,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: dashboard project/normal pagination, complete todo/warning browsing, independent search and pages, overdue inclusion, desktop/mobile and actual task/project navigation.',
  )
} finally {
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
