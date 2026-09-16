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
const log = fs.openSync('/tmp/npi-navigation-browser-server.log', 'w')
const projects: Array<string> = [],
  templates: Array<string> = []
const errors: Array<string> = []
try {
  const marker = `nav-${crypto.randomUUID().slice(0, 8)}`
  for (const role of [
    'admin',
    'technical',
    'manufacturing',
    'procurement',
    'supervisor',
    'otherBuyer',
  ]) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@navigation.test.invalid'},${marker + ' ' + role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role === 'otherBuyer' ? 'procurement' : role})`
  }
  for (let i = 1; i <= 26; i++) {
    const p = await service.createProject(users.technical!, {
      name: marker + ' 项目' + String(i).padStart(2, '0'),
      motorModel: 'NAV-' + i,
      technicalOwnerId: users.technical,
      manufacturingOwnerId: users.manufacturing,
      requiredKitDate: '2026-10-15',
      prototypeRequiredDate: '2026-10-20',
    })
    projects.push(p.id)
  }
  const projectId = projects[0]!,
    completedId = projects[1]!
  const primary = await service.projectDetail(users.technical!, projectId)
  await client`update npi_tracking_items set actual_complete_date='2026-10-19' where program_id=${completedId} and tracking_type='assembly'`
  await client`update npi_projects set current_npi_stage='completed' where program_id=${completedId}`
  const purchase = await service.addExternal(users.technical!, projectId, {
    name: marker + ' 采购轴承',
    trackingType: 'purchase',
    qty: '2',
    ownerId: users.procurement,
    requiredDate: '2026-10-15',
    affectsKit: true,
  })
  await service.addExternal(users.technical!, projectId, {
    name: marker + ' 他人采购件',
    trackingType: 'purchase',
    qty: '1',
    ownerId: users.otherBuyer,
    requiredDate: '2026-10-15',
    affectsKit: true,
  })
  await service.addExternal(users.technical!, projectId, {
    name: marker + ' 制造机壳',
    trackingType: 'material',
    qty: '1',
    ownerId: users.manufacturing,
    requiredDate: '2026-10-15',
    affectsKit: true,
  })
  const { defaultTemplate } = await import('../packages/core/src/lib/npi/bom')
  const templateId = marker + '-template',
    template = { ...defaultTemplate, id: templateId, name: marker + ' 模板' }
  templates.push(templateId)
  await client`insert into npi_import_templates(id,name,config) values(${templateId},${template.name},${JSON.stringify(template)}::jsonb)`
  const workbook = new ExcelJS.Workbook(),
    sheet = workbook.addWorksheet(template.sheetName)
  sheet.getCell('A4').value = 'NAV-MOTHER'
  sheet.getCell('B4').value = '导航样机'
  sheet.getCell('C4').value = 'NAV-1'
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
  sheet.getRow(6).values = [
    '+',
    10,
    'NAV001',
    marker + ' BOM定子',
    1,
    '件',
    '领用',
    '测试仓',
    '制造',
  ]
  const preview = await service.createPreview(
    users.technical!,
    projectId,
    new File(
      [new Uint8Array(await workbook.xlsx.writeBuffer())],
      'navigation.xlsx',
    ),
    templateId,
  )
  assert.ok(preview.previewToken)
  await service.confirmImport(users.technical!, projectId, {
    previewToken: preview.previewToken,
    activate: true,
  })
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
  const pageFor = async (role: string) => {
    const session = await SessionManager.createSession(users[role]!)
    sessions.push(session.session.id)
    const context = await browser!.newContext({
      viewport: { width: 1440, height: 1000 },
    })
    context.setDefaultTimeout(20000)
    await context.addCookies([
      { name: 'session', value: session.sessionToken, url: base },
    ])
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
    await expect(
      page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('button')
        .first(),
    ).toBeVisible()
    return page
  }
  const page = await pageFor('admin'),
    nav = page.getByRole('navigation', { name: '主导航' })
  const labels = [
    '首页',
    '新品项目',
    'BOM管理',
    '制造准备',
    '采购管理',
    '报表看板',
    '基础数据',
    '系统设置',
  ]
  await expect(nav.getByRole('button')).toHaveText(labels)
  await expect(
    page.getByRole('heading', { name: '新品驾驶舱', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: '承诺改期任务', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('region', { name: '项目进度列表', exact: true }),
  ).toBeVisible()
  await page.screenshot({ path: '/tmp/npi-navigation-home-desktop.png' })
  await nav.getByRole('button', { name: '新品项目', exact: true }).click()
  const library = page.getByRole('region', { name: '新品项目目录' })
  await library.getByLabel('模块项目搜索').fill(marker)
  await expect(library.locator('tbody tr')).toHaveCount(25)
  await library
    .getByRole('navigation', { name: '项目目录分页' })
    .getByRole('button', { name: '下一页' })
    .click()
  await expect(library.locator('tbody tr')).toHaveCount(1)
  await library.getByLabel('模块项目阶段').selectOption('completed')
  await expect(library.locator('tbody tr')).toHaveCount(1)
  await expect(library).toContainText('项目02')
  await library.getByLabel('模块项目阶段').selectOption('all')
  await library.getByLabel('模块项目搜索').fill(primary.name)
  await library.getByRole('button', { name: '项目详情 ↗' }).click()
  await expect(
    page.getByRole('tab', { name: '概览', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    nav.getByRole('button', { name: '新品项目', exact: true }),
  ).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: '返回新品项目', exact: true }).click()
  await nav.getByRole('button', { name: 'BOM管理', exact: true }).click()
  const bom = page.getByRole('region', { name: '项目BOM管理' })
  await bom.getByLabel('模块项目搜索').fill(marker)
  await bom.getByLabel('项目BOM状态').selectOption('imported')
  await expect(bom.locator('tbody tr')).toHaveCount(1)
  await expect(bom).toContainText('V1 · 1项')
  await page.screenshot({ path: '/tmp/npi-navigation-bom-desktop.png' })
  await bom.getByRole('button', { name: '进入BOM ↗' }).click()
  await expect(
    page.getByRole('tab', { name: 'ERP BOM', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    page.getByText(marker + ' BOM定子', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '返回BOM管理', exact: true }).click()
  await bom.getByLabel('模块项目搜索').fill(primary.name)
  await bom.getByLabel('项目BOM状态').selectOption('missing')
  await expect(bom.locator('tbody tr')).toHaveCount(0)
  await nav.getByRole('button', { name: '制造准备', exact: true }).click()
  const prep = page.getByRole('region', { name: '制造四节点任务' })
  await prep.getByLabel('业务任务搜索').fill(primary.name)
  await expect(prep.locator('tbody tr')).toHaveCount(4)
  await expect(prep).not.toContainText('采购轴承')
  await expect(
    page.getByRole('region', { name: '项目进度列表', exact: true }),
  ).toHaveCount(0)
  await prep.getByLabel('制造节点筛选').selectOption('process')
  await expect(prep.locator('tbody tr')).toHaveCount(1)
  await prep.getByLabel('仅本人负责').check()
  await expect(prep.locator('tbody tr')).toHaveCount(0)
  await prep.getByLabel('仅本人负责').uncheck()
  await prep.getByLabel('制造节点筛选').selectOption('all')
  await page.screenshot({
    path: '/tmp/npi-navigation-manufacturing-desktop.png',
  })
  await prep.getByRole('button', { name: '集中回复 ↗' }).first().click()
  await expect(page.getByRole('dialog')).toContainText('集中回复制造四节点')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '取消', exact: true })
    .click()
  await nav.getByRole('button', { name: '采购管理', exact: true }).click()
  const purchasing = page.getByRole('region', { name: '采购物料任务' })
  await purchasing.getByLabel('业务任务搜索').fill(primary.name)
  await expect(purchasing.locator('tbody tr')).toHaveCount(2)
  await expect(purchasing).not.toContainText('制造机壳')
  await purchasing
    .locator('tbody tr')
    .filter({ hasText: '采购轴承' })
    .getByRole('button', { name: '查看采购物料 ↗' })
    .click()
  await expect(
    page.getByRole('tab', { name: '样机齐套', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator(`[data-npi-item="${purchase.id}"]`)).toHaveClass(
    /npi-focused-item/,
  )
  await nav.getByRole('button', { name: '报表看板', exact: true }).click()
  const reports = page.getByRole('region', { name: '新品报表', exact: true })
  await expect(
    reports.getByRole('region', { name: '承诺改期任务', exact: true }),
  ).toBeVisible()
  await reports.getByLabel('报表项目搜索').fill(marker)
  await reports.getByLabel('报表阶段范围').selectOption('completed')
  await expect(
    reports.getByRole('row').filter({ hasText: marker + ' 项目02' }),
  ).toContainText('按期完成')
  await reports.getByLabel('报表阶段范围').selectOption('design')
  await expect(
    reports.getByRole('row').filter({ hasText: marker + ' 项目02' }),
  ).toHaveCount(0)
  await page.screenshot({ path: '/tmp/npi-navigation-reports-desktop.png' })
  await nav.getByRole('button', { name: '基础数据', exact: true }).click()
  await page.getByLabel('搜索导入模板').fill(marker)
  await expect(
    page.getByRole('region', { name: '导入模板管理' }),
  ).toContainText(template.name)
  await expect(page.getByRole('region', { name: '业务岗位管理' })).toHaveCount(
    0,
  )
  await expect(
    page.getByRole('region', { name: '业务基础定义' }),
  ).toContainText('零部件齐套')
  await page.getByRole('button', { name: '编辑映射', exact: true }).click()
  await expect(
    page.getByRole('dialog').getByLabel('模板名称', { exact: true }),
  ).toHaveValue(template.name)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '取消', exact: true })
    .click()
  await nav.getByRole('button', { name: '系统设置', exact: true }).click()
  await page.getByLabel('搜索岗位人员').fill(marker)
  await expect(
    page
      .getByRole('region', { name: '业务岗位管理' })
      .getByRole('button', { name: '分配岗位' }),
  ).toHaveCount(6)
  await expect(page.getByRole('button', { name: '新建导入模板' })).toHaveCount(
    0,
  )
  await expect(page.getByRole('region', { name: '导入模板管理' })).toHaveCount(
    0,
  )
  await page.setViewportSize({ width: 1280, height: 640 })
  await page
    .getByRole('link', { name: /Cascadia 系统管理/ })
    .scrollIntoViewIfNeeded()
  await expect(
    page.getByRole('link', { name: /Cascadia 系统管理/ }),
  ).toBeInViewport()
  await nav.getByRole('button', { name: '首页', exact: true }).click()
  await expect(
    nav.getByRole('button', { name: '首页', exact: true }),
  ).toBeInViewport()
  await page.setViewportSize({ width: 390, height: 844 })
  for (const label of labels) {
    await nav.getByRole('button', { name: label, exact: true }).click()
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
      `${label} mobile overflow`,
    )
  }
  await page.screenshot({ path: '/tmp/npi-navigation-settings-mobile.png' })
  await nav.getByRole('button', { name: '制造准备', exact: true }).click()
  await page.getByLabel('业务任务搜索').fill(primary.name)
  await page.screenshot({
    path: '/tmp/npi-navigation-manufacturing-mobile.png',
  })
  const mfg = await pageFor('manufacturing')
  await expect(
    mfg.getByRole('navigation', { name: '主导航' }).getByRole('button'),
  ).toHaveText(labels.slice(0, 6))
  await expect(
    mfg.getByRole('heading', { name: '制造准备', exact: true }),
  ).toBeVisible()
  const mfgPrep = mfg.getByRole('region', { name: '制造四节点任务' })
  await expect(mfgPrep.getByLabel('仅本人负责')).toBeChecked()
  await mfgPrep.getByLabel('业务任务搜索').fill(primary.name)
  await expect(mfgPrep.locator('tbody tr')).toHaveCount(4)
  const supervisor = await pageFor('supervisor')
  await expect(
    supervisor.getByRole('navigation', { name: '主导航' }).getByRole('button'),
  ).toHaveText(labels.slice(0, 6))
  await supervisor
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '制造准备', exact: true })
    .click()
  await supervisor.getByLabel('业务任务搜索').fill(primary.name)
  await expect(
    supervisor.getByRole('button', { name: '集中回复 ↗' }),
  ).toHaveCount(0)
  await supervisor
    .getByRole('button', { name: '查看制造准备 ↗' })
    .first()
    .click()
  await expect(
    supervisor.getByRole('button', { name: '集中回复', exact: true }),
  ).toHaveCount(0)
  const buyer = await pageFor('procurement')
  await expect(
    buyer.getByRole('navigation', { name: '主导航' }).getByRole('button'),
  ).toHaveText(['采购管理'])
  await expect(
    buyer.getByRole('heading', { name: '我的采购任务', exact: true }),
  ).toBeVisible()
  await expect(
    buyer.getByText(marker + ' 采购轴承', { exact: true }).first(),
  ).toBeVisible()
  await expect(
    buyer.getByText(marker + ' 他人采购件', { exact: true }),
  ).toHaveCount(0)
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-navigation-browser-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        adminModules: labels,
        projectPagination: true,
        bomDeepLinkLoadsRows: true,
        fourNodeFilters: true,
        purchaseFocus: true,
        reportStageFilter: true,
        separateSettings: true,
        roleScope: true,
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: eight distinct modules, project pagination/filtering, BOM destination/loading, four-node task filters and reply entry, procurement item focus, reports/settings, role scope and all mobile modules.',
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
  for (const id of templates)
    await client`delete from npi_import_templates where id=${id}`
  for (const id of Object.values(users)) {
    await client`delete from npi_events where actor_id=${id} and program_id is null`
    await client`delete from users where id=${id}`
  }
  await client.end({ timeout: 5 })
}
