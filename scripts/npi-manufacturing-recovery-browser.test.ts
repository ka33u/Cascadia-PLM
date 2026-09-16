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
const fixtureRecord = '/tmp/npi-manufacturing-recovery-fixtures.json'
if (
  fs.existsSync(fixtureRecord) &&
  !JSON.parse(fs.readFileSync(fixtureRecord, 'utf8')).cleaned
)
  throw Error('Previous test fixtures need cleanup')
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
const log = fs.openSync(
  '/tmp/npi-manufacturing-recovery-browser-server.log',
  'w',
)
const projects: Array<string> = []
const releases: Array<() => void> = []
const errors: Array<string> = []
try {
  const marker = `制造恢复-${crypto.randomUUID().slice(0, 8)}`
  for (const role of ['technical', 'manufacturing', 'supervisor']) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@mfg-quick.test.invalid'},${role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role})`
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
  const appRoot = process.env.NPI_BROWSER_APP_ROOT || process.cwd()
  fs.writeFileSync(
    fixtureRecord,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        ownerPid: process.pid,
        projectIds: projects,
        userIds: Object.values(users),
        appRoot,
        cleaned: false,
      },
      null,
      2,
    ),
  )
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
  const session = await SessionManager.createSession(users.manufacturing!)
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
  const nav = page.getByRole('navigation', { name: '主导航' }),
    board = page.getByRole('region', { name: '制造四节点任务' })
  const writes = new Map<string, number>()
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      request.url().endsWith('/manufacturing-plan')
    ) {
      const url = new URL(request.url()).pathname
      writes.set(url, (writes.get(url) || 0) + 1)
    }
  })
  const count = (id: string) =>
    writes.get(`/api/v1/npi/projects/${id}/manufacturing-plan`) || 0
  await page.goto(base + '/npi', { waitUntil: 'networkidle' })
  await board.getByLabel('业务任务搜索').fill(marker + 'A')
  await board.getByRole('button', { name: '集中回复 ↗' }).first().click()
  const dialog = page.getByRole('dialog', { name: '集中回复制造四节点' })
  await dialog.getByLabel('工艺准备承诺日期').fill('2026-10-10')
  let release!: () => void,
    started!: () => void,
    heldStatus = 0,
    heldError = ''
  const held = new Promise<void>((r) => {
    release = r
    releases.push(r)
  })
  const began = new Promise<void>((r) => {
    started = r
  })
  await page.route(
    `**/api/v1/npi/projects/${firstId}/manufacturing-plan`,
    async (route) => {
      try {
        const response = await route.fetch()
        heldStatus = response.status()
        started()
        await held
        await route.fulfill({ response })
      } catch (error) {
        heldError = String(error)
        started()
        await route.abort().catch(() => {})
      }
    },
    { times: 1 },
  )
  let refreshFailures = 0
  await page.route(
    '**/api/v1/npi/dashboard',
    async (route) => {
      refreshFailures++
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '测试：项目汇总暂时不可用' }),
      })
    },
    { times: 2 },
  )
  await dialog.getByRole('button', { name: '保存制造回复' }).click()
  await began
  assert.equal(heldError, '')
  assert.equal(heldStatus, 200)
  await page.keyboard.press('Escape')
  await dialog
    .locator(':scope > button')
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(dialog).toBeVisible()
  await dialog
    .locator('form')
    .evaluate((form: HTMLFormElement) => form.requestSubmit())
  assert.equal(count(firstId), 1)
  release()
  await expect(dialog.getByRole('alert')).toContainText(
    '制造承诺已保存，列表刷新失败',
  )
  await expect(dialog.getByLabel('工艺准备承诺日期')).toBeDisabled()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await dialog.screenshot({
    path: '/tmp/npi-manufacturing-recovery-saved-desktop.png',
  })
  await dialog.getByRole('button', { name: '重试刷新列表' }).click()
  await expect(dialog.getByRole('alert')).toContainText('列表仍未刷新')
  assert.equal(count(firstId), 1)
  assert.equal(refreshFailures, 2)
  await dialog.getByRole('button', { name: '重试刷新列表' }).click()
  await expect(dialog).toHaveCount(0)
  let a = await service.projectDetail(users.manufacturing!, firstId)
  assert.equal(a.history.length, 1)
  // A separate session changes an untouched node; explicit review keeps our edited node.
  await page.getByRole('button', { name: '集中回复', exact: true }).click()
  await dialog.getByLabel('工艺准备承诺日期').fill('2026-10-12')
  await dialog.getByLabel('工艺准备改期原因').fill('核对工艺评审时间')
  await service.manufacturingPlan(users.manufacturing!, firstId, {
    expectedVersion: a.plan!.version,
    toolingCommitted: '2026-10-11',
  })
  const conflict = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/projects/${firstId}/manufacturing-plan`) &&
      r.request().method() === 'PUT',
  )
  await dialog.getByRole('button', { name: '保存制造回复' }).click()
  assert.equal((await conflict).status(), 409)
  await expect(
    dialog.getByRole('button', { name: '保存制造回复' }),
  ).toBeDisabled()
  await dialog.getByRole('button', { name: '刷新最新计划' }).click()
  await dialog.getByRole('button', { name: '载入最新计划' }).click()
  await expect(dialog.getByLabel('工艺准备承诺日期')).toHaveValue('2026-10-12')
  await expect(dialog.getByLabel('工艺准备改期原因')).toHaveValue(
    '核对工艺评审时间',
  )
  await expect(dialog.getByLabel('工装准备承诺日期')).toHaveValue('2026-10-11')
  await page.setViewportSize({ width: 390, height: 844 })
  await dialog.screenshot({
    path: '/tmp/npi-manufacturing-recovery-conflict-mobile.png',
  })
  assert.equal(
    await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    false,
  )
  await dialog.getByRole('button', { name: '保存制造回复' }).click()
  await expect(dialog).toHaveCount(0)
  a = await service.projectDetail(users.manufacturing!, firstId)
  const processNode = a.items.find((i) => i.trackingType === 'process')!
  assert.equal(processNode.firstCommittedDate, '2026-10-10')
  assert.equal(processNode.currentCommittedDate, '2026-10-12')
  assert.equal(processNode.changeCount, 1)
  assert.equal(a.history.length, 3)
  assert.ok(a.history.some((h) => h.reason === '核对工艺评审时间'))
  // Test the inline form on B independently from A.
  await nav.getByRole('button', { name: '制造准备', exact: true }).click()
  await board.getByLabel('业务任务搜索').fill(marker + 'B')
  await board.getByRole('button', { name: '集中回复 ↗' }).first().click()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('tab', { name: '样机齐套', exact: true }).click()
  const inline = page.getByRole('region', { name: '制造部集中回复' })
  await inline.getByLabel('工装准备承诺日期').fill('2026-10-10')
  let lostStatus = 0,
    lostError = ''
  await page.route(
    `**/api/v1/npi/projects/${secondId}/manufacturing-plan`,
    async (route) => {
      try {
        const response = await route.fetch()
        lostStatus = response.status()
        await route.abort('connectionfailed')
      } catch (error) {
        lostError = String(error)
        await route.abort().catch(() => {})
      }
    },
    { times: 1 },
  )
  await inline.getByRole('button', { name: '保存制造回复' }).click()
  await expect(inline.getByRole('alert')).toContainText('填写内容已保留')
  assert.equal(lostStatus, 200)
  assert.equal(lostError, '')
  await expect(
    inline.getByRole('button', { name: '保存制造回复' }),
  ).toBeDisabled()
  await inline.getByRole('button', { name: '刷新最新计划' }).click()
  await inline.getByRole('button', { name: '载入最新计划' }).click()
  await inline.getByLabel('工装准备承诺日期').scrollIntoViewIfNeeded()
  await inline.getByRole('button', { name: '保存制造回复' }).click()
  await expect(inline.getByRole('status')).toContainText(
    '没有需要保存的日期变化',
  )
  assert.equal(count(secondId), 1)
  await inline.screenshot({
    path: '/tmp/npi-manufacturing-recovery-inline-mobile.png',
  })
  // An account mismatch in the refresh cannot turn a saved write into a second submission.
  await inline.getByLabel('样机装配承诺日期').fill('2026-10-18')
  await page.route(
    '**/api/v1/npi/meta',
    async (route) => {
      const response = await route.fetch(),
        body = await response.json()
      await route.fulfill({
        response,
        json: { ...body, actor: { ...body.actor, id: users.supervisor } },
      })
    },
    { times: 1 },
  )
  await inline.getByRole('button', { name: '保存制造回复' }).click()
  await expect(inline.getByRole('alert')).toContainText('登录账号已改变')
  await expect(inline.getByLabel('样机装配承诺日期')).toBeDisabled()
  assert.equal(count(secondId), 2)
  await inline.getByRole('button', { name: '重试刷新列表' }).click()
  await expect(inline.getByLabel('样机装配承诺日期')).toBeEnabled()
  const b = await service.projectDetail(users.manufacturing!, secondId)
  assert.equal(b.history.length, 2)
  assert.equal(
    b.items.find((i) => i.trackingType === 'tooling')!.currentCommittedDate,
    '2026-10-10',
  )
  assert.equal(
    b.items.find((i) => i.trackingType === 'assembly')!.currentCommittedDate,
    '2026-10-18',
  )
  assert.equal(
    (await service.projectDetail(users.manufacturing!, firstId)).history.length,
    3,
  )
  assert.equal(count(firstId), 3)
  assert.equal(count(secondId), 2)
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-manufacturing-recovery-browser-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        refreshFailuresRecovered: refreshFailures,
        committedWriteRetained: true,
        refreshOnlyRetry: true,
        immediateDoubleSubmitPrevented: true,
        pendingDialogCloseProtected: true,
        conflictDraftAndReasonRetained: true,
        untouchedNodeRefreshed: true,
        originalPromisePreserved: true,
        lostInlineResponseRecovered: true,
        actorMismatchBlocked: true,
        projectIsolation: true,
        putCounts: { A: count(firstId), B: count(secondId) },
        historyCounts: { A: a.history.length, B: b.history.length },
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: dialog and inline manufacturing reply saved-state refresh recovery, conflict draft preservation, lost response reconciliation, actor mismatch and project isolation; desktop/mobile.',
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
  if (fs.existsSync(fixtureRecord))
    fs.writeFileSync(
      fixtureRecord,
      JSON.stringify(
        {
          ...JSON.parse(fs.readFileSync(fixtureRecord, 'utf8')),
          cleaned: true,
          cleanedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
}
