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
const log = fs.openSync('/tmp/npi-procurement-reply-browser-server.log', 'w')
const projects: Array<string> = []
const releases: Array<() => void> = []
const errors: Array<string> = []
try {
  const marker = `采购回复-${crypto.randomUUID().slice(0, 8)}`
  for (const role of ['technical', 'manufacturing', 'procurement', 'buyer2']) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@purchase-reply.test.invalid'},${role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role === 'buyer2' ? 'procurement' : role})`
  }
  for (const suffix of ['A', 'B']) {
    const project = await service.createProject(users.technical!, {
      name: marker + suffix,
      motorModel: 'PURCHASE-' + suffix,
      technicalOwnerId: users.technical,
      manufacturingOwnerId: users.manufacturing,
      requiredKitDate: '2026-10-15',
      prototypeRequiredDate: '2026-10-20',
    })
    projects.push(project.id)
  }
  const add = (projectId: string, suffix: string) =>
    service.addExternal(users.technical!, projectId, {
      name: marker + suffix,
      qty: '1',
      unit: '件',
      requiredDate: '2026-10-15',
      ownerId: users.procurement,
      affectsKit: true,
      remark: '原始备注',
    })
  const a = await add(projects[0]!, '物料A'),
    b = await add(projects[1]!, '物料B'),
    c = await add(projects[1]!, '物料C')
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
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

  const session = await SessionManager.createSession(users.procurement!)
  sessions.push(session.session.id)
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  })
  context.setDefaultTimeout(15000)
  await context.addCookies([
    { name: 'session', value: session.sessionToken, url: base },
  ])
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
  await expect(
    page.getByRole('navigation', { name: '主导航' }).getByRole('button'),
  ).toHaveCount(1)
  const row = (id: string) => page.locator(`[data-npi-item="${id}"]`)
  const dialog = () =>
    page.getByRole('dialog', { name: '采购日期回复', exact: true })
  const details = (id: string) =>
    service
      .procurement(users.procurement!)
      .then((r) => r.items.find((item) => item.id === id)!)
  const requestCount = () =>
    client`select count(*)::int as count from npi_promise_history where object_id=${a.id}`.then(
      (r) => r[0]!.count,
    )
  const hold = async (pathname: string) => {
    let release!: () => void, started!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
      releases.push(resolve)
    })
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    await page.route(
      (url) => url.pathname === '/api/v1/npi' + pathname,
      async (route) => {
        const response = await route.fetch()
        started()
        await held
        await route.fulfill({ response })
      },
      { times: 1 },
    )
    return { started: began, release }
  }
  // First reply needs only a date, with optional fields collapsed.
  await row(a.id).getByRole('button', { name: '回复', exact: true }).click()
  await expect(dialog().getByLabel('供应商', { exact: true })).not.toBeVisible()
  await expect(dialog().getByLabel('变更原因（必填）')).toHaveCount(0)
  await dialog().getByLabel('预计到货日期').fill('2026-10-10')
  await page.screenshot({ path: '/tmp/npi-procurement-reply-mobile.png' })
  await dialog().getByRole('button', { name: '保存回复', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  assert.equal((await details(a.id)).firstCommittedDate, '2026-10-10')
  assert.equal(await requestCount(), 1)
  // A concurrent change creates a version conflict; user edits must survive reload.
  await row(a.id).getByRole('button', { name: '改期', exact: true }).click()
  await dialog().getByLabel('预计到货日期').fill('2026-10-12')
  await dialog().getByRole('button', { name: '保存回复', exact: true }).click()
  assert.equal(await requestCount(), 1)
  await dialog().getByLabel('变更原因（必填）').fill('供应商调整交付批次')
  await dialog().locator('summary').click()
  await dialog()
    .getByLabel('供应商', { exact: true })
    .fill('采购正在填写的供应商')
  let current = await details(a.id)
  await service.updatePromise(users.procurement!, a.id, {
    expectedVersion: current.version,
    committedDate: '2026-10-11',
    reason: '另一会话更新交期',
    supplier: '其他会话供应商',
    remark: '最新补充的备注',
  })
  await dialog().getByRole('button', { name: '保存回复', exact: true }).click()
  await expect(dialog().getByRole('alert')).toContainText('填写内容已保留')
  await expect(dialog().getByLabel('预计到货日期')).toHaveValue('2026-10-12')
  assert.equal(await requestCount(), 2)
  // Failed read disables stale saves, and a retry remains in the same form.
  await page.route(
    '**/api/v1/npi/workbench/procurement',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '暂时离线' }),
      }),
    { times: 1 },
  )
  await dialog()
    .getByRole('button', { name: '读取最新记录', exact: true })
    .click()
  await expect(dialog().getByRole('alert')).toContainText('暂时离线')
  await expect(
    dialog().getByRole('button', { name: '保存回复', exact: true }),
  ).toBeDisabled()
  const read = await hold('/workbench/procurement')
  await dialog()
    .getByRole('button', { name: '读取最新记录', exact: true })
    .click()
  await read.started
  await expect(dialog().getByLabel('预计到货日期')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog()).toBeVisible()
  read.release()
  await expect(
    dialog().getByRole('region', { name: '采购记录变化' }),
  ).toContainText('2026-10-11')
  await expect(dialog().getByLabel('预计到货日期')).toHaveValue('2026-10-12')
  await expect(dialog().getByLabel('供应商', { exact: true })).toHaveValue(
    '采购正在填写的供应商',
  )
  await expect(
    dialog().getByRole('textbox', { name: '备注', exact: true }),
  ).toHaveValue('原始备注')
  await expect(
    dialog().getByRole('button', { name: '保存回复', exact: true }),
  ).toBeDisabled()
  await dialog()
    .getByRole('button', { name: '以最新记录继续编辑', exact: true })
    .click()
  await expect(
    dialog().getByRole('textbox', { name: '备注', exact: true }),
  ).toHaveValue('最新补充的备注')
  await expect(dialog().getByLabel('供应商', { exact: true })).toHaveValue(
    '采购正在填写的供应商',
  )
  await expect(dialog().getByLabel('变更原因（必填）')).toHaveValue(
    '供应商调整交付批次',
  )
  await dialog()
    .getByRole('button', { name: '保存回复', exact: true })
    .scrollIntoViewIfNeeded()
  await page.screenshot({
    path: '/tmp/npi-procurement-reply-conflict-mobile.png',
  })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  const save = await hold(`/tracking/${a.id}/promise`)
  await dialog().getByRole('button', { name: '保存回复', exact: true }).click()
  await save.started
  await expect(dialog().getByLabel('预计到货日期')).toBeDisabled()
  await expect(
    dialog().getByRole('button', { name: '取消', exact: true }),
  ).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog()).toBeVisible()
  save.release()
  await expect(dialog()).toHaveCount(0)
  current = await details(a.id)
  assert.equal(current.firstCommittedDate, '2026-10-10')
  assert.equal(current.currentCommittedDate, '2026-10-12')
  assert.equal(current.supplier, '采购正在填写的供应商')
  assert.equal(current.remark, '最新补充的备注')
  assert.equal(current.changeCount, 2)
  assert.equal(await requestCount(), 3)
  // Supplier-only updates on an unchanged date need no invented change reason/history.
  await row(a.id).getByRole('button', { name: '改期', exact: true }).click()
  await expect(dialog().getByLabel('变更原因（必填）')).toHaveCount(0)
  await dialog().locator('summary').click()
  await dialog().getByLabel('供应商', { exact: true }).fill('已确认的供应商')
  await dialog().getByRole('button', { name: '保存回复', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  assert.equal(await requestCount(), 3)
  assert.equal((await details(a.id)).supplier, '已确认的供应商')
  // A transferred item cannot be saved after checking the latest owner.
  await row(b.id).getByRole('button', { name: '回复', exact: true }).click()
  await dialog().getByLabel('预计到货日期').fill('2026-10-09')
  await service.adjustTrackingPlan(users.technical!, b.id, {
    expectedVersion: b.version,
    ownerId: users.buyer2,
    reason: '采购任务交接',
  })
  await dialog()
    .getByRole('button', { name: '读取最新记录', exact: true })
    .click()
  await expect(dialog().getByRole('alert')).toContainText('不在你的采购待办')
  await expect(
    dialog().getByRole('button', { name: '保存回复', exact: true }),
  ).toBeDisabled()
  await expect(dialog().getByLabel('预计到货日期')).toHaveValue('2026-10-09')
  await dialog().getByRole('button', { name: '取消', exact: true }).click()
  // Completion by another session is shown without overwriting the attempted date.
  await row(c.id).getByRole('button', { name: '到货', exact: true }).click()
  const arrival = () =>
    page.getByRole('dialog', { name: '确认到货', exact: true })
  await service.completeItem(users.procurement!, c.id, {
    expectedVersion: c.version,
    actualCompleteDate: today,
    remark: '仓库已确认',
  })
  await arrival()
    .getByRole('button', { name: '读取最新记录', exact: true })
    .click()
  await expect(arrival()).toContainText('不能再次修改')
  await expect(
    arrival().getByRole('button', { name: '保存到货', exact: true }),
  ).toBeDisabled()
  await arrival().getByRole('button', { name: '关闭', exact: true }).click()
  // Normal arrival submission and complete/history visibility.
  await row(a.id).getByRole('button', { name: '到货', exact: true }).click()
  await arrival().getByLabel('实际到货日期').fill(today)
  await arrival().getByLabel('到货说明（选填）').fill('已验收到货，资料见附件')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect
    .poll(async () => (await arrival().boundingBox())?.width || 0)
    .toBeGreaterThan(600)
  await page.screenshot({ path: '/tmp/npi-procurement-reply-desktop.png' })
  await arrival().getByRole('button', { name: '保存到货', exact: true }).click()
  await expect(arrival()).toHaveCount(0)
  await page.getByLabel('采购筛选').selectOption('completed')
  await expect(row(a.id)).toContainText(today)
  await expect(
    row(a.id).getByRole('button', { name: '到货', exact: true }),
  ).toHaveCount(0)
  await expect(
    row(a.id).getByRole('button', { name: new RegExp('附件资料') }),
  ).toBeVisible()
  await row(a.id)
    .getByRole('button', { name: new RegExp('承诺历史') })
    .click()
  const history = page.getByRole('dialog', { name: new RegExp('承诺历史') })
  await expect(history).toContainText('供应商调整交付批次')
  await expect(history).toContainText('另一会话更新交期')
  await history.getByRole('button', { name: '关闭', exact: true }).click()
  assert.equal((await details(a.id)).actualCompleteDate, today)
  assert.equal(await requestCount(), 3)
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-procurement-reply-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        firstReplyDateOnly: true,
        changeReasonRequired: true,
        conflictPreservesDraft: true,
        explicitLatestAcceptance: true,
        untouchedFieldsRefresh: true,
        failedReadRecovery: true,
        busyProtection: true,
        transferredItemLocked: true,
        concurrentArrivalLocked: true,
        supplierOnlyPreservesHistory: true,
        arrivalAndHistory: true,
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: procurement reply, conflict and read-failure recovery, preserved edits, latest untouched fields, save protection, transfer/completion locks, supplier-only updates, arrival and full history.',
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
