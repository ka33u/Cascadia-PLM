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
const log = fs.openSync('/tmp/npi-mfg-completion-browser-server.log', 'w')
const projects: Array<string> = []
const releases: Array<() => void> = []
const errors: Array<string> = []
try {
  const marker = `完成制造-${crypto.randomUUID().slice(0, 8)}`
  for (const role of [
    'technical',
    'manufacturing',
    'supervisor',
    'admin',
    'otherManufacturing',
  ]) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@mfg-completion.test.invalid'},${role},true)`
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
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const day = (offset: number) =>
    new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10)
  const writes: Array<string> = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/manufacturing-completion')
    )
      writes.push(request.url())
  })
  const dialog = page.getByRole('dialog', { name: '集中确认制造完成' })
  await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
  await board.getByLabel('业务任务搜索').fill(marker + 'A')
  await expect(
    board.getByRole('button', { name: '确认完成', exact: true }),
  ).toHaveCount(4)
  await board
    .getByRole('button', { name: '确认完成', exact: true })
    .first()
    .click()
  await expect(dialog).toContainText(marker + 'A')
  await dialog.getByRole('button', { name: '保存完成记录' }).click()
  await expect(dialog.getByRole('alert')).toContainText('至少一个')
  assert.equal(writes.length, 0)
  await dialog.getByLabel('工艺准备实际完成日期').fill(day(1))
  assert.equal(
    await dialog
      .getByLabel('工艺准备实际完成日期')
      .evaluate((input) => (input as HTMLInputElement).checkValidity()),
    false,
  )
  await dialog.getByRole('button', { name: '保存完成记录' }).click()
  assert.equal(writes.length, 0)
  await dialog.getByLabel('工艺准备实际完成日期').fill(day(-1))
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await expect(
    dialog.getByRole('button', { name: '保存完成记录' }),
  ).toBeInViewport()
  await expect(
    dialog.getByRole('heading', { name: '集中确认制造完成' }),
  ).toBeInViewport()
  await page.screenshot({ path: '/tmp/npi-mfg-completion-mobile.png' })
  const completionPath = `**/api/v1/npi/projects/${firstId}/manufacturing-completion`
  let releaseSave!: () => void, startSave!: () => void
  const heldSave = new Promise<void>((resolve) => {
    releaseSave = resolve
    releases.push(resolve)
  })
  const startedSave = new Promise<void>((resolve) => {
    startSave = resolve
  })
  await page.route(
    completionPath,
    async (route) => {
      startSave()
      await heldSave
      await route.continue()
    },
    { times: 1 },
  )
  await dialog.getByRole('button', { name: '保存完成记录' }).click()
  await startedSave
  await expect(
    dialog.getByRole('button', { name: '取消', exact: true }),
  ).toBeDisabled()
  await expect(dialog.getByLabel('工艺准备实际完成日期')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  releaseSave()
  await expect(dialog).toHaveCount(0)
  let detail = await service.projectDetail(users.manufacturing!, firstId)
  assert.equal(
    detail.items.find((i) => i.trackingType === 'process')!.actualCompleteDate,
    day(-1),
  )
  assert.equal(detail.items.filter((i) => i.actualCompleteDate).length, 1)
  assert.equal(detail.history.length, 0)
  assert.equal(writes.length, 1)
  await page.getByRole('button', { name: '返回制造准备', exact: true }).click()
  await board.getByLabel('业务任务搜索').fill(marker + 'A')
  await expect(
    board.getByRole('button', { name: '确认完成', exact: true }),
  ).toHaveCount(3)
  await expect(
    board
      .locator('.npi-module-counts')
      .getByRole('button', { name: '已完成 1', exact: true }),
  ).toBeVisible()
  await board
    .getByRole('button', { name: '确认完成', exact: true })
    .first()
    .click()
  await expect(dialog.getByLabel('工艺准备实际完成日期')).toBeDisabled()
  await expect(dialog.getByLabel('工艺准备实际完成日期')).toHaveValue(day(-1))
  await dialog.getByLabel('工装准备实际完成日期').fill(day(-1))
  await dialog.getByLabel('零部件齐套实际完成日期').fill(today)
  await service.completeManufacturing(users.manufacturing!, firstId, {
    expectedVersion: detail.plan!.version,
    actualDates: { tooling: day(-2) },
  })
  const conflict = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/projects/${firstId}/manufacturing-completion`) &&
      r.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: '保存完成记录' }).click()
  assert.equal((await conflict).status(), 409)
  await expect(dialog.getByLabel('零部件齐套实际完成日期')).toHaveValue(today)
  await expect(
    dialog.getByRole('button', { name: '保存完成记录' }),
  ).toBeDisabled()
  await dialog.getByRole('button', { name: '读取最新记录' }).click()
  await expect(
    dialog.getByRole('button', { name: '按最新记录继续' }),
  ).toBeVisible()
  await expect(dialog.getByLabel('工装准备实际完成日期')).toHaveValue(day(-2))
  await expect(dialog.getByLabel('工装准备实际完成日期')).toBeDisabled()
  await expect(dialog.getByLabel('零部件齐套实际完成日期')).toHaveValue(today)
  await dialog.getByRole('button', { name: '按最新记录继续' }).click()
  await dialog.getByRole('button', { name: '保存完成记录' }).click()
  await expect(dialog).toHaveCount(0)
  detail = await service.projectDetail(users.manufacturing!, firstId)
  assert.equal(
    detail.items.find((i) => i.trackingType === 'tooling')!.actualCompleteDate,
    day(-2),
  )
  assert.equal(
    detail.items.find((i) => i.trackingType === 'kit')!.actualCompleteDate,
    today,
  )
  // A successful completion with a failed list refresh can retry reads without another write.
  await page.getByRole('button', { name: '集中确认完成', exact: true }).click()
  await dialog.getByLabel('样机装配实际完成日期').fill(today)
  await page.route(
    '**/api/v1/npi/dashboard',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '专项模拟列表暂时不可用' }),
      }),
    { times: 1 },
  )
  await dialog.getByRole('button', { name: '保存完成记录' }).click()
  await expect(dialog.getByRole('alert')).toContainText(
    '完成记录已保存，列表刷新失败',
  )
  await expect(dialog.getByLabel('样机装配实际完成日期')).toBeDisabled()
  const writesBeforeRefresh = writes.length
  detail = await service.projectDetail(users.manufacturing!, firstId)
  assert.equal(detail.items.filter((i) => i.actualCompleteDate).length, 4)
  const completedBefore = detail.events.filter(
    (e) => e.action === 'COMPLETED',
  ).length
  assert.equal(completedBefore, 4)
  await dialog.getByRole('button', { name: '重试刷新' }).click()
  await expect(dialog).toHaveCount(0)
  assert.equal(writes.length, writesBeforeRefresh)
  assert.equal(
    (await service.projectDetail(users.manufacturing!, firstId)).events.filter(
      (e) => e.action === 'COMPLETED',
    ).length,
    completedBefore,
  )
  await expect(
    page.getByRole('button', { name: '集中确认完成', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: '返回制造准备', exact: true }).click()
  await board.getByLabel('业务任务搜索').fill(marker + 'A')
  await board.getByLabel('业务任务状态').selectOption('completed')
  await expect(board.locator('tbody tr')).toHaveCount(4)
  await expect(
    board.getByRole('button', { name: '确认完成', exact: true }),
  ).toHaveCount(0)
  await board.getByLabel('业务任务状态').selectOption('unfinished')
  await board.getByLabel('业务任务搜索').fill(marker + 'B')
  // Leaving while a detail request is pending must not open a late completion dialog.
  let releaseRead!: () => void, startRead!: () => void
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve
    releases.push(resolve)
  })
  const startedRead = new Promise<void>((resolve) => {
    startRead = resolve
  })
  await page.route(
    `**/api/v1/npi/projects/${secondId}`,
    async (route) => {
      startRead()
      await heldRead
      await route.continue()
    },
    { times: 1 },
  )
  await board
    .getByRole('button', { name: '确认完成', exact: true })
    .first()
    .click()
  const lateRead = page.waitForResponse((r) =>
    r.url().endsWith(`/projects/${secondId}`),
  )
  await startedRead
  await nav.getByRole('button', { name: '新品项目', exact: true }).click()
  releaseRead()
  await (await lateRead).finished()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(
    page.getByRole('heading', { name: '新品项目', exact: true }),
  ).toBeVisible()
  await expect(dialog).toHaveCount(0)
  await nav.getByRole('button', { name: '制造准备', exact: true }).click()
  await board.getByLabel('业务任务搜索').fill(marker + 'B')
  await board
    .getByRole('button', { name: '确认完成', exact: true })
    .first()
    .click()
  await expect(dialog).toContainText(marker + 'B')
  for (const label of ['工艺准备', '工装准备', '零部件齐套', '样机装配'])
    await expect(dialog.getByLabel(label + '实际完成日期')).toHaveValue('')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(
    dialog.getByRole('button', { name: '保存完成记录' }),
  ).toBeInViewport()
  await page.screenshot({ path: '/tmp/npi-mfg-completion-desktop.png' })
  await dialog.getByLabel('工艺准备实际完成日期').fill(today)
  const writesBeforeRead = writes.length
  await page.route(
    `**/api/v1/npi/projects/${secondId}`,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '专项模拟读取失败' }),
      }),
    { times: 1 },
  )
  await dialog.getByRole('button', { name: '读取最新记录' }).click()
  await expect(dialog.getByRole('alert')).toContainText('专项模拟读取失败')
  await expect(
    dialog.getByRole('button', { name: '保存完成记录' }),
  ).toBeDisabled()
  await dialog.getByRole('button', { name: '读取最新记录' }).click()
  await dialog.getByRole('button', { name: '按最新记录继续' }).click()
  await expect(dialog.getByLabel('工艺准备实际完成日期')).toHaveValue(today)
  assert.equal(writes.length, writesBeforeRead)
  // Change only this fixture's owner to exercise permission revocation while the form is open.
  await client`update npi_projects set manufacturing_owner_id=${users.otherManufacturing!} where program_id=${secondId}`
  await dialog.getByRole('button', { name: '读取最新记录' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: '保存完成记录' }),
  ).toBeDisabled()
  await expect(dialog.getByLabel('工艺准备实际完成日期')).toBeDisabled()
  assert.equal(writes.length, writesBeforeRead)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  // Supervisor and technical views never expose completion writes; admin can batch-complete all nodes.
  for (const role of ['supervisor', 'technical', 'admin']) {
    const roleSession = await SessionManager.createSession(users[role]!)
    sessions.push(roleSession.session.id)
    const roleContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    })
    await roleContext.addCookies([
      { name: 'session', value: roleSession.sessionToken, url: base },
    ])
    const rolePage = await roleContext.newPage()
    rolePage.on('pageerror', (e) => errors.push(e.message))
    const roleWrites: Array<string> = []
    rolePage.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith('/manufacturing-completion')
      )
        roleWrites.push(request.url())
    })
    await rolePage.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
    await rolePage
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '制造准备', exact: true })
      .click()
    const roleBoard = rolePage.getByRole('region', { name: '制造四节点任务' })
    await roleBoard.getByLabel('业务任务搜索').fill(marker + 'B')
    if (role !== 'admin') {
      await expect(
        roleBoard.getByRole('button', { name: '确认完成', exact: true }),
      ).toHaveCount(0)
      await roleBoard
        .getByRole('button', { name: '查看制造准备 ↗', exact: true })
        .first()
        .click()
      await expect(
        rolePage.getByRole('button', { name: '集中确认完成', exact: true }),
      ).toHaveCount(0)
      assert.deepEqual(roleWrites, [])
    } else {
      await expect(
        roleBoard.getByRole('button', { name: '确认完成', exact: true }),
      ).toHaveCount(4)
      await roleBoard
        .getByRole('button', { name: '确认完成', exact: true })
        .first()
        .click()
      const batchDialog = rolePage.getByRole('dialog', {
        name: '集中确认制造完成',
      })
      for (const label of ['工艺准备', '工装准备', '零部件齐套', '样机装配'])
        await batchDialog.getByLabel(label + '实际完成日期').fill(day(-1))
      await batchDialog.getByRole('button', { name: '保存完成记录' }).click()
      await expect(batchDialog).toHaveCount(0)
      assert.equal(roleWrites.length, 1)
      const batch = await service.projectDetail(users.admin!, secondId)
      assert.equal(
        batch.items.filter((i) => i.actualCompleteDate === day(-1)).length,
        4,
      )
      assert.equal(
        batch.events.filter((e) => e.action === 'MANUFACTURING_COMPLETED')
          .length,
        1,
      )
      assert.equal(batch.history.length, 0)
    }
    await roleContext.close()
  }
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-mfg-completion-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        directTaskEntry: true,
        sharedProjectEntry: true,
        emptyAndFutureDatesRejected: true,
        partialCompletion: true,
        allFourBatchCompletion: true,
        existingActualsLocked: true,
        conflictKeepsPendingInputs: true,
        explicitLatestAcceptance: true,
        saveCannotDismiss: true,
        savedRefreshRetriesReadOnly: true,
        revokedPermissionLocks: true,
        lateNavigationIgnored: true,
        separateProjectInputs: true,
        supervisorAndTechnicalNoWrites: true,
        completedCountsRefreshed: true,
        historyUnchanged: true,
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: direct manufacturing completion, partial and four-node batch, date validation, conflict recovery, preserved actuals/history, read-only refresh retry, permission revocation, stale navigation and mobile/desktop.',
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
