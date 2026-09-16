// SPDX-License-Identifier: AGPL-3.0-or-later
import 'dotenv/config'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import fs from 'node:fs'
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
const log = fs.openSync('/tmp/npi-assignment-browser-server.log', 'w')
try {
  for (const role of ['technical', 'manufacturing', 'assignee']) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@assignment-browser.test.invalid'},${role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role === 'assignee' ? 'manufacturing' : role})`
  }
  const session = await SessionManager.createSession(users.assignee!)
  sessions.push(session.session.id)
  const project = await service.createProject(users.technical!, {
    name: '独立物料待办浏览器验证',
    motorModel: 'ASSIGNMENT-BROWSER',
    technicalOwnerId: users.technical,
    manufacturingOwnerId: users.manufacturing,
    requiredKitDate: '2026-10-15',
    prototypeRequiredDate: '2026-10-20',
  })
  const item = await service.addExternal(users.technical!, project.id, {
    name: '指定制造人员的临时件',
    trackingType: 'material',
    qty: '1',
    ownerId: users.assignee,
    requiredDate: '2026-10-15',
    affectsKit: true,
  })
  await service.addExternal(users.technical!, project.id, {
    name: '其他人的私有物料',
    trackingType: 'material',
    qty: '1',
    ownerId: users.manufacturing,
    requiredDate: '2026-10-15',
    affectsKit: true,
  })
  server = spawn(process.execPath, ['.output/cascadia/server/index.mjs'], {
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      BASE_URL: base,
      APP: 'cascadia',
    },
  })
  server.on('error', () => {})
  let ready = false
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null)
      throw new Error('Isolated application server exited')
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
      /* wait for our child */
    }
    await delay(200)
  }
  assert.ok(ready, 'Isolated application did not become ready')
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  })
  context.setDefaultTimeout(20000)
  await context.addCookies([
    { name: 'session', value: session.sessionToken, url: base },
  ])
  const page = await context.newPage(),
    errors: Array<string> = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
  const region = page.getByRole('region', { name: '我的物料待办', exact: true })
  await expect(
    region.getByRole('heading', { name: '我的协作物料' }),
  ).toBeVisible()
  await expect(region).toContainText(item.name)
  await expect(region).not.toContainText('其他人的私有物料')
  assert.equal(
    (
      await page.request.get(base + `/api/v1/npi/projects/${project.id}`)
    ).status(),
    403,
  )
  let saves = 0
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith(`/tracking/${item.id}/promise`)
    )
      saves++
  })
  await region.getByRole('button', { name: '回复日期', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '物料日期回复', exact: true })
  await dialog.getByLabel('承诺完成日期', { exact: true }).fill('2026-10-14')
  let failedRefresh = false
  const route = '**/api/v1/npi/workbench/materials'
  await page.route(route, async (r) => {
    if (!failedRefresh) {
      failedRefresh = true
      await r.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '测试读取失败' }),
      })
    } else await r.continue()
  })
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(region.getByRole('alert')).toContainText('测试读取失败')
  await expect(
    region.getByRole('button', { name: '回复日期', exact: true }),
  ).toBeDisabled()
  await region
    .getByRole('button', { name: '刷新物料待办', exact: true })
    .click()
  await expect(region.getByRole('alert')).toHaveCount(0)
  await expect(region).toContainText('2026-10-14')
  assert.equal(saves, 1)
  await page.unroute(route)
  await region.getByRole('button', { name: '修改承诺', exact: true }).click()
  await dialog.getByLabel('承诺完成日期', { exact: true }).fill('2026-10-16')
  await dialog
    .getByLabel('变更原因（必填）', { exact: true })
    .fill('加工计划调整')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(region).toContainText('2026-10-16')
  await region.getByRole('button', { name: '承诺历史', exact: true }).click()
  const history = page.getByRole('dialog')
  await expect(history).toContainText('加工计划调整')
  await expect(history).toContainText('2026-10-14')
  await expect(history).toContainText('2026-10-16')
  await page.keyboard.press('Escape')
  await expect(history).toHaveCount(0)
  await page.screenshot({
    path: '/tmp/npi-assignment-mobile.png',
    fullPage: true,
  })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await region.getByRole('button', { name: '确认完成', exact: true }).click()
  const completion = page.getByRole('dialog', {
    name: '确认物料完成',
    exact: true,
  })
  await completion
    .getByLabel('完成备注', { exact: true })
    .fill('已完成协作物料')
  await completion.getByRole('button', { name: '保存', exact: true }).click()
  await expect(completion).toHaveCount(0)
  await expect(region).toContainText('没有符合条件的物料')
  await region
    .getByLabel('物料待办状态', { exact: true })
    .selectOption('completed')
  await expect(region).toContainText('已完成')
  await expect(
    region.getByRole('button', { name: '确认完成', exact: true }),
  ).toHaveCount(0)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({
    path: '/tmp/npi-assignment-desktop.png',
    fullPage: true,
  })
  const work = await service.assignedMaterials(users.assignee!)
  assert.equal(work.items.filter((row) => row.id === item.id).length, 1)
  assert.equal(
    work.items.find((row) => row.id === item.id)!.status,
    'completed',
  )
  assert.equal(
    (await service.trackingHistory(users.assignee!, item.id)).history.length,
    2,
  )
  assert.deepEqual(errors, [])
  console.log(
    'PASS: delegated material visible without project access; mobile reply, failed refresh without duplicate save, reasoned change, history, completion, desktop and mobile layout.',
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
