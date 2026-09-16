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
const log = fs.openSync('/tmp/npi-mfg-quick-browser-server.log', 'w')
const projects: Array<string> = []
const releases: Array<() => void> = []
const errors: Array<string> = []
try {
  const marker = `快捷制造-${crypto.randomUUID().slice(0, 8)}`
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
  await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
  await board.getByLabel('业务任务搜索').fill(marker + 'A')
  const counts = board.locator('.npi-module-counts')
  await expect(
    counts.getByRole('button', { name: '待回复 4', exact: true }),
  ).toBeVisible()
  assert.ok(
    (await counts.boundingBox())!.y <
      (await board.getByLabel('业务任务搜索').boundingBox())!.y,
  )
  await board.getByLabel('制造节点筛选').selectOption('process')
  await expect(
    counts.getByRole('button', { name: '待回复 1', exact: true }),
  ).toBeVisible()
  await board.getByLabel('制造节点筛选').selectOption('all')
  await board.getByRole('button', { name: '集中回复 ↗' }).first().click()
  const dialog = page.getByRole('dialog', { name: '集中回复制造四节点' })
  await expect(dialog).toContainText(marker + 'A')
  await expect(dialog.getByLabel('工艺准备承诺日期')).toHaveValue('')
  await expect(dialog.getByLabel('工艺准备改期原因')).toHaveCount(0)
  await dialog.getByLabel('工艺准备承诺日期').fill('2026-10-10')
  const planPath = `**/api/v1/npi/projects/${firstId}/manufacturing-plan`
  let releaseSave!: () => void, startedSave!: () => void
  const saveHeld = new Promise<void>((resolve) => {
    releaseSave = resolve
    releases.push(resolve)
  })
  const saveStarted = new Promise<void>((resolve) => {
    startedSave = resolve
  })
  await page.route(
    planPath,
    async (route) => {
      startedSave()
      await saveHeld
      await route.continue()
    },
    { times: 1 },
  )
  await dialog.getByRole('button', { name: '保存制造回复' }).click()
  await saveStarted
  await expect(
    dialog.getByRole('button', { name: '取消', exact: true }),
  ).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  releaseSave()
  await expect(dialog).toHaveCount(0)
  const detail = await service.projectDetail(users.manufacturing!, firstId)
  const processNode = detail.items.find((i) => i.trackingType === 'process')!
  assert.equal(processNode.firstCommittedDate, '2026-10-10')
  assert.equal(
    detail.items.filter(
      (i) => i.sourceType === 'MANUFACTURING' && !i.currentCommittedDate,
    ).length,
    3,
  )
  await page.getByRole('button', { name: '返回制造准备', exact: true }).click()
  await board.getByLabel('业务任务搜索').fill(marker + 'A')
  await board.getByRole('button', { name: '集中回复 ↗' }).first().click()
  await dialog.getByLabel('工艺准备承诺日期').fill('2026-10-12')
  await expect(dialog.getByLabel('工艺准备改期原因')).toBeVisible()
  const before = (
    await service.trackingHistory(users.manufacturing!, processNode.id)
  ).history.length
  await dialog.getByRole('button', { name: '保存制造回复' }).click()
  assert.equal(
    (await service.trackingHistory(users.manufacturing!, processNode.id))
      .history.length,
    before,
  )
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('工艺准备改期原因').fill('工艺评审调整')
  // Another session updates tooling while this dialog keeps its unsaved process date.
  await service.manufacturingPlan(users.manufacturing!, firstId, {
    expectedVersion: detail.plan!.version,
    toolingCommitted: '2026-10-11',
  })
  const conflict = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/projects/${firstId}/manufacturing-plan`) &&
      r.request().method() === 'PUT',
  )
  await dialog.getByRole('button', { name: '保存制造回复' }).click()
  assert.equal((await conflict).status(), 409)
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(dialog.getByLabel('工艺准备承诺日期')).toHaveValue('2026-10-12')
  await expect(dialog.getByLabel('工艺准备改期原因')).toHaveValue(
    '工艺评审调整',
  )
  await dialog.getByRole('button', { name: '刷新最新计划' }).click()
  await expect(
    dialog.getByRole('button', { name: '载入最新计划' }),
  ).toBeVisible()
  await expect(dialog.getByLabel('工艺准备承诺日期')).toHaveValue('2026-10-12')
  await dialog.getByRole('button', { name: '载入最新计划' }).click()
  await expect(dialog.getByLabel('工装准备承诺日期')).toHaveValue('2026-10-11')
  await expect(dialog.getByLabel('工艺准备承诺日期')).toHaveValue('2026-10-12')
  await dialog.getByLabel('工艺准备承诺日期').fill('2026-10-12')
  await dialog.getByLabel('工艺准备改期原因').fill('核对最新工装计划后调整工艺')
  await page.screenshot({ path: '/tmp/npi-mfg-quick-mobile.png' })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  assert.equal(
    await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    false,
  )
  await dialog.getByRole('button', { name: '保存制造回复' }).click()
  await expect(dialog).toHaveCount(0)
  const history = await service.trackingHistory(
    users.manufacturing!,
    processNode.id,
  )
  assert.equal(history.item.firstCommittedDate, '2026-10-10')
  assert.equal(history.item.currentCommittedDate, '2026-10-12')
  assert.equal(history.item.changeCount, 1)
  assert.ok(
    history.history.some((h) => h.reason === '核对最新工装计划后调整工艺'),
  )
  await service.completeItem(users.manufacturing!, processNode.id, {
    expectedVersion: (
      await service.projectDetail(users.manufacturing!, firstId)
    ).items.find((i) => i.id === processNode.id)!.version,
    actualCompleteDate: new Date(Date.now() + 8 * 3600000)
      .toISOString()
      .slice(0, 10),
  })
  await page.getByRole('button', { name: '返回制造准备', exact: true }).click()
  await board.getByLabel('业务任务搜索').fill(marker + 'A')
  await board.getByRole('button', { name: '集中回复 ↗' }).first().click()
  await expect(dialog.getByLabel('工艺准备承诺日期')).toBeDisabled()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  // An in-flight project result must not reopen its reply dialog after a navigation change.
  await nav.getByRole('button', { name: '制造准备', exact: true }).click()
  await board.getByLabel('业务任务搜索').fill(marker + 'A')
  let releaseProject!: () => void,
    startedProject!: () => void,
    finishedProject!: () => void
  const projectHeld = new Promise<void>((resolve) => {
    releaseProject = resolve
    releases.push(resolve)
  })
  const projectStarted = new Promise<void>((resolve) => {
    startedProject = resolve
  })
  const projectFinished = new Promise<void>((resolve) => {
    finishedProject = resolve
  })
  await page.route(
    `**/api/v1/npi/projects/${firstId}`,
    async (route) => {
      const response = await route.fetch()
      startedProject()
      await projectHeld
      await route.fulfill({ response })
      finishedProject()
    },
    { times: 1 },
  )
  await board.getByRole('button', { name: '集中回复 ↗' }).first().click()
  await projectStarted
  await nav.getByRole('button', { name: '新品项目', exact: true }).click()
  const deliveredResponse = page.waitForResponse((r) =>
    r.url().endsWith('/projects/' + firstId),
  )
  releaseProject()
  await projectFinished
  await (await deliveredResponse).finished()
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
  await board.getByRole('button', { name: '集中回复 ↗' }).first().click()
  await expect(dialog).toContainText(marker + 'B')
  await expect(dialog.getByLabel('工艺准备承诺日期')).toHaveValue('')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: '/tmp/npi-mfg-quick-desktop.png' })
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  const untouched = await service.projectDetail(users.manufacturing!, secondId)
  assert.equal(untouched.history.length, 0)
  // The project-level entry uses the same form and saves all four dates together.
  await page.getByRole('button', { name: '集中回复', exact: true }).click()
  const dates = {
    工艺准备: '2026-10-09',
    工装准备: '2026-10-10',
    零部件齐套: '2026-10-15',
    样机装配: '2026-10-19',
  }
  for (const [label, date] of Object.entries(dates))
    await dialog.getByLabel(label + '承诺日期').fill(date)
  await dialog.getByRole('button', { name: '保存制造回复' }).click()
  await expect(dialog).toHaveCount(0)
  const batch = await service.projectDetail(users.manufacturing!, secondId)
  assert.equal(batch.history.length, 4)
  for (const item of batch.items.filter(
    (i) => i.sourceType === 'MANUFACTURING',
  )) {
    assert.equal(
      item.currentCommittedDate,
      dates[item.name as keyof typeof dates],
    )
    assert.equal(item.firstCommittedDate, item.currentCommittedDate)
  }
  assert.equal(
    (await service.projectDetail(users.manufacturing!, firstId)).items.find(
      (i) => i.id === processNode.id,
    )!.currentCommittedDate,
    '2026-10-12',
  )
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-mfg-quick-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        oneClickDialog: true,
        partialFirstReply: true,
        fourNodeBatchFromProject: true,
        reasonRequired: true,
        historyPreserved: true,
        conflictDraftRetained: true,
        refreshBeforeExplicitReload: true,
        completedNodeReadOnly: true,
        pendingSaveCannotDismiss: true,
        lateNavigationIgnored: true,
        projectIdentityIsolation: true,
        countersPrecedeFilters: true,
        counterNodeScope: true,
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: direct mobile manufacturing reply, partial save, required reasons/history, conflict recovery, save protection, completed-node lock, fresh project identity and ignored late navigation.',
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
