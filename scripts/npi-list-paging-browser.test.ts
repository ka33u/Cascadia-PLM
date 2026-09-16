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
const log = fs.openSync('/tmp/npi-list-paging-browser-server.log', 'w')
const projects: Array<string> = []
const releases: Array<() => void> = []
const errors: Array<string> = []
try {
  const marker = `清单分页-${crypto.randomUUID().slice(0, 8)}`
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const date = (offset: number) =>
    new Date(Date.parse(day) + offset * 86400000).toISOString().slice(0, 10)
  for (const role of [
    'technical',
    'manufacturing',
    'procurement',
    'supervisor',
  ]) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@list-paging.test.invalid'},${role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role})`
  }
  for (const suffix of ['A', 'B']) {
    const project = await service.createProject(users.technical!, {
      name: marker + suffix,
      motorModel: 'PAGING-' + suffix,
      technicalOwnerId: users.technical,
      manufacturingOwnerId: users.manufacturing,
      requiredKitDate: date(20),
      prototypeRequiredDate: date(30),
    })
    projects.push(project.id)
  }
  const items: Array<Awaited<ReturnType<typeof service.addExternal>>> = []
  for (let n = 1; n <= 53; n++) {
    const item = await service.addExternal(
      users.technical!,
      projects[n <= 26 ? 0 : 1]!,
      {
        name: `${marker}-${String(n).padStart(2, '0')}`,
        qty: '1',
        unit: '件',
        requiredDate: date(20),
        ownerId: users.procurement,
        affectsKit: true,
      },
    )
    items.push(item)
    if (n === 53) continue
    let version = item.version
    for (const [index, committed] of [
      date(10),
      date(15),
      date(n % 2 ? 25 : 16),
    ].entries()) {
      const updated = await service.updatePromise(users.procurement!, item.id, {
        expectedVersion: version,
        committedDate: committed,
        reason: index ? `第${index}次调整` : undefined,
      })
      version = updated.version
    }
  }
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

  const pageFor = async (role: string, width: number, height: number) => {
    const session = await SessionManager.createSession(users[role]!)
    sessions.push(session.session.id)
    const context = await browser!.newContext({ viewport: { width, height } })
    context.setDefaultTimeout(15000)
    await context.addCookies([
      { name: 'session', value: session.sessionToken, url: base },
    ])
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
    return page
  }
  const purchase = await pageFor('procurement', 390, 844)
  const list = purchase.getByRole('region', { name: '我的采购件清单' })
  const nav = (name: string) =>
    purchase.getByRole('navigation', { name, exact: true })
  const top = nav('采购清单顶部翻页'),
    bottom = nav('采购清单分页')
  await expect(list.locator('tbody tr')).toHaveCount(25)
  await expect(top).toContainText('共53行')
  await expect(
    purchase.getByRole('button', { name: '全部未完成', exact: true }),
  ).toContainText('53')
  await bottom.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(top).toContainText('第2/3页')
  await expect(bottom).toContainText('第2/3页')
  await expect(list.locator('tbody tr')).toHaveCount(25)
  await top.getByRole('button', { name: '末页', exact: true }).click()
  await expect(list.locator('tbody tr')).toHaveCount(3)
  await expect(top).toContainText('显示51–53行')
  await purchase
    .getByLabel('搜索我的采购件', { exact: true })
    .fill(marker + '-01')
  await expect(list.locator('tbody tr')).toHaveCount(1)
  await expect(list).toContainText(marker + '-01')
  await expect(top).toHaveCount(0)
  await purchase.getByLabel('搜索我的采购件', { exact: true }).fill('')
  await expect(top).toContainText('第1/3页')
  await purchase.getByLabel('采购筛选').selectOption('risk')
  await expect(top).toContainText('共26行')
  await bottom.getByRole('button', { name: '末页', exact: true }).click()
  await expect(list.locator('tbody tr')).toHaveCount(1)
  await expect(top).toContainText('第2/2页')
  await purchase
    .getByRole('button', { name: '全部未完成', exact: true })
    .click()
  await expect(top).toContainText('共53行')
  await top.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(
    purchase.locator(`[data-npi-item="${items[52]!.id}"]`),
  ).toContainText(marker + '-53')
  await purchase
    .locator(`[data-npi-item="${items[52]!.id}"]`)
    .getByRole('button', { name: '回复', exact: true })
    .click()
  const reply = purchase.getByRole('dialog', {
    name: '采购日期回复',
    exact: true,
  })
  await reply.getByLabel('预计到货日期').fill(date(25))
  await reply.getByRole('button', { name: '保存回复', exact: true }).click()
  await expect(reply).toHaveCount(0)
  await expect(top).toContainText('第1/3页')
  await expect(
    purchase.getByRole('button', { name: '我的风险件', exact: true }),
  ).toContainText('27')
  await expect(
    purchase.getByRole('button', { name: '待我回复', exact: true }),
  ).toContainText('0')
  await expect(list.locator('tbody tr')).toHaveCount(25)
  await top.scrollIntoViewIfNeeded()
  await purchase.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await purchase.screenshot({
    path: '/tmp/npi-list-paging-purchase-mobile.png',
  })
  assert.equal(
    await purchase.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  // Supervisor report: two independently paged lists, filtered across all rows.
  const report = await pageFor('supervisor', 1440, 1000)
  const writes: Array<string> = []
  report.on('request', (r) => {
    if (r.url().includes('/api/v1/npi/') && r.method() !== 'GET')
      writes.push(r.method() + ' ' + new URL(r.url()).pathname)
  })
  await report
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '报表看板', exact: true })
    .click()
  await report.getByLabel('报表项目搜索').fill(marker)
  const changes = report.getByRole('region', { name: '今日变化', exact: true })
  const tasks = report.getByRole('region', {
    name: '承诺改期任务',
    exact: true,
  })
  await changes
    .getByRole('button', { name: '承诺变更 104', exact: true })
    .click()
  const changesTop = changes.getByRole('navigation', {
    name: '今日变化顶部翻页',
    exact: true,
  })
  const tasksTop = tasks.getByRole('navigation', {
    name: '承诺改期顶部翻页',
    exact: true,
  })
  await expect(changes.locator('tbody tr')).toHaveCount(25)
  await expect(tasks.locator('tbody tr')).toHaveCount(25)
  await expect(changesTop).toContainText('共104行')
  await expect(tasksTop).toContainText('共52行')
  await changesTop.getByRole('button', { name: '末页', exact: true }).click()
  await expect(changes.locator('tbody tr')).toHaveCount(4)
  await tasksTop.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(tasksTop).toContainText('第2/3页')
  await expect(changesTop).toContainText('第5/5页')
  await report.getByLabel('变化与改期任务搜索').fill(marker + '-01')
  await expect(changes.locator('tbody tr')).toHaveCount(2)
  await expect(tasks.locator('tbody tr')).toHaveCount(1)
  await expect(changesTop).toHaveCount(0)
  await expect(tasksTop).toHaveCount(0)
  await report.getByLabel('变化与改期任务搜索').fill('')
  await expect(changesTop).toContainText('第1/5页')
  await expect(tasksTop).toContainText('第1/3页')
  await report.getByLabel('改期次数筛选').selectOption('3')
  await expect(tasks.locator('tbody tr')).toHaveCount(0)
  await expect(tasksTop).toHaveCount(0)
  await report.getByLabel('改期次数筛选').selectOption('2')
  await expect(tasksTop).toContainText('第1/3页')
  // Completion removes one current task; include-history restores it without losing history.
  const completed = (await service.procurement(users.procurement!)).items.find(
    (i) => i.id === items[51]!.id,
  )!
  await service.completeItem(users.procurement!, completed.id, {
    expectedVersion: completed.version,
    actualCompleteDate: day,
  })
  const refreshStarted = Date.now()
  let capture!: (result: {
    status: number
    date: string | null | undefined
    bytes: number
  }) => void
  const refreshedSnapshot = new Promise<{
    status: number
    date: string | null | undefined
    bytes: number
  }>((resolve) => {
    capture = resolve
  })
  await report.route(
    '**/api/v1/npi/dashboard',
    async (route) => {
      const response = await route.fetch()
      const bytes = await response.body()
      const snapshot = JSON.parse(bytes.toString()) as Awaited<
        ReturnType<typeof service.dashboard>
      >
      await route.fulfill({ response })
      capture({
        status: response.status(),
        date: snapshot.projects
          .flatMap((p) => p.items)
          .find((i) => i.id === completed.id)?.actualCompleteDate,
        bytes: bytes.length,
      })
    },
    { times: 1 },
  )
  await report.getByRole('button', { name: '刷新', exact: true }).click()
  const refreshed = await refreshedSnapshot
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.date, day)
  console.log(
    'Verified completion refresh API: ' +
      JSON.stringify({
        elapsedMs: Date.now() - refreshStarted,
        responseBytes: refreshed.bytes,
      }),
  )
  await expect(
    report.getByRole('button', { name: '刷新', exact: true }),
  ).toBeEnabled({ timeout: 15000 })
  await expect(tasksTop).toContainText('共51行')
  await report.getByLabel('包含已完成 / 停止跟踪').check()
  await expect(tasksTop).toContainText('共52行')
  await tasksTop.getByRole('button', { name: '末页', exact: true }).click()
  await expect(tasks.locator('tbody tr')).toHaveCount(2)
  await changes.getByRole('button', { name: '确认完成 1', exact: true }).click()
  await expect(changes.locator('tbody tr')).toHaveCount(1)
  await expect(changesTop).toHaveCount(0)
  await changes
    .getByRole('button', { name: '承诺变更 104', exact: true })
    .click()
  await expect(changesTop).toContainText('第1/5页')
  await expect(tasksTop).toContainText('第3/3页')
  await report.screenshot({ path: '/tmp/npi-list-paging-report-desktop.png' })
  await report.setViewportSize({ width: 390, height: 844 })
  await tasksTop.getByRole('button', { name: '首页', exact: true }).click()
  await tasksTop.getByRole('button', { name: '末页', exact: true }).click()
  await expect(tasksTop).toContainText('第3/3页')
  await report.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(tasks.locator('tbody tr').first()).toBeInViewport()
  await tasksTop.scrollIntoViewIfNeeded()
  await report.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await report.screenshot({ path: '/tmp/npi-list-paging-report-mobile.png' })
  assert.equal(
    await report.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  const targetName = await tasks
    .locator('tbody tr')
    .first()
    .locator('strong')
    .innerText()
  await tasks
    .locator('tbody tr')
    .first()
    .getByRole('button', { name: '定位事项', exact: true })
    .click()
  await expect(report.locator('.npi-focused-item')).toContainText(targetName)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-list-paging-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        purchaseRows: 53,
        purchasePages: 3,
        todayChanges: 104,
        todayPages: 5,
        changedTasks: 52,
        taskPages: 3,
        wholeResultSearch: true,
        independentPages: true,
        fullScopeCounts: true,
        saveRefresh: true,
        completionFilter: true,
        lastPageFocus: true,
        mobileOverflow: false,
        supervisorWrites: writes,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: 53 purchases, 104 daily changes and 52 changed tasks paginated with full-scope search/counts, independent report pages, save/complete refresh and last-page focus; desktop/mobile and supervisor read-only verified.',
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
