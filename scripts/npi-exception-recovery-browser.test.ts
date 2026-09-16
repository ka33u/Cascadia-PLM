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
import ExcelJS from 'exceljs'
import type { Browser } from '@playwright/test'

if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw new Error('Explicit isolated _test database required')
const fixtureRecord = '/tmp/npi-exception-recovery-fixtures.json'
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
const log = fs.openSync('/tmp/npi-exception-recovery-browser-server.log', 'w')
const templates: Array<string> = []
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
        templateIds: templates,
        userIds: Object.values(users),
        cleaned: false,
      },
      null,
      2,
    ),
  )

try {
  const marker = '制造异常恢复-' + crypto.randomUUID().slice(0, 8)
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const date = (n: number) =>
    new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10)
  for (const role of ['technical', 'manufacturing', 'supervisor']) {
    const id = crypto.randomUUID()
    users[role] = id
    recordFixtures()
    await client.unsafe(
      'insert into users(id,email,name,active) values($1,$2,$3,true)',
      [id, id + '@exception.test.invalid', role],
    )
    await client.unsafe(
      'insert into npi_user_roles(user_id,role) values($1,$2)',
      [id, role],
    )
  }
  for (const suffix of ['A', 'B']) {
    const p = await service.createProject(users.technical!, {
      name: marker + suffix,
      motorModel: 'EXCEPTION-' + suffix,
      technicalOwnerId: users.technical,
      manufacturingOwnerId: users.manufacturing,
      requiredKitDate: date(10),
      prototypeRequiredDate: date(20),
    })
    projects.push(p.id)
    recordFixtures()
  }
  const { defaultTemplate } = await import('../packages/core/src/lib/npi/bom')
  const templateId = 'exception-' + crypto.randomUUID(),
    template = { ...defaultTemplate, id: templateId, name: marker + '模板' }
  templates.push(templateId)
  recordFixtures()
  await client.unsafe(
    'insert into npi_import_templates(id,name,config) values($1,$2,$3::jsonb)',
    [templateId, template.name, JSON.stringify(template)],
  )
  const importBom = async (id: string, qty = 1) => {
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet(template.sheetName)
    sheet.getCell('A4').value = 'EXCEPTION'
    sheet.getCell('B4').value = '异常测试'
    sheet.getCell('C4').value = 'SPEC'
    sheet.getRow(5).values = [
      '级别',
      '子件行号',
      '子件编码',
      '子件名称',
      '基本用量',
      '子件计量单位',
      '供应类型',
      '仓库名称',
      '领料部门名称',
    ]
    for (let n = 0; n < 25; n++)
      sheet.getRow(6 + n).values = [
        '+',
        n + 1,
        'PART-' + n,
        marker + '物料' + n,
        qty,
        '件',
        '领用',
        '测试仓',
        '制造',
      ]
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
    const preview = await service.createPreview(
      users.technical!,
      id,
      new File([new Uint8Array(bytes)], 'exception.xlsx'),
      templateId,
    )
    return service.confirmImport(users.technical!, id, {
      previewToken: preview.previewToken,
      activate: true,
    })
  }
  await importBom(projects[0]!)
  await importBom(projects[1]!)
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

  const page = await pageFor('manufacturing', 390, 844)
  const nav = page.getByRole('navigation', { name: '主导航' })
  const openProject = async (suffix: string) => {
    await nav.getByRole('button', { name: '新品项目', exact: true }).click()
    await page.getByLabel('模块项目搜索').fill(marker + suffix)
    await page.getByRole('button', { name: '项目详情 ↗', exact: true }).click()
    await page.getByRole('tab', { name: '制造准备', exact: true }).click()
  }
  const openException = async (n = 24) => {
    await page.getByRole('button', { name: '添加异常件', exact: true }).click()
    const dialog = page.getByRole('dialog', {
      name: '添加制造异常件',
      exact: true,
    })
    await expect(
      dialog.getByRole('navigation', { name: '异常件BOM分页' }),
    ).toBeVisible()
    await dialog.getByLabel('搜索异常件BOM').fill('PART-' + n)
    await dialog
      .getByRole('button', {
        name:
          '选择PART-' + n + ' ' + marker + '物料' + n + ' 第' + (6 + n) + '行',
        exact: true,
      })
      .click()
    return dialog
  }
  const endpoint = (id: string) =>
    '/api/v1/npi/projects/' + id + '/manufacturing-exceptions'
  const projectPath = (id: string) => '/api/v1/npi/projects/' + id
  const posts = new Map<string, number>()
  page.on('request', (r) => {
    if (
      r.method() === 'POST' &&
      r.url().endsWith('/manufacturing-exceptions')
    ) {
      const key = new URL(r.url()).pathname
      posts.set(key, (posts.get(key) || 0) + 1)
    }
  })
  const count = (id: string) => posts.get(endpoint(id)) || 0
  await openProject('A')
  let dialog = await openException()
  await dialog.getByLabel('预计完成日期').fill(date(6))
  await dialog.getByLabel('异常原因').fill('首报加工排程异常')
  let release!: () => void,
    started!: () => void,
    heldStatus = 0,
    routeError = ''
  const held = new Promise<void>((r) => {
      release = r
      releases.push(r)
    }),
    began = new Promise<void>((r) => {
      started = r
    })
  await page.route(
    '**' + endpoint(projects[0]!),
    async (route) => {
      try {
        const response = await route.fetch()
        heldStatus = response.status()
        started()
        await held
        await route.fulfill({ response })
      } catch (err) {
        routeError = String(err)
        started()
        await route.abort().catch(() => {})
      }
    },
    { times: 1 },
  )
  let failReads = 2
  await page.route('**' + projectPath(projects[0]!), async (route) => {
    if (failReads > 0) {
      failReads--
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'INTERNAL_ERROR',
          error: '测试刷新暂不可用',
        }),
      })
    } else await route.continue()
  })
  await dialog.getByRole('button', { name: '保存异常件', exact: true }).click()
  await began
  assert.equal(heldStatus, 200)
  assert.equal(routeError, '')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('预计完成日期')).toBeDisabled()
  await expect(
    dialog.getByRole('button', { name: '取消', exact: true }),
  ).toBeDisabled()
  release()
  await expect(dialog.getByRole('alert')).toContainText('已保存，列表刷新失败')
  await expect(
    dialog.getByRole('button', { name: '异常件已保存', exact: true }),
  ).toBeDisabled()
  const alertBox = await dialog.getByRole('alert').boundingBox()
  assert.ok(alertBox && alertBox.y >= 0 && alertBox.y + alertBox.height < 844)
  await page.screenshot({
    path: '/tmp/npi-exception-recovery-saved-mobile.png',
  })
  await dialog
    .getByRole('button', { name: '重试刷新列表', exact: true })
    .click()
  await expect(dialog.getByRole('alert')).toContainText('列表仍未刷新')
  await dialog
    .getByRole('button', { name: '重试刷新列表', exact: true })
    .click()
  await expect(dialog).toBeHidden()
  assert.equal(count(projects[0]!), 1)
  await page.unroute('**' + projectPath(projects[0]!))
  let a = await service.projectDetail(users.manufacturing!, projects[0]!)
  let tracked = a.items.find((i) => i.name === marker + '物料24')!
  assert.ok(tracked)
  assert.equal(tracked.currentCommittedDate, date(6))
  const firstId = tracked.id

  await page.setViewportSize({ width: 1440, height: 1000 })
  dialog = await openException()
  await dialog.getByLabel('预计完成日期').fill(date(9))
  await dialog.getByLabel('异常原因').fill('保留草稿并核对排程')
  await dialog.getByLabel('影响齐套').uncheck()
  await service.updatePromise(users.manufacturing!, tracked.id, {
    expectedVersion: tracked.version,
    committedDate: date(7),
    reason: '另一窗口已调整',
  })
  await dialog.getByRole('button', { name: '保存异常件', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('本次保存未确认')
  await expect(
    dialog.getByRole('button', { name: '保存异常件', exact: true }),
  ).toBeDisabled()
  await dialog.getByRole('button', { name: '重新载入BOM', exact: true }).click()
  await expect(
    dialog.getByRole('button', { name: '核对后载入最新BOM', exact: true }),
  ).toBeVisible()
  await expect(dialog).toContainText('当前承诺：' + date(7))
  await expect(dialog.getByLabel('预计完成日期')).toHaveValue(date(9))
  const acceptBox = await dialog
    .getByRole('button', { name: '核对后载入最新BOM', exact: true })
    .boundingBox()
  assert.ok(acceptBox && acceptBox.width >= 140 && acceptBox.height < 60)
  await expect(
    dialog.getByRole('button', { name: '保存异常件', exact: true }),
  ).toBeDisabled()
  await page.screenshot({
    path: '/tmp/npi-exception-recovery-review-desktop.png',
  })
  await dialog
    .getByRole('button', { name: '核对后载入最新BOM', exact: true })
    .click()
  await expect(dialog.getByLabel('影响齐套')).not.toBeChecked()
  await expect(dialog.getByLabel('异常原因')).toHaveValue('保留草稿并核对排程')
  await dialog.getByRole('button', { name: '保存异常件', exact: true }).click()
  await expect(dialog).toBeHidden()
  a = await service.projectDetail(users.manufacturing!, projects[0]!)
  tracked = a.items.find((i) => i.id === firstId)!
  assert.equal(tracked.firstCommittedDate, date(6))
  assert.equal(tracked.currentCommittedDate, date(9))
  assert.equal(tracked.affectsKit, false)
  assert.equal(a.items.filter((i) => i.name === tracked.name).length, 1)
  const history = await client.unsafe(
    'select count(*)::int as n from npi_promise_history where object_id=$1',
    [firstId],
  )
  const events = await client.unsafe(
    "select count(*)::int as n from npi_events where program_id=$1 and action='MANUFACTURING_EXCEPTION_REPORTED'",
    [projects[0]!],
  )
  assert.equal(history[0]!.n, 3)
  assert.equal(events[0]!.n, 2)

  await openProject('B')
  dialog = await openException(0)
  await dialog.getByLabel('预计完成日期').fill(date(8))
  await dialog.getByLabel('异常原因').fill('验证未知响应后查看记录')
  await page.route(
    '**' + endpoint(projects[1]!),
    async (route) => {
      const response = await route.fetch()
      assert.equal(response.status(), 200)
      await route.abort('connectionfailed')
    },
    { times: 1 },
  )
  await dialog.getByRole('button', { name: '保存异常件', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('本次保存未确认')
  assert.equal(count(projects[1]!), 1)
  await dialog.getByRole('button', { name: '重新载入BOM', exact: true }).click()
  await expect(
    dialog.getByRole('button', { name: '核对后载入最新BOM', exact: true }),
  ).toBeVisible()
  await expect(dialog).toContainText('当前承诺：' + date(8))
  await dialog
    .getByRole('button', { name: '核对后载入最新BOM', exact: true })
    .click()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  let b = await service.projectDetail(users.manufacturing!, projects[1]!)
  assert.equal(b.items.filter((i) => i.name === marker + '物料0').length, 1)
  assert.equal(count(projects[1]!), 1)

  dialog = await openException(24)
  await dialog.getByLabel('预计完成日期').fill(date(11))
  await dialog.getByLabel('异常原因').fill('换版前的异常草稿')
  const oldRows = await service.getBom(users.manufacturing!, projects[1]!)
  const oldRow = oldRows.rows.find((r) => r.materialCode === 'PART-24')!
  await importBom(projects[1]!, 2)
  await dialog.getByRole('button', { name: '保存异常件', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('本次保存未确认')
  await dialog.getByRole('button', { name: '重新载入BOM', exact: true }).click()
  await expect(dialog).toContainText('原选中物料不在当前BOM')
  await dialog
    .getByRole('button', { name: '核对后载入最新BOM', exact: true })
    .click()
  await expect(
    dialog.getByRole('button', { name: '保存异常件', exact: true }),
  ).toBeDisabled()
  await expect(dialog.getByLabel('异常原因')).toHaveValue('换版前的异常草稿')
  const sameCode = dialog.getByRole('button', {
    name: '选择PART-24 ' + marker + '物料24 第30行',
    exact: true,
  })
  await expect(sameCode).toHaveAttribute('aria-pressed', 'false')
  await page.setViewportSize({ width: 390, height: 844 })
  await sameCode.click()
  await expect(dialog.getByLabel('异常原因')).toHaveValue('')
  assert.equal(
    await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    false,
  )
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await page.screenshot({
    path: '/tmp/npi-exception-recovery-new-bom-mobile.png',
  })
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  b = await service.projectDetail(users.manufacturing!, projects[1]!)
  assert.equal(
    b.items.some((i) => i.bomItemId === oldRow.id),
    false,
  )
  const newRows = await service.getBom(users.manufacturing!, projects[1]!)
  assert.notEqual(
    newRows.rows.find((r) => r.materialCode === 'PART-24')!.id,
    oldRow.id,
  )
  const bEvents = await client.unsafe(
    "select count(*)::int as n from npi_events where program_id=$1 and action='MANUFACTURING_EXCEPTION_REPORTED'",
    [projects[1]!],
  )
  assert.equal(bEvents[0]!.n, 1)
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-exception-recovery-browser-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        savedRefreshOnly: true,
        failedReads: 2,
        closeAndDoubleWriteProtection: true,
        conflictRequiresExplicitReview: true,
        editedInputsPreserved: true,
        trackingIdRetained: true,
        firstPromisePreserved: true,
        projectAHistoryRows: 3,
        projectAExceptionEvents: 2,
        unknownResponseReviewedWithoutResubmit: true,
        bomReplacementRequiresReselection: true,
        sameCodeNeverAutoSelected: true,
        projectBExceptionEvents: 1,
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: manufacturing exception save/refresh recovery, held write close protection, explicit concurrency review, retained tracking/history, unknown response inspection and same-code BOM replacement reselection; desktop/mobile verified.',
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
  for (const id of templates)
    await client.unsafe('delete from npi_import_templates where id=$1', [id])
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
