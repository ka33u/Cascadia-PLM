// SPDX-License-Identifier: AGPL-3.0-or-later
import 'dotenv/config'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import ExcelJS from 'exceljs'
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
const log = fs.openSync('/tmp/npi-bottleneck-browser-server.log', 'w')
try {
  for (const role of ['technical', 'manufacturing']) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@bottleneck.test.invalid'},${role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role})`
  }
  const session = await SessionManager.createSession(users.technical!)
  sessions.push(session.session.id)
  const name = '齐套瓶颈定位验证'
  const project = await service.createProject(users.technical!, {
    name,
    motorModel: 'BOTTLENECK',
    technicalOwnerId: users.technical,
    manufacturingOwnerId: users.manufacturing,
    requiredKitDate: '2026-10-15',
    prototypeRequiredDate: '2026-10-20',
  })
  const first = await service.addExternal(users.technical!, project.id, {
    name: '关键机壳',
    trackingType: 'material',
    qty: '1',
    ownerId: users.manufacturing,
    requiredDate: '2026-10-15',
    affectsKit: true,
  })
  const second = await service.addExternal(users.technical!, project.id, {
    name: '待回复物料',
    trackingType: 'other',
    qty: '1',
    ownerId: users.manufacturing,
    requiredDate: '2026-10-15',
    affectsKit: true,
  })
  const promise = async (id: string, date: string) => {
    const detail = await service.projectDetail(users.technical!, project.id)
    const item = detail.items.find((i) => i.id === id)!
    await service.updatePromise(users.manufacturing!, id, {
      expectedVersion: item.version,
      committedDate: date,
      reason: '测试承诺',
    })
  }
  await promise(first.id, '2026-10-18')
  const known = await service.projectDetail(users.technical!, project.id)
  assert.equal(known.kit.bottleneck?.id, first.id)
  assert.equal(known.kit.predictionComplete, false)
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
  const openKit = async () => {
    await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name, exact: true }).click()
    await page.getByRole('tab', { name: '样机齐套', exact: true }).click()
  }
  await openKit()
  const predictionFact = page
    .locator('.npi-project-facts > div')
    .filter({ has: page.locator('dt', { hasText: '系统预测齐套' }) })
  await expect(predictionFact).toContainText('预测不完整 · 仍有关键项待回复')
  await expect(page.locator('.npi-bottleneck')).toContainText(
    '已知瓶颈（预测不完整）',
  )
  await page.getByRole('button', { name: '定位瓶颈', exact: true }).click()
  const list = page.getByRole('region', { name: '齐套物料清单', exact: true })
  await expect(list.locator('[data-npi-item]')).toHaveCount(1)
  await expect(list.locator(`[data-npi-item="${first.id}"]`)).toHaveClass(
    /npi-focused-item/,
  )
  await expect(list.getByLabel('齐套瓶颈标记')).toHaveText(
    '已知瓶颈（预测不完整）',
  )
  const waitDownload = page.waitForEvent('download')
  await list.getByRole('button', { name: '导出当前筛选（1项）' }).click()
  const file = await waitDownload
  await file.saveAs('/tmp/npi-bottleneck-export.xlsx')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(
    fs.readFileSync(
      '/tmp/npi-bottleneck-export.xlsx',
    ) as unknown as ArrayBuffer,
  )
  assert.equal(
    workbook.getWorksheet('齐套物料')!.getCell('W6').value,
    '已知瓶颈（预测不完整）',
  )
  await page.screenshot({ path: '/tmp/npi-bottleneck-material.png' })
  await page.getByRole('button', { name: '取消定位', exact: true }).click()
  await expect(list.locator('[data-npi-item]')).toHaveCount(2)
  await page.getByRole('tab', { name: '概览', exact: true }).click()
  const overview = page.getByRole('region', { name: '项目概览', exact: true })
  await expect(overview.locator('.npi-bottleneck')).toContainText(
    '已知瓶颈（预测不完整）',
  )
  await overview.locator('.npi-bottleneck').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/npi-overview-bottleneck-desktop.png' })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await overview.getByRole('button', { name: '定位瓶颈', exact: true }).click()
  await expect(
    page.getByRole('tab', { name: '样机齐套', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(list.locator('[data-npi-item]')).toHaveCount(1)
  await expect(list.locator(`[data-npi-item="${first.id}"]`)).toHaveClass(
    /npi-focused-item/,
  )
  await page.getByRole('button', { name: '取消定位', exact: true }).click()
  const nodes = known.items.filter((i) => i.sourceType === 'MANUFACTURING')
  await promise(
    nodes.find((i) => i.trackingType === 'process')!.id,
    '2026-10-10',
  )
  const tooling = nodes.find((i) => i.trackingType === 'tooling')!
  await promise(tooling.id, '2026-10-22')
  await promise(second.id, '2026-10-12')
  const current = await service.projectDetail(users.technical!, project.id)
  assert.equal(current.kit.predictionComplete, true)
  assert.equal(current.kit.bottleneck?.id, tooling.id)
  await page.setViewportSize({ width: 390, height: 844 })
  await openKit()
  await page.getByRole('tab', { name: '概览', exact: true }).click()
  await expect(overview.locator('.npi-bottleneck')).toContainText('当前瓶颈')
  await overview.locator('.npi-bottleneck').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/npi-overview-bottleneck-mobile.png' })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await expect(page.locator('.npi-bottleneck')).toContainText('当前瓶颈')
  await page.getByRole('button', { name: '定位瓶颈', exact: true }).click()
  await expect(
    page.getByRole('tab', { name: '制造准备', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  const row = page.locator(`[data-npi-item="${tooling.id}"]`)
  await expect(row).toHaveClass(/npi-focused-item/)
  await expect(row.getByLabel('齐套瓶颈标记')).toHaveText('当前瓶颈')
  await row.scrollIntoViewIfNeeded()
  await page.screenshot({
    path: '/tmp/npi-bottleneck-manufacturing-mobile.png',
  })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  // Real BOM revision fixture: all key dates are present, but old tracking needs review.
  const { defaultTemplate } = await import('../packages/core/src/lib/npi/bom')
  const templateId = `prediction-${crypto.randomUUID()}`
  const template = { ...defaultTemplate, id: templateId, name: templateId }
  await client`insert into npi_import_templates(id,name,config) values(${templateId},${templateId},${JSON.stringify(template)}::jsonb)`
  const bom = new ExcelJS.Workbook(),
    sheet = bom.addWorksheet(template.sheetName)
  sheet.getCell('A4').value = 'PREDICTION'
  sheet.getCell('B4').value = '预测完整性测试'
  sheet.getCell('C4').value = 'MODEL'
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
    'P001',
    '换版关键件',
    1,
    '件',
    '领用',
    '测试仓',
    '制造',
  ]
  const importVersion = async () => {
    const bytes = new Uint8Array(await bom.xlsx.writeBuffer())
    const preview = await service.createPreview(
      users.technical!,
      project.id,
      new File([bytes], 'prediction.xlsx'),
      templateId,
    )
    assert.ok(preview.previewToken)
    return service.confirmImport(users.technical!, project.id, {
      previewToken: preview.previewToken,
      activate: true,
    })
  }
  const firstImport = await importVersion()
  const [bomItem] =
    await client`select id from npi_bom_items where import_id=${firstImport.importId}`
  assert.ok(bomItem)
  const tracked = await service.setTracking(users.technical!, bomItem.id, {
    ownerId: users.manufacturing,
    requiredDate: '2026-10-15',
    trackingEnabled: true,
    affectsKit: true,
    expectedVersion: 0,
  })
  await promise(tracked.trackingItemId, '2026-10-24')
  sheet.getCell('E6').value = 2
  await importVersion()
  const review = await service.projectDetail(users.technical!, project.id)
  assert.equal(review.kit.predictionComplete, false)
  assert.ok(review.kit.alerts.some((a) => a.code === 'BOM_REVIEW_PENDING'))
  assert.ok(!review.kit.alerts.some((a) => a.code === 'PENDING_REPLY'))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openKit()
  await expect(predictionFact).toContainText('预测不完整 · BOM换版待复核')
  await expect(predictionFact).not.toContainText('关键项待回复')
  await expect(page.locator('.npi-bottleneck')).toContainText(
    '已知瓶颈（预测不完整）',
  )
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: '/tmp/npi-prediction-review-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await predictionFact.scrollIntoViewIfNeeded()
  await expect(predictionFact).toContainText('BOM换版待复核')
  await page.screenshot({ path: '/tmp/npi-prediction-review-mobile.png' })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-bottleneck-browser-result.json',
    JSON.stringify(
      {
        passed: true,
        knownMaterialFocus: true,
        cancelFocus: true,
        exportLabel: true,
        manufacturingFocus: true,
        overviewMaterialFocus: true,
        overviewManufacturingFocus: true,
        overviewOverflow: false,
        headerPendingReplyNote: true,
        headerBomReviewNote: true,
        realBomRevisionFixture: true,
        mobileOverflow: false,
        pageErrors: errors,
        applicationRoot: appRoot,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: known material focus/mark/export, cancel focus, overview material and manufacturing focus on mobile, no overflow or page errors.',
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
