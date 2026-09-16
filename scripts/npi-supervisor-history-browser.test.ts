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
const log = fs.openSync('/tmp/npi-supervisor-history-browser-server.log', 'w')
try {
  for (const role of ['technical', 'manufacturing', 'supervisor']) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@history.test.invalid'},${role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role})`
  }
  const session = await SessionManager.createSession(users.supervisor!)
  sessions.push(session.session.id)
  const marker = `历史核查-${crypto.randomUUID().slice(0, 8)}`
  const project = await service.createProject(users.technical!, {
    name: marker,
    motorModel: 'HISTORY',
    technicalOwnerId: users.technical,
    manufacturingOwnerId: users.manufacturing,
    requiredKitDate: '2026-10-15',
    prototypeRequiredDate: '2026-10-20',
  })
  const make = async (name: string, changes: number, completed = false) => {
    const item = await service.addExternal(users.technical!, project.id, {
      name,
      trackingType: 'material',
      qty: '1',
      ownerId: users.manufacturing,
      requiredDate: '2026-10-15',
      affectsKit: true,
    })
    for (let index = 0; index <= changes; index++) {
      const current = (
        await service.projectDetail(users.technical!, project.id)
      ).items.find((i) => i.id === item.id)!
      await service.updatePromise(users.manufacturing!, item.id, {
        expectedVersion: current.version,
        committedDate: `2026-10-${String(10 + index).padStart(2, '0')}`,
        reason: index ? `第${index}次改期：供应计划调整` : '首次回复',
      })
    }
    if (completed) {
      const current = (
        await service.projectDetail(users.technical!, project.id)
      ).items.find((i) => i.id === item.id)!
      await service.completeItem(users.manufacturing!, item.id, {
        expectedVersion: current.version,
        actualCompleteDate: '2026-09-15',
      })
    }
    return item
  }
  const active = await make('待跟进机壳', 2)
  await make('一次改期编码器', 1)
  await make('已完成轴承', 3, true)
  const history = await service.trackingHistory(users.supervisor!, active.id)
  assert.equal(history.item.changeCount, 2)
  assert.equal(history.history.length, 3)
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
    if (server.exitCode !== null) throw new Error('Test server exited')
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
    acceptDownloads: true,
  })
  context.setDefaultTimeout(20000)
  await context.addCookies([
    { name: 'session', value: session.sessionToken, url: base },
  ])
  const page = await context.newPage(),
    errors: Array<string> = []
  page.on('pageerror', (e) => errors.push(e.message))
  const writes: Array<string> = []
  page.on('request', (request) => {
    if (
      request.url().includes('/api/v1/npi/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
    )
      writes.push(request.method() + ' ' + new URL(request.url()).pathname)
  })
  await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '报表看板', exact: true })
    .click()
  await page.getByRole('searchbox', { name: '变化与改期任务搜索' }).fill(marker)
  const tasks = page.getByRole('region', { name: '承诺改期任务', exact: true })
  await expect(tasks.locator('tbody tr')).toHaveCount(1)
  await expect(tasks).toContainText('待跟进机壳')
  await tasks.getByLabel('改期次数筛选').selectOption('1')
  await expect(tasks.locator('tbody tr')).toHaveCount(2)
  await tasks.getByLabel('改期次数筛选').selectOption('3')
  await expect(tasks.locator('tbody tr')).toHaveCount(0)
  await tasks.getByRole('checkbox', { name: '包含已完成 / 停止跟踪' }).check()
  await expect(tasks.locator('tbody tr')).toHaveCount(1)
  await expect(tasks).toContainText('已完成轴承')
  await tasks.getByLabel('改期次数筛选').selectOption('2')
  await expect(tasks.locator('tbody tr')).toHaveCount(2)
  await expect(tasks.locator('tbody tr').first()).toContainText('已完成轴承')
  await tasks.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/npi-supervisor-history-desktop.png' })
  await tasks
    .locator('tbody tr')
    .filter({ hasText: '待跟进机壳' })
    .getByRole('button', { name: '定位事项' })
    .click()
  const row = page.locator(`[data-npi-item="${active.id}"]`)
  await expect(row).toHaveClass(/npi-focused-item/)
  await expect(row.getByRole('button', { name: '调整计划' })).toBeVisible()
  await row.getByRole('button', { name: '待跟进机壳承诺历史' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('首次承诺：2026-10-10')
  await expect(dialog).toContainText('当前承诺：2026-10-12')
  await expect(dialog).toContainText('改期 2 次')
  await expect(dialog.locator('.npi-history')).toHaveCount(3)
  await expect(dialog).toContainText('第1次改期：供应计划调整')
  await expect(dialog).toContainText('第2次改期：供应计划调整')
  await expect(dialog).toContainText('manufacturing')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(dialog).toBeVisible()
  await page.screenshot({ path: '/tmp/npi-supervisor-history-mobile.png' })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(writes, [])
  fs.writeFileSync(
    '/tmp/npi-supervisor-history-result.json',
    JSON.stringify(
      {
        passed: true,
        actor: 'supervisor',
        firstCommitExcluded: true,
        thresholds: [1, 2, 3],
        completedToggle: true,
        descendingChanges: true,
        search: true,
        focus: true,
        fullHistory: true,
        mobileOverflow: false,
        writes,
        pageErrors: errors,
        applicationRoot: appRoot,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: supervisor search/change-count thresholds/completed inclusion/sort/focus/full history/mobile; no business writes or page errors.',
  )
} finally {
  if (browser) await browser.close()
  if (server) {
    const child = server
    const running = () => child.exitCode === null && child.signalCode === null
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
  await client.end({ timeout: 5 })
}
