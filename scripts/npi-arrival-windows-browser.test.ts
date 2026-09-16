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
const fixtureRecord = '/tmp/npi-arrival-windows-fixtures.json'
if (
  fs.existsSync(fixtureRecord) &&
  !JSON.parse(fs.readFileSync(fixtureRecord, 'utf8')).cleaned
)
  throw Error('Previous arrival fixtures need cleanup')
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
const log = fs.openSync('/tmp/npi-arrival-windows-browser-server.log', 'w')
const projects: Array<string> = []
const releases: Array<() => void> = []
const errors: Array<string> = []
const appRoot = process.env.NPI_BROWSER_APP_ROOT || process.cwd()
const recordFixtures = () =>
  fs.writeFileSync(
    fixtureRecord,
    JSON.stringify(
      {
        ownerPid: process.pid,
        applicationRoot: appRoot,
        projectIds: projects,
        userIds: Object.values(users),
        cleaned: false,
      },
      null,
      2,
    ),
  )

try {
  const marker = '到货范围-' + crypto.randomUUID().slice(0, 8)
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const date = (n: number) =>
    new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10)
  for (const role of [
    'technical',
    'manufacturing',
    'procurement',
    'buyer2',
    'supervisor',
  ]) {
    const id = crypto.randomUUID()
    users[role] = id
    recordFixtures()
    await client.unsafe(
      'insert into users(id,email,name,active) values($1,$2,$3,true)',
      [
        id,
        id + '@arrival.test.invalid',
        role === 'buyer2' || role === 'procurement' ? '同名采购' : role,
      ],
    )
    await client.unsafe(
      'insert into npi_user_roles(user_id,role) values($1,$2)',
      [id, role === 'buyer2' ? 'procurement' : role],
    )
  }
  for (const suffix of ['A', 'B']) {
    const p = await service.createProject(users.technical!, {
      name: marker + suffix,
      motorModel: 'ARRIVAL-' + suffix,
      technicalOwnerId: users.technical,
      manufacturingOwnerId: users.manufacturing,
      requiredKitDate: date(20),
      prototypeRequiredDate: date(30),
    })
    projects.push(p.id)
    recordFixtures()
  }
  const fixtures: Array<{
    id: string
    name: string
    owner: string
    offset: number | null
    completed: boolean
  }> = []
  const make = async (
    label: string,
    offset: number | null,
    owner = 'procurement',
    completed = false,
  ) => {
    const item = await service.addExternal(
      users.technical!,
      projects[owner === 'buyer2' ? 1 : 0]!,
      {
        name: marker + '-' + label,
        qty: '1',
        unit: '件',
        requiredDate: date(label === '风险七日' ? 1 : 20),
        ownerId: users[owner],
        affectsKit: true,
      },
    )
    let version = item.version
    if (offset !== null) {
      const updated = await service.updatePromise(users[owner]!, item.id, {
        expectedVersion: version,
        committedDate: date(offset),
      })
      version = updated.version
    }
    if (completed)
      await service.completeItem(users[owner]!, item.id, {
        expectedVersion: version,
        actualCompleteDate: day,
      })
    fixtures.push({
      id: item.id,
      name: marker + '-' + label,
      owner,
      offset,
      completed,
    })
  }
  for (let n = 0; n < 30; n++)
    await make('常规' + String(n).padStart(2, '0'), n % 8)
  await make('风险七日', 7)
  await make('八日', 8)
  await make('十四日', 14)
  await make('十五日', 15)
  await make('昨日', -1)
  await make('未承诺', null)
  await make('已到货', 0, 'procurement', true)
  await make('采购二今日', 0, 'buyer2')
  await make('采购二十四日', 14, 'buyer2')
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
    await page.goto(base + '/npi', { waitUntil: 'networkidle' })
    return page
  }

  const purchase = await pageFor('procurement', 390, 844)
  const list = purchase.getByRole('region', { name: '我的采购件清单' })
  await expect(list.locator('tbody tr')).toHaveCount(25)
  const matching = (owner: string, max: number) =>
    fixtures.filter(
      (i) =>
        i.owner === owner &&
        !i.completed &&
        i.offset !== null &&
        i.offset >= 0 &&
        i.offset <= max,
    )
  const allNames = async (
    page: typeof purchase,
    region: typeof list,
    label: string,
  ) => {
    const result: Array<string> = []
    for (let n = 0; n < 5; n++) {
      result.push(
        ...(await region
          .locator('tbody tr td:first-child strong')
          .allTextContents()),
      )
      const pager = page.getByRole('navigation', { name: label, exact: true })
      if (!(await pager.count())) break
      const next = pager.getByRole('button', { name: '下一页', exact: true })
      if (await next.isDisabled()) break
      await next.click()
    }
    return result
  }
  const assertOrder = (names: Array<string>) => {
    const offsets = names.map((name) => {
      const f = fixtures.find((i) => i.name === name)
      assert.ok(f && f.offset !== null)
      return f.offset
    })
    assert.deepEqual(
      offsets,
      [...offsets].sort((a, b) => a - b),
    )
  }
  await purchase.getByLabel('采购筛选').selectOption('7')
  await expect(list).toContainText(day + ' 至 ' + date(7))
  const seven = await allNames(purchase, list, '采购清单分页')
  assert.deepEqual(
    [...seven].sort(),
    matching('procurement', 7)
      .map((i) => i.name)
      .sort(),
  )
  assertOrder(seven)
  await purchase.getByLabel('采购筛选').selectOption('14')
  const fourteen = await allNames(purchase, list, '采购清单分页')
  assert.deepEqual(
    [...fourteen].sort(),
    matching('procurement', 14)
      .map((i) => i.name)
      .sort(),
  )
  assertOrder(fourteen)
  await purchase.getByLabel('搜索我的采购件').fill(marker + '-风险七日')
  await expect(list.locator('tbody tr')).toHaveCount(1)
  await expect(list).toContainText(marker + '-风险七日')
  await purchase.getByLabel('搜索我的采购件').fill('')
  await expect(
    purchase.getByRole('navigation', { name: '采购清单分页', exact: true }),
  ).toContainText('第1/2页')
  await purchase.getByLabel('采购筛选').selectOption('today')
  const todays = matching('procurement', 0)
  await expect(list.locator('tbody tr')).toHaveCount(todays.length)
  await list
    .locator('tbody tr')
    .filter({ hasText: todays[0]!.name })
    .getByRole('button', { name: '到货', exact: true })
    .click()
  const dialog = purchase.getByRole('dialog', { name: '确认到货', exact: true })
  await dialog.getByRole('button', { name: '保存到货', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(purchase.getByLabel('采购筛选')).toHaveValue('today')
  await expect(list.locator('tbody tr')).toHaveCount(todays.length - 1)
  todays[0]!.completed = true
  assert.equal(
    await purchase.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await list.scrollIntoViewIfNeeded()
  await purchase.screenshot({
    path: '/tmp/npi-arrival-windows-personal-mobile.png',
  })

  const manager = await pageFor('technical', 1440, 1000)
  await manager
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '采购管理', exact: true })
    .click()
  const board = manager.getByRole('region', { name: '采购物料任务' })
  await manager.getByLabel('业务任务搜索').fill(marker)
  const owner = manager.getByLabel('采购责任人筛选')
  await expect(owner.locator('option')).toHaveCount(3)
  await expect(owner).toContainText(
    users.procurement! + '@arrival.test.invalid',
  )
  await expect(owner).toContainText(users.buyer2! + '@arrival.test.invalid')
  await owner.selectOption(users.procurement!)
  await manager.getByLabel('采购到货范围').selectOption('7')
  const managed = await allNames(manager, board, '业务任务分页')
  assert.deepEqual(
    [...managed].sort(),
    matching('procurement', 7)
      .map((i) => i.name)
      .sort(),
  )
  assertOrder(managed)
  await manager.getByLabel('业务任务状态').selectOption('risk')
  await expect(board.locator('tbody tr')).toHaveCount(1)
  await expect(board).toContainText(marker + '-风险七日')
  await manager
    .getByRole('button', { name: '清除采购条件', exact: true })
    .click()
  await expect(manager.getByLabel('业务任务状态')).toHaveValue('risk')
  await expect(manager.getByLabel('业务任务搜索')).toHaveValue(marker)
  await expect(owner).toHaveValue('all')
  await expect(manager.getByLabel('采购到货范围')).toHaveValue('all')
  await manager.getByLabel('业务任务状态').selectOption('all')
  await owner.selectOption(users.buyer2!)
  await manager.getByLabel('采购到货范围').selectOption('14')
  await expect(board.locator('tbody tr')).toHaveCount(2)
  await manager.screenshot({
    path: '/tmp/npi-arrival-windows-manager-desktop.png',
  })
  await manager.setViewportSize({ width: 390, height: 844 })
  await manager.getByLabel('采购到货范围').selectOption('today')
  await expect(board.locator('tbody tr')).toHaveCount(1)
  assert.equal(
    await manager.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await owner.scrollIntoViewIfNeeded()
  for (const width of [320, 390]) {
    await manager.setViewportSize({ width, height: 844 })
    await owner.scrollIntoViewIfNeeded()
    const layout = await board.evaluate((el) => {
      const select = el.querySelector('[aria-label="采购责任人筛选"]')!
      const box = select.getBoundingClientRect()
      return {
        overflow: el.scrollWidth > el.clientWidth + 1,
        scrolled: el.scrollLeft !== 0,
        controlOutside: box.left < 0 || box.right > innerWidth,
      }
    })
    assert.deepEqual(layout, {
      overflow: false,
      scrolled: false,
      controlOutside: false,
    })
  }
  await board.locator('.npi-module-filters').scrollIntoViewIfNeeded()
  await manager.screenshot({
    path: '/tmp/npi-arrival-windows-manager-mobile.png',
  })
  const focus = fixtures.find((i) => i.owner === 'buyer2' && i.offset === 0)!
  await board
    .getByRole('button', { name: '查看采购物料 ↗', exact: true })
    .click()
  await expect(
    manager.getByRole('tab', { name: '样机齐套', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    manager.locator('[data-npi-item="' + focus.id + '"]'),
  ).toBeVisible()

  const supervisor = await pageFor('supervisor', 1440, 1000)
  let writes = 0
  supervisor.on('request', (r) => {
    if (
      r.url().includes('/api/v1/npi/') &&
      !['GET', 'HEAD'].includes(r.method())
    )
      writes++
  })
  await supervisor
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '采购管理', exact: true })
    .click()
  await supervisor.getByLabel('业务任务搜索').fill(marker)
  await supervisor.getByLabel('采购责任人筛选').selectOption(users.buyer2!)
  await supervisor.getByLabel('采购到货范围').selectOption('today')
  const readOnly = supervisor.getByRole('region', { name: '采购物料任务' })
  await expect(readOnly.locator('tbody tr')).toHaveCount(1)
  await readOnly
    .getByRole('button', { name: '查看采购物料 ↗', exact: true })
    .click()
  await expect(
    supervisor.getByRole('tab', { name: '样机齐套', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  for (const name of ['到货', '改期', '调整计划'])
    await expect(
      supervisor.getByRole('button', { name, exact: true }),
    ).toHaveCount(0)
  assert.equal(writes, 0)
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-arrival-windows-browser-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        businessDay: day,
        fixtureItems: fixtures.length,
        sevenDayRows: seven.length,
        fourteenDayRows: fourteen.length,
        dateSorting: true,
        wholeResultPagingAndSearch: true,
        todayReceiptRefresh: true,
        exactOwnerIdentity: true,
        combinedStatusOwnerWindowQuery: true,
        clearRetainsOtherFilters: true,
        technicalProjectScope: true,
        materialDrilldown: true,
        supervisorWrites: writes,
        mobileOverflow: false,
        mobilePanelAndControlsOverflow: false,
        mobileWidths: [320, 390],
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: arrival today/7/14 boundaries and ordering, personal paging/search/receipt refresh, manager exact owner and combined filters, material focus, supervisor read-only and mobile layouts.',
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
