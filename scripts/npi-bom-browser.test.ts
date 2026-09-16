// SPDX-License-Identifier: AGPL-3.0-or-later
// Actual browser + actual API + isolated test database. No production data writes.
import 'dotenv/config'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import ExcelJS from 'exceljs'
import postgres from 'postgres'
import type { BrowserContext, Page } from '@playwright/test'

if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw new Error('Explicit _test database required')
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
process.env.VAULT_ROOT = fs.mkdtempSync('/tmp/npi-files-browser-')
process.env.VAULT_TYPE = 'local'
const { SessionManager } = await import('../packages/core/src/lib/auth/session')
const { db, migrationClient } = await import('../packages/core/src/lib/db')
const client = postgres(process.env.TEST_DATABASE_URL)
const { SettingsService, SettingKeys } =
  await import('../packages/core/src/lib/config/SettingsService')
if (await SettingsService.getValue(SettingKeys.VAULT_ROOT))
  throw new Error('Test DB must have no Vault override')
const root = 'http://localhost:3414'
const accounts: Record<string, { id: string; token: string }> = {}
for (const role of [
  'technical',
  'manufacturing',
  'procurement',
  'supervisor',
  'otherBuyer',
  'nextTech',
  'nextMfg',
  'admin',
]) {
  const id = crypto.randomUUID()
  await client`insert into users(id,email,name,active) values(${id},${`${id}@browser.test.invalid`},${`浏览器-${role}`},true)`
  await client`insert into npi_user_roles(user_id,role) values(${id},${role === 'otherBuyer' ? 'procurement' : role === 'nextTech' ? 'technical' : role === 'nextMfg' ? 'manufacturing' : role})`
  const session = await SessionManager.createSession(id)
  accounts[role] = { id, token: session.sessionToken }
}
const log = fs.openSync('/tmp/npi-bom-browser-server.log', 'w')
const dev = spawn(process.execPath, ['.output/cascadia/server/index.mjs'], {
  detached: true,
  stdio: ['ignore', log, log],
  env: {
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    PORT: '3414',
    APP: 'cascadia',
    BASE_URL: root,
    HOST: '127.0.0.1',
  },
})
const browserServer = await chromium.launchServer({
  channel: 'chrome',
  headless: true,
  host: '127.0.0.1',
})
const browser = await chromium.connect(browserServer.wsEndpoint())
const contexts: Array<BrowserContext> = []
const errors: Array<string> = []
let failed = false
const name = `换版浏览器验证-${Date.now()}`
async function pageFor(role: string, mobile = false) {
  const ctx = await browser.newContext({
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
  })
  ctx.setDefaultTimeout(20000)
  ctx.setDefaultNavigationTimeout(60000)
  contexts.push(ctx)
  await ctx.addCookies([
    { name: 'session', value: accounts[role]!.token, url: root },
  ])
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(root + '/npi', { waitUntil: 'domcontentloaded' })
  await page
    .getByRole('heading', {
      name: ['procurement', 'otherBuyer'].includes(role)
        ? '我的采购件'
        : ['manufacturing', 'nextMfg'].includes(role)
          ? '制造准备'
          : '新品驾驶舱',
      exact: true,
    })
    .waitFor()
  return page
}
async function openProjectDirectory(page: Page, projectName: string) {
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '新品项目', exact: true })
    .click()
  const directory = page.getByRole('region', {
    name: '新品项目目录',
    exact: true,
  })
  await directory.getByLabel('模块项目搜索', { exact: true }).fill(projectName)
  await directory
    .getByRole('row')
    .filter({ hasText: projectName })
    .getByRole('button', { name: '项目详情 ↗', exact: true })
    .click()
}
async function saved(page: Page) {
  await page.bringToFront()
  await expect(
    page
      .getByRole('dialog')
      .getByRole('button', { name: /^保存(?:回复|到货)?$/ }),
  ).toHaveCSS('background-color', 'rgb(35, 98, 217)')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^保存(?:回复|到货)?$/ })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20000 })
}
async function detail(page: Page, id: string) {
  const response = await page.request.get(root + '/api/v1/npi/projects/' + id)
  assert.equal(response.status(), 200)
  return response.json()
}
const attachmentPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n',
)
const attachmentPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=',
  'base64',
)
async function uploadAttachment(page: Page, title: string, photo = false) {
  const region = page.getByRole('region', { name: '附件资料' })
  await region.getByLabel('资料标题', { exact: true }).fill(title)
  await region.getByLabel('选择文件或照片', { exact: true }).setInputFiles({
    name: photo ? '照片.png' : '规格.pdf',
    mimeType: photo ? 'image/png' : 'application/pdf',
    buffer: photo ? attachmentPng : attachmentPdf,
  })
  await region.getByRole('button', { name: '上传资料', exact: true }).click()
  await expect(region.getByText(title, { exact: true })).toBeVisible()
  const card = region.locator('article').filter({ hasText: title })
  const href = await card
    .getByRole('link', { name: '下载文件', exact: true })
    .getAttribute('href')
  const download = await page.request.get(root + href)
  assert.equal(download.status(), 200)
  assert.deepEqual(await download.body(), photo ? attachmentPng : attachmentPdf)
  if (photo)
    await expect(card.getByRole('img')).toHaveJSProperty('naturalWidth', 1)
}
async function workbook(code: string, line = 10, qty = 1) {
  const w = new ExcelJS.Workbook(),
    s = w.addWorksheet('母件结构表-多阶')
  s.getCell('A4').value = 'BROWSER-MOTOR'
  s.getCell('B4').value = '浏览器测试电机'
  s.getCell('C4').value = 'TEST'
  s.getRow(5).values = [
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
  s.getRow(6).values = [
    '+',
    line,
    code,
    '浏览器关键轴承',
    qty,
    '只',
    '采购',
    '采购库',
    '采购',
  ]
  return Buffer.from(await w.xlsx.writeBuffer())
}
async function importBom(
  page: Page,
  data: Buffer,
  filename = 'browser-bom.xlsx',
  templateId = 'erp-multilevel-v1',
) {
  await page.bringToFront()
  await page.getByLabel('导入模板', { exact: true }).selectOption(templateId)
  await page.getByLabel('上传ERP BOM', { exact: true }).setInputFiles({
    name: filename,
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: data,
  })
  await page.getByRole('button', { name: '解析预览', exact: true }).click()
  await page
    .getByRole('button', { name: '下一步：解析确认', exact: true })
    .click()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: '/tmp/npi-ui-bom-confirmation.png',
    fullPage: true,
  })
  await page
    .getByRole('button', { name: '确认导入为新版本', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: '确认导入为新版本', exact: true }),
  ).toHaveCount(0)
  await expect(page.getByLabel('BOM版本', { exact: true })).not.toHaveValue('')
}
try {
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (dev.exitCode !== null)
      throw new Error('Test server exited; see /tmp/npi-bom-browser-server.log')
    try {
      const r = await fetch(root + '/api/v1/npi/meta', {
        headers: { cookie: `session=${accounts.technical!.token}` },
        signal: AbortSignal.timeout(1500),
      })
      if (r.ok && (await r.json()).actor.id === accounts.technical!.id) {
        ready = true
        break
      }
    } catch {
      /* Startup only. */
    }
    await delay(500)
  }
  assert.ok(ready, 'Isolated test server not ready')
  console.log('Ready: built server on isolated test database')
  const notices = fs.readFileSync('dist/cascadia/THIRD-PARTY-NOTICES.txt')
  assert.deepEqual(
    fs.readFileSync('.output/cascadia/THIRD-PARTY-NOTICES.txt'),
    notices,
  )
  assert.match(notices.toString(), /THIRD-PARTY SOFTWARE NOTICES/)
  const servedNotices = await fetch(root + '/THIRD-PARTY-NOTICES.txt')
  assert.equal(servedNotices.status, 200)
  assert.match(servedNotices.headers.get('content-type') || '', /text\/plain/)
  assert.deepEqual(Buffer.from(await servedNotices.arrayBuffer()), notices)
  console.log(
    'PASS: full-build license notices match both artifacts and are served as plain text.',
  )

  const tech = await pageFor('technical')
  console.log('Ready: technical workspace')
  await tech
    .getByRole('button', { name: '新建新品', exact: true })
    .first()
    .click()
  await tech.getByLabel('新品名称', { exact: true }).fill(name)
  await tech.getByLabel('电机型号', { exact: true }).fill('BROWSER-160')
  await tech.getByLabel('客户', { exact: true }).fill('协同机电')
  await tech.getByLabel('用途 / 应用场景', { exact: true }).fill('轴流风机')
  await tech.getByLabel('额定功率（kW）', { exact: true }).fill('7.50')
  await tech.getByLabel('额定电压（V）', { exact: true }).fill('380')
  await tech.getByLabel('极数', { exact: true }).fill('8')
  await tech
    .getByLabel('项目说明', { exact: true })
    .fill('样机开发\n验证温升与装配')
  await tech
    .getByLabel('制造负责人', { exact: true })
    .selectOption(accounts.manufacturing!.id)
  await tech.getByLabel('要求齐套日期', { exact: true }).fill('2026-10-15')
  await tech.getByLabel('样机要求日期', { exact: true }).fill('2026-10-20')
  await saved(tech)
  await tech.getByRole('button', { name, exact: true }).click()
  await tech.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  const dash = await (
    await tech.request.get(root + '/api/v1/npi/dashboard')
  ).json()
  const id = dash.projects.find((p: { name: string }) => p.name === name).id
  const filesRoute = `**/api/v1/npi/files/project/${id}`
  let failFileList = true
  let attachmentPosts = 0
  await tech.route(filesRoute, async (route) => {
    if (route.request().method() === 'POST') attachmentPosts++
    if (route.request().method() === 'GET' && failFileList)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '资料服务暂时不可用' }),
      })
    else await route.continue()
  })
  await tech.getByRole('tab', { name: '项目资料', exact: true }).click()
  const fileRegion = tech.getByRole('region', { name: '附件资料' })
  await expect(fileRegion.getByRole('alert')).toContainText(
    '资料服务暂时不可用',
  )
  await expect(
    fileRegion.getByText('正在加载资料…', { exact: true }),
  ).toHaveCount(0)
  await expect(
    fileRegion.getByRole('button', { name: '上传资料', exact: true }),
  ).toHaveCount(0)
  failFileList = false
  await fileRegion
    .getByRole('button', { name: '刷新资料', exact: true })
    .click()
  await expect(fileRegion.getByRole('alert')).toHaveCount(0)
  await expect(
    fileRegion.getByRole('button', { name: '上传资料', exact: true }),
  ).toBeEnabled()
  // A committed upload followed by a failed GET must not invite another upload.
  await fileRegion.getByLabel('资料标题', { exact: true }).fill('样机技术规格')
  await fileRegion.getByLabel('选择文件或照片', { exact: true }).setInputFiles({
    name: '规格.pdf',
    mimeType: 'application/pdf',
    buffer: attachmentPdf,
  })
  failFileList = true
  await fileRegion
    .getByRole('button', { name: '刷新资料', exact: true })
    .click()
  await expect(fileRegion.getByRole('alert')).toContainText(
    '资料服务暂时不可用',
  )
  await expect(
    fileRegion.getByRole('button', { name: '上传资料', exact: true }),
  ).toBeDisabled()
  await expect(fileRegion.getByLabel('资料标题', { exact: true })).toHaveValue(
    '样机技术规格',
  )
  assert.equal(
    await fileRegion
      .getByLabel('选择文件或照片', { exact: true })
      .evaluate((element) => (element as HTMLInputElement).files?.[0]?.name),
    '规格.pdf',
  )
  failFileList = false
  await fileRegion
    .getByRole('button', { name: '刷新资料', exact: true })
    .click()
  await expect(
    fileRegion.getByRole('button', { name: '上传资料', exact: true }),
  ).toBeEnabled()
  failFileList = true
  await fileRegion
    .getByRole('button', { name: '上传资料', exact: true })
    .click()
  await expect(
    fileRegion.getByRole('status').filter({ hasText: '资料已上传成功' }),
  ).toBeVisible()
  await expect(fileRegion.getByRole('alert')).toContainText(
    '资料服务暂时不可用',
  )
  await tech.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await tech.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await tech.screenshot({
    path: '/tmp/npi-files-refresh-failure-mobile.png',
    fullPage: true,
  })
  failFileList = false
  await fileRegion
    .getByRole('button', { name: '刷新资料', exact: true })
    .click()
  await expect(fileRegion.getByRole('alert')).toHaveCount(0)
  await expect(fileRegion.locator('article')).toHaveCount(1)
  await expect(
    fileRegion.getByText('样机技术规格', { exact: true }),
  ).toBeVisible()
  assert.equal(attachmentPosts, 1)
  const uploadedFile = await tech.request.get(
    root +
      (await fileRegion
        .getByRole('link', { name: '下载文件', exact: true })
        .getAttribute('href')),
  )
  assert.equal(uploadedFile.status(), 200)
  assert.deepEqual(await uploadedFile.body(), attachmentPdf)
  await tech.unroute(filesRoute)
  await tech.setViewportSize({ width: 1440, height: 1000 })
  console.log(
    'PASS: attachment initial-load failure ends loading; refresh clears errors; committed upload survives list failure with one record and intact download.',
  )
  await tech.getByRole('tab', { name: '概览', exact: true }).click()
  await expect(
    tech.getByRole('link', { name: '样机技术规格', exact: true }),
  ).toBeVisible()
  await expect(
    tech.getByRole('heading', { name: '关键节点', exact: true }),
  ).toBeVisible()
  await tech.evaluate(() => window.scrollTo(0, 0))
  await tech.screenshot({
    path: '/tmp/npi-ui-project-overview.png',
    fullPage: true,
  })
  await expect(
    tech.getByRole('region', { name: '项目概览', exact: true }),
  ).toContainText('7.5 kW')
  await expect(
    tech.getByRole('region', { name: '项目概览', exact: true }),
  ).toContainText('协同机电')
  await tech
    .getByRole('button', { name: '项目计划与交接', exact: true })
    .click()
  await tech.getByText('客户与电机参数（可选）', { exact: true }).click()
  await tech.getByLabel('额定功率（kW）', { exact: true }).fill('11.000')
  await tech.getByLabel('客户', { exact: true }).fill('协同制造')
  await tech
    .getByLabel('项目说明', { exact: true })
    .fill('客户确认提高功率\n先验证样机温升')
  await tech
    .getByLabel('变更原因', { exact: true })
    .fill('客户确认电机选型参数')
  await tech.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await tech.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
    false,
    'Project profile form fits mobile viewport',
  )
  await tech.getByLabel('项目说明', { exact: true }).scrollIntoViewIfNeeded()
  await tech.screenshot({
    path: '/tmp/npi-profile-form-mobile.png',
    fullPage: true,
  })
  await tech.setViewportSize({ width: 1440, height: 1000 })
  await tech.getByRole('button', { name: '预览变更', exact: true }).click()
  await expect(
    tech.getByRole('region', { name: '项目变更预览' }),
  ).toContainText('7.5 → 11')
  await tech.getByRole('button', { name: '确认变更', exact: true }).click()
  await expect(tech.getByRole('dialog')).toHaveCount(0)
  await expect(
    tech.getByRole('region', { name: '项目概览', exact: true }),
  ).toContainText('11 kW')
  await expect(
    tech.getByRole('region', { name: '项目概览', exact: true }),
  ).toContainText('协同制造')
  await tech.evaluate(() => window.scrollTo(0, 0))
  await tech.screenshot({
    path: '/tmp/npi-profile-overview-desktop.png',
    fullPage: true,
  })
  await tech.getByRole('tab', { name: '承诺与动态', exact: true }).click()
  await expect(
    tech.getByText('额定功率（kW）：7.5 → 11', { exact: true }),
  ).toBeVisible()
  await tech.getByRole('tab', { name: '概览', exact: true }).click()
  console.log(
    'PASS: optional project profile creation, native-backed overview, reasoned parameter preview/update and readable audit.',
  )
  await tech.getByRole('tab', { name: '项目资料', exact: true }).click()
  await tech.screenshot({
    path: '/tmp/npi-project-files-desktop.png',
    fullPage: true,
  })
  await tech.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  // Retained diagnostic templates can share a sheet name; choose the fixture's
  // known mapping instead of relying on a globally unique automatic match.
  await tech
    .getByLabel('导入模板', { exact: true })
    .selectOption('erp-multilevel-v1')
  await tech.getByLabel('上传ERP BOM', { exact: true }).setInputFiles({
    name: 'draft-browser.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await workbook('BROWSER-001'),
  })
  await tech.getByRole('button', { name: '解析预览', exact: true }).click()
  await tech.getByRole('button', { name: '保存为草稿', exact: true }).click()
  const drafts = tech.getByRole('region', { name: '我的BOM草稿', exact: true })
  await expect(
    drafts.getByText('draft-browser.xlsx', { exact: true }),
  ).toBeVisible()
  assert.equal((await detail(tech, id)).imports.length, 0)
  await tech.reload({ waitUntil: 'domcontentloaded' })
  await tech.getByRole('button', { name, exact: true }).click()
  await tech.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  await expect(
    drafts.getByText('draft-browser.xlsx', { exact: true }),
  ).toBeVisible()
  await drafts.scrollIntoViewIfNeeded()
  await tech.screenshot({
    path: '/tmp/npi-drafts-saved-desktop.png',
    fullPage: true,
  })
  await tech.setViewportSize({ width: 390, height: 844 })
  await drafts.scrollIntoViewIfNeeded()
  assert.equal(
    await tech.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
    false,
    'Draft list fits mobile',
  )
  await tech.screenshot({
    path: '/tmp/npi-drafts-saved-mobile.png',
    fullPage: true,
  })
  await tech.setViewportSize({ width: 1440, height: 1000 })
  await drafts.getByRole('button', { name: '恢复预览', exact: true }).click()
  await expect(
    tech.getByRole('heading', {
      name: '数据预览 · BROWSER-MOTOR',
      exact: true,
    }),
  ).toBeVisible()
  await tech
    .getByRole('button', { name: '下一步：解析确认', exact: true })
    .click()
  await tech
    .getByRole('button', { name: '确认导入为新版本', exact: true })
    .click()
  await expect(tech.getByLabel('BOM版本', { exact: true })).not.toHaveValue('')
  await expect(
    drafts.getByText('draft-browser.xlsx', { exact: true }),
  ).toHaveCount(0)
  assert.equal((await detail(tech, id)).imports.length, 1)
  // Removing a second draft uses an explicit inline confirmation.
  await tech
    .getByLabel('导入模板', { exact: true })
    .selectOption('erp-multilevel-v1')
  await tech.getByLabel('上传ERP BOM', { exact: true }).setInputFiles({
    name: 'discard-browser.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await workbook('BROWSER-002'),
  })
  await tech.getByRole('button', { name: '解析预览', exact: true }).click()
  await tech.getByRole('button', { name: '保存为草稿', exact: true }).click()
  await drafts.getByRole('button', { name: '移除草稿', exact: true }).click()
  await drafts.getByRole('button', { name: '保留草稿', exact: true }).click()
  await expect(
    drafts.getByRole('button', { name: '恢复预览', exact: true }),
  ).toBeVisible()
  await drafts.getByRole('button', { name: '移除草稿', exact: true }).click()
  await drafts
    .getByRole('button', { name: '确认移除草稿', exact: true })
    .click()
  await expect(
    drafts.getByText('discard-browser.xlsx', { exact: true }),
  ).toHaveCount(0)
  assert.equal((await detail(tech, id)).imports.length, 1)
  console.log(
    'PASS: durable BOM draft survives full page reload, reparses and imports once; removal confirmation preserves formal versions.',
  )

  await tech
    .getByRole('button', { name: /建议跟踪|设为重点/ })
    .first()
    .click()
  await tech
    .getByLabel('回复责任人', { exact: true })
    .selectOption(accounts.procurement!.id)
  await saved(tech)
  const buyer = await pageFor('procurement', true)
  await buyer
    .getByRole('row')
    .filter({ hasText: '浏览器关键轴承' })
    .getByRole('button', { name: '回复', exact: true })
    .click()
  await buyer.getByLabel('预计到货日期', { exact: true }).fill('2026-10-16')
  await saved(buyer)
  await buyer
    .getByRole('button', { name: '浏览器关键轴承附件资料', exact: true })
    .click()
  await uploadAttachment(buyer, '供应商到货照片', true)
  await expect(
    buyer.getByRole('button', { name: '归档资料', exact: true }),
  ).toHaveCount(0)
  assert.equal(
    await buyer.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await buyer.screenshot({
    path: '/tmp/npi-receipt-files-mobile.png',
    fullPage: true,
  })
  await buyer.keyboard.press('Escape')
  const before = await detail(tech, id)
  const item = before.items.find(
    (i: { sourceType: string }) => i.sourceType === 'ERP_BOM',
  )
  assert.equal(item.firstCommittedDate, '2026-10-16')
  await importBom(tech, await workbook('BROWSER-001', 30, 2))
  await expect(tech.getByTestId('bom-reconciliation')).toContainText(
    'BOM换版待复核 · 1 项',
  )
  await tech
    .getByRole('button', { name: '与上一版本比较', exact: true })
    .click()
  await expect(tech.getByText('位置移动', { exact: false })).toBeVisible()
  await tech.screenshot({
    path: '/tmp/npi-bom-reconciliation-desktop.png',
    fullPage: true,
  })
  const mfg = await pageFor('manufacturing')
  await openProjectDirectory(mfg, name)
  await mfg.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  await expect(mfg.getByTestId('bom-reconciliation')).toBeVisible()
  await expect(
    mfg.getByRole('button', { name: '关联新版', exact: true }),
  ).toHaveCount(0)
  await tech.getByRole('button', { name: '关联新版', exact: true }).click()
  await tech
    .getByLabel('换版复核原因', { exact: true })
    .fill('已核对新版数量2只和位置，沿用采购承诺')
  await saved(tech)
  await expect(tech.getByTestId('bom-reconciliation')).toHaveCount(0)
  const migrated = await detail(tech, id)
  const current = migrated.items.find((i: { id: string }) => i.id === item.id)
  assert.equal(current.qty, '2')
  assert.equal(current.firstCommittedDate, item.firstCommittedDate)
  assert.equal(migrated.history.length, before.history.length)
  await importBom(tech, await workbook('REPLACEMENT', 30, 2))
  await tech.setViewportSize({ width: 390, height: 844 })
  await expect(tech.getByTestId('bom-reconciliation')).toContainText(
    '当前版本已无此编码',
  )
  await tech.getByRole('button', { name: '停止旧跟踪', exact: true }).click()
  await tech
    .getByLabel('换版复核原因', { exact: true })
    .fill('设计更改，旧轴承取消采购')
  await tech.screenshot({
    path: '/tmp/npi-bom-retire-mobile.png',
    fullPage: true,
  })
  await saved(tech)
  await expect(tech.getByTestId('bom-reconciliation')).toHaveCount(0)
  await tech.getByRole('tab', { name: '承诺与动态', exact: true }).click()
  await expect(
    tech.getByText('设计更改，旧轴承取消采购', { exact: true }),
  ).toBeVisible()
  await buyer.reload()
  await expect(
    buyer.getByRole('row').filter({ hasText: '浏览器关键轴承' }),
  ).toHaveCount(0)
  assert.equal(
    await buyer.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await tech.setViewportSize({ width: 1440, height: 1000 })
  await tech.getByRole('tab', { name: /^项目问题/ }).click()
  await tech.getByRole('button', { name: '新建问题', exact: true }).click()
  await tech.getByLabel('问题标题', { exact: true }).fill('轴承交付需协调')
  await tech
    .getByLabel('问题说明', { exact: true })
    .fill('供应商排产异常，需要协调样机交付')
  await tech.getByLabel('严重度', { exact: true }).selectOption('Critical')
  await tech
    .getByLabel('问题责任人', { exact: true })
    .selectOption(accounts.procurement!.id)
  await tech.getByRole('button', { name: '保存问题', exact: true }).click()
  await expect(tech.getByRole('dialog')).toHaveCount(0)
  await expect(
    tech.getByRole('button').filter({ hasText: '轴承交付需协调' }),
  ).toBeVisible()
  assert.equal((await detail(tech, id)).criticalIssueCount, 1)
  await tech.screenshot({ path: '/tmp/npi-issues-desktop.png', fullPage: true })
  await buyer.reload()
  await buyer.getByRole('button').filter({ hasText: '轴承交付需协调' }).click()
  await buyer
    .getByLabel('补充处理记录', { exact: true })
    .fill('已联系供应商落实交付日期')
  await buyer.getByRole('button', { name: '记录进展', exact: true }).click()
  await expect(
    buyer.getByText('已联系供应商落实交付日期', { exact: true }),
  ).toBeVisible()
  await expect(
    buyer.getByRole('button', { name: '修改问题资料', exact: true }),
  ).toHaveCount(0)
  await buyer.screenshot({
    path: '/tmp/npi-issue-buyer-mobile.png',
    fullPage: true,
  })
  await uploadAttachment(buyer, '问题现场照片', true)
  for (const state of ['InProgress', 'Resolved', 'Verified', 'Closed']) {
    await buyer.getByLabel('推进状态', { exact: true }).selectOption(state)
    await buyer
      .getByLabel('处理说明', { exact: true })
      .fill(`处理结果：${state}`)
    await buyer.getByRole('button', { name: '更新状态', exact: true }).click()
    await expect(
      buyer.getByText(`处理结果：${state}`, { exact: true }),
    ).toBeVisible()
  }
  await expect(
    buyer.getByRole('button', { name: '上传资料', exact: true }),
  ).toHaveCount(0)
  assert.equal((await detail(tech, id)).criticalIssueCount, 0)
  console.log(
    'PASS: native Issue creation, critical risk, procurement mobile progress, native resolution/verification/closure, preserved history and no manager controls for buyer.',
  )
  await tech.getByRole('tab', { name: '项目资料', exact: true }).click()
  await tech.getByRole('button', { name: '归档资料', exact: true }).click()
  await tech.getByLabel('归档原因', { exact: true }).fill('规格升级，旧版留存')
  await tech.route(filesRoute, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '归档后列表暂时不可用' }),
    }),
  )
  await tech.getByRole('button', { name: '确认归档', exact: true }).click()
  await expect(fileRegion.getByRole('status')).toContainText('资料已归档')
  await expect(fileRegion.getByRole('alert')).toContainText(
    '归档后列表暂时不可用',
  )
  await expect(
    fileRegion.getByRole('button', { name: '归档资料', exact: true }),
  ).toBeDisabled()
  await tech.unroute(filesRoute)
  await fileRegion
    .getByRole('button', { name: '刷新资料', exact: true })
    .click()
  await expect(fileRegion.getByRole('alert')).toHaveCount(0)
  await expect(tech.getByText('样机技术规格', { exact: true })).toHaveCount(0)
  await tech.getByLabel('显示已归档资料').check()
  await expect(
    tech.getByText('已归档：规格升级，旧版留存', { exact: true }),
  ).toBeVisible()
  console.log(
    'PASS: project PDF upload/download, buyer mobile receipt and Issue photos with image decode, reasoned archive and historical file visibility.',
  )
  await tech.getByRole('tab', { name: '样机齐套', exact: true }).click()
  await tech
    .getByRole('region', { name: '齐套物料清单', exact: true })
    .getByRole('button', { name: '全部跟踪', exact: true })
    .click()
  await tech.getByRole('button', { name: '添加BOM外物料', exact: true }).click()
  await tech.getByLabel('物料名称', { exact: true }).fill('交接验收连接器')
  await tech
    .getByLabel('回复责任人', { exact: true })
    .selectOption(accounts.procurement!.id)
  await saved(tech)
  await buyer.goto(root + '/npi')
  const oldBuyerRow = buyer
    .getByRole('row')
    .filter({ hasText: '交接验收连接器' })
  await oldBuyerRow.getByRole('button', { name: '回复', exact: true }).click()
  await buyer.getByLabel('预计到货日期', { exact: true }).fill('2026-10-18')
  await saved(buyer)
  for (const committed of ['2026-10-20', '2026-10-19']) {
    await oldBuyerRow.getByRole('button', { name: '改期', exact: true }).click()
    await buyer.getByLabel('预计到货日期', { exact: true }).fill(committed)
    await buyer
      .getByLabel('变更原因（必填）', { exact: true })
      .fill('供应商排产调整')
    await saved(buyer)
  }
  await tech.getByRole('button', { name: '刷新', exact: true }).click()
  const managedRow = tech.getByRole('row').filter({ hasText: '交接验收连接器' })
  await expect(managedRow).toContainText('2026-10-19')
  await managedRow
    .getByRole('button', { name: '调整计划', exact: true })
    .click()
  await tech
    .getByLabel('回复责任人', { exact: true })
    .selectOption(accounts.otherBuyer!.id)
  await tech.getByLabel('调整后的要求日期', { exact: true }).fill('2026-10-20')
  await tech
    .getByLabel('调整原因', { exact: true })
    .fill('采购交接并更新客户计划')
  await saved(tech)
  await expect(managedRow).toContainText('浏览器-otherBuyer')
  await buyer.goto(root + '/npi')
  await expect(oldBuyerRow).toHaveCount(0)
  const successor = await pageFor('otherBuyer', true)
  const newBuyerRow = successor
    .getByRole('row')
    .filter({ hasText: '交接验收连接器' })
  await expect(newBuyerRow).toContainText('2026-10-18')
  await expect(
    successor.getByRole('button', { name: '调整计划', exact: true }),
  ).toHaveCount(0)
  await newBuyerRow.getByRole('button', { name: '到货', exact: true }).click()
  await successor.getByLabel('实际到货日期', { exact: true }).fill('2026-09-01')
  await saved(successor)
  await tech.getByRole('button', { name: '刷新', exact: true }).click()
  await managedRow
    .getByRole('button', { name: '更正日期', exact: true })
    .click()
  await tech
    .getByLabel('更正后的实际完成日期', { exact: true })
    .fill('2026-09-02')
  await tech
    .getByLabel('更正原因', { exact: true })
    .fill('按签收单更正录入错误')
  await saved(tech)
  await expect(managedRow).toContainText('2026-09-02')
  await tech.getByRole('tab', { name: '承诺与动态', exact: true }).click()
  await expect(
    tech.getByText('实际完成：2026-09-01 → 2026-09-02', { exact: true }),
  ).toBeVisible()
  await expect(
    tech.getByText('责任人：浏览器-procurement → 浏览器-otherBuyer', {
      exact: true,
    }),
  ).toBeVisible()
  await tech.setViewportSize({ width: 1440, height: 1000 })
  await tech.screenshot({
    path: '/tmp/npi-adjustment-audit-desktop.png',
    fullPage: true,
  })
  await successor.goto(root + '/npi')
  await successor
    .getByLabel('采购筛选', { exact: true })
    .selectOption('completed')
  await expect(newBuyerRow).toContainText('2026-09-02')
  await expect(
    successor.getByRole('button', { name: '更正日期', exact: true }),
  ).toHaveCount(0)
  await successor.screenshot({
    path: '/tmp/npi-handoff-buyer-mobile.png',
    fullPage: true,
  })
  console.log(
    'PASS: UI purchase handoff, preserved promises, old buyer task removal, successor mobile receipt, controlled correction and readable before/after audit.',
  )
  // Exercise the full stage workflow and manufacturing batch through visible controls.
  // Another role has completed/corrected material records; reopen the latest project.
  await tech.reload({ waitUntil: 'domcontentloaded' })
  await tech.getByRole('button', { name, exact: true }).click()
  await tech.setViewportSize({ width: 1440, height: 1000 })
  for (const stage of ['manufacturing', 'prototype', 'test']) {
    await tech.getByRole('button', { name: '推进阶段', exact: false }).click()
    if (stage === 'manufacturing')
      await tech
        .getByLabel('图纸实际完成日期', { exact: true })
        .fill('2026-09-01')
    if (stage === 'manufacturing') {
      const stageDetailRoute = `**/api/v1/npi/projects/${id}`
      let releaseRefresh!: () => void
      const heldRefresh = new Promise<void>((resolve) => {
        releaseRefresh = resolve
      })
      let refreshContinued!: () => void
      const refreshState = { intercepted: false }
      const continuedRefresh = new Promise<void>((resolve) => {
        refreshContinued = resolve
      })
      await tech.route(stageDetailRoute, async (route) => {
        refreshState.intercepted = true
        try {
          await heldRefresh
          await route.continue()
        } finally {
          refreshContinued()
        }
      })
      try {
        const refreshingProject = tech.waitForRequest(
          (request) =>
            request.method() === 'GET' &&
            request.url() === root + `/api/v1/npi/projects/${id}`,
        )
        await tech
          .getByRole('dialog')
          .getByRole('button', { name: '保存', exact: true })
          .click()
        await refreshingProject
        await expect(tech.getByRole('dialog')).toHaveCount(1)
        await expect(
          tech
            .getByRole('dialog')
            .getByRole('button', { name: '正在保存…', exact: true }),
        ).toBeDisabled()
      } finally {
        releaseRefresh()
        if (refreshState.intercepted) await continuedRefresh
        await tech.unroute(stageDetailRoute)
      }
      await expect(tech.getByRole('dialog')).toHaveCount(0, { timeout: 20000 })
    } else await saved(tech)
    assert.equal((await detail(tech, id)).currentNpiStage, stage)
  }
  await tech.getByRole('button', { name: '推进阶段', exact: false }).click()
  await expect(tech.getByRole('dialog')).toContainText('以下项目尚未完成')
  await tech
    .getByRole('dialog')
    .getByRole('button', { name: '保存', exact: true })
    .click()
  await expect(tech.getByRole('dialog')).toContainText('须先确认完成')
  await tech
    .getByRole('dialog')
    .getByRole('button', { name: '取消', exact: true })
    .click()
  await mfg.goto(root + '/npi')
  await openProjectDirectory(mfg, name)
  await mfg.getByRole('tab', { name: '制造准备', exact: true }).click()
  await mfg.setViewportSize({ width: 390, height: 844 })
  await mfg.getByRole('button', { name: '集中确认完成', exact: true }).click()
  await mfg
    .getByLabel('工艺准备实际完成日期', { exact: true })
    .fill('2026-09-01')
  await mfg
    .getByRole('dialog', { name: '集中确认制造完成' })
    .getByRole('button', { name: '保存完成记录' })
    .click()
  await expect(
    mfg.getByRole('dialog', { name: '集中确认制造完成' }),
  ).toHaveCount(0)
  assert.equal(
    (await detail(tech, id)).items.filter(
      (i: { sourceType: string; actualCompleteDate: unknown }) =>
        i.sourceType === 'MANUFACTURING' && i.actualCompleteDate,
    ).length,
    1,
  )
  await mfg.getByRole('button', { name: '集中确认完成', exact: true }).click()
  await expect(
    mfg.getByLabel('工艺准备实际完成日期', { exact: true }),
  ).toBeDisabled()
  for (const label of ['工装准备', '零部件齐套', '样机装配'])
    await mfg
      .getByLabel(`${label}实际完成日期`, { exact: true })
      .fill('2026-09-01')
  await mfg.screenshot({
    path: '/tmp/npi-manufacturing-completion-mobile.png',
    fullPage: true,
  })
  await mfg
    .getByRole('dialog', { name: '集中确认制造完成' })
    .getByRole('button', { name: '保存完成记录' })
    .click()
  await expect(
    mfg.getByRole('dialog', { name: '集中确认制造完成' }),
  ).toHaveCount(0)
  await expect(
    mfg.getByRole('button', { name: '集中确认完成', exact: true }),
  ).toHaveCount(0)
  assert.ok(
    await mfg.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  )
  await tech.goto(root + '/npi')
  await tech
    .getByRole('searchbox', { name: '搜索项目', exact: true })
    .fill(name)
  await tech.getByRole('button', { name, exact: true }).click()
  await tech.getByRole('button', { name: '推进阶段', exact: false }).click()
  await saved(tech)
  assert.equal((await detail(tech, id)).currentNpiStage, 'completed')
  assert.equal(
    (await client`select status from programs where id=${id}`)[0]!.status,
    'Completed',
  )
  await expect(
    tech.getByRole('button', { name: '推进阶段', exact: false }),
  ).toHaveCount(0)
  await tech.getByRole('tab', { name: '样机齐套', exact: true }).click()
  await expect(
    tech.getByText('已完成，无需预测', { exact: true }),
  ).toBeVisible()
  await expect(tech.getByText('未记录承诺', { exact: true })).toBeVisible()
  await tech.screenshot({
    path: '/tmp/npi-project-completed-desktop.png',
    fullPage: true,
  })
  console.log(
    'PASS: five-stage UI progression, blocked premature closure, partial and remaining manufacturing actual dates on mobile, native Program completion and read-only controls.',
  )
  await tech.goto(root + '/npi')
  await tech
    .getByRole('button', { name: '新建新品', exact: true })
    .first()
    .click()
  const handoffName = '项目交接-' + Date.now()
  await tech.getByLabel('新品名称', { exact: true }).fill(handoffName)
  await tech.getByLabel('电机型号', { exact: true }).fill('HANDOFF-MOTOR')
  await tech
    .getByLabel('制造负责人', { exact: true })
    .selectOption(accounts.manufacturing!.id)
  await tech.getByLabel('要求齐套日期', { exact: true }).fill('2026-10-15')
  await tech.getByLabel('样机要求日期', { exact: true }).fill('2026-10-20')
  await saved(tech)
  await tech.getByRole('button', { name: handoffName, exact: true }).click()
  await tech
    .getByRole('button', { name: '项目计划与交接', exact: true })
    .click()
  await tech.getByLabel('要求齐套日期', { exact: true }).fill('2026-10-16')
  await tech
    .getByLabel('技术负责人', { exact: true })
    .selectOption(accounts.nextTech!.id)
  await tech
    .getByLabel('制造负责人', { exact: true })
    .selectOption(accounts.nextMfg!.id)
  await tech
    .getByLabel('变更原因', { exact: true })
    .fill('负责人岗位交接，齐套计划顺延一天')
  await tech.getByRole('button', { name: '预览变更', exact: true }).click()
  await expect(
    tech.getByRole('region', { name: '项目变更预览' }),
  ).toContainText('制造节点与物料 · 4 项')
  await expect(tech.getByRole('dialog')).toContainText('保存后返回新品列表')
  await tech.setViewportSize({ width: 390, height: 844 })
  await tech.screenshot({
    path: '/tmp/npi-project-handoff-preview-mobile.png',
    fullPage: true,
  })
  await tech.getByRole('button', { name: '确认变更', exact: true }).click()
  await expect(tech.getByRole('dialog')).toHaveCount(0)
  await expect(tech.getByText(handoffName, { exact: true })).toHaveCount(0)
  const incomingTech = await pageFor('nextTech')
  await incomingTech
    .getByRole('button', { name: handoffName, exact: true })
    .click()
  await expect(
    incomingTech.getByRole('button', { name: '项目计划与交接', exact: true }),
  ).toBeVisible()
  await incomingTech
    .getByRole('tab', { name: '承诺与动态', exact: true })
    .click()
  await expect(
    incomingTech.getByText('技术负责人：浏览器-technical → 浏览器-nextTech', {
      exact: true,
    }),
  ).toBeVisible()
  await incomingTech.screenshot({
    path: '/tmp/npi-project-handoff-audit-desktop.png',
    fullPage: true,
  })
  const incomingMfg = await pageFor('nextMfg', true)
  await openProjectDirectory(incomingMfg, handoffName)
  await incomingMfg.getByRole('tab', { name: '制造准备', exact: true }).click()
  await expect(
    incomingMfg.getByRole('button', { name: '集中回复', exact: true }),
  ).toBeVisible()
  await expect(
    incomingMfg.getByRole('button', { name: '项目计划与交接', exact: true }),
  ).toHaveCount(0)
  const supervisor = await pageFor('supervisor')
  await supervisor
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '报表看板', exact: true })
    .click()
  await supervisor
    .getByRole('searchbox', { name: '变化与改期任务搜索' })
    .fill(name)
  const todaySection = supervisor.getByRole('region', {
    name: '今日变化',
    exact: true,
  })
  await todaySection.getByRole('button', { name: /^承诺变更 / }).click()
  await expect(
    todaySection
      .getByRole('row')
      .filter({ hasText: '交接验收连接器' })
      .filter({ hasText: name }),
  ).toHaveCount(2)
  await todaySection.getByRole('button', { name: /^确认完成 / }).click()
  await expect(
    todaySection
      .getByRole('row')
      .filter({ hasText: '交接验收连接器' })
      .filter({ hasText: name }),
  ).toHaveCount(1)
  const changes = supervisor.getByRole('region', {
    name: '承诺改期任务',
    exact: true,
  })
  await changes.getByLabel('包含已完成 / 停止跟踪', { exact: true }).check()
  await changes.getByLabel('改期次数筛选', { exact: true }).selectOption('2')
  const repeated = changes
    .getByRole('row')
    .filter({ hasText: '交接验收连接器' })
    .filter({ hasText: name })
  await expect(repeated).toContainText('2 次')
  await changes.getByLabel('改期次数筛选', { exact: true }).selectOption('3')
  await expect(repeated).toHaveCount(0)
  await changes.getByLabel('改期次数筛选', { exact: true }).selectOption('2')
  await changes.screenshot({
    path: '/tmp/npi-change-count-supervisor-desktop.png',
  })
  await supervisor.setViewportSize({ width: 390, height: 844 })
  await todaySection.screenshot({ path: '/tmp/npi-today-activity-mobile.png' })
  await repeated.getByRole('button', { name: '定位事项', exact: true }).click()
  await expect(
    supervisor.getByRole('tab', { name: '样机齐套', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  const historicalFocus = supervisor.getByRole('region', {
    name: '齐套物料清单',
    exact: true,
  })
  await expect(historicalFocus.locator('tbody tr')).toHaveCount(1)
  await expect(historicalFocus.locator('tbody tr')).toContainText(
    '交接验收连接器',
  )
  await expect(
    historicalFocus.getByRole('button', { name: '改期', exact: true }),
  ).toHaveCount(0)
  await expect(
    supervisor.getByRole('heading', { name: new RegExp(name) }),
  ).toBeVisible()
  await expect(
    supervisor.getByRole('button', { name: '项目计划与交接', exact: true }),
  ).toHaveCount(0)
  // Finished projects stay locked even for plan-authorized supervisors.
  // The active project must still expose their plan-only entry.
  await openProjectDirectory(supervisor, handoffName)
  await expect(
    supervisor.getByRole('button', { name: '项目计划与交接', exact: true }),
  ).toBeVisible()
  console.log(
    'PASS: supervisor today changes/completions, change-count thresholds, historical inclusion, project drilldown and planning entry.',
  )
  console.log(
    'PASS: project handoff preview, mobile confirmation, outgoing manager dashboard return and incoming technical/manufacturing access with readable audit.',
  )
  await tech.setViewportSize({ width: 1440, height: 1000 })
  // Independent dashboard fixtures use the actual API and the current business day.
  const apiFixture = async (
    role: string,
    path: string,
    method = 'GET',
    data?: unknown,
  ) => {
    const account = accounts[role]!
    const response = await fetch(root + '/api/v1/npi' + path, {
      method,
      headers: {
        cookie: `session=${account.token}`,
        origin: root,
        'x-npi-actor': account.id,
        'content-type': 'application/json',
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return response.json()
  }
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const relativeDay = (offset: number) =>
    new Date(Date.parse(day + 'T00:00:00Z') + offset * 86400000)
      .toISOString()
      .slice(0, 10)
  const prefix = `驾驶舱验收-${Date.now()}`
  const createDashboardFixture = async (
    suffix: string,
    expected: string,
    offset?: number,
    mfgRole = 'manufacturing',
  ) => {
    const created = await apiFixture('technical', '/projects', 'POST', {
      name: `${prefix}-${suffix}`,
      motorModel: 'DASH-160',
      technicalOwnerId: accounts.technical!.id,
      manufacturingOwnerId: accounts[mfgRole]!.id,
      requiredKitDate: day,
      prototypeRequiredDate: day,
    })
    const p = await apiFixture('technical', `/projects/${created.id}`)
    if (offset !== undefined)
      await apiFixture(mfgRole, `/projects/${p.id}/manufacturing-plan`, 'PUT', {
        expectedVersion: p.plan.version,
        processCommitted: relativeDay(offset),
        toolingCommitted: relativeDay(offset),
        kitCommitted: relativeDay(offset),
        assemblyCommitted: relativeDay(offset),
      })
    const result = await apiFixture('technical', `/projects/${p.id}`)
    assert.equal(result.riskStatus, expected)
    return result
  }
  const normalProject = await createDashboardFixture('正常', 'normal', 0)
  const otherManufacturing = await createDashboardFixture(
    '其他制造',
    'normal',
    0,
    'nextMfg',
  )
  const pendingProject = await createDashboardFixture('待回复', 'pending_reply')
  const riskProject = await createDashboardFixture('风险', 'risk', 1)
  const overdueProject = await createDashboardFixture('逾期', 'overdue', -1)
  await tech.getByRole('button', { name: '首页', exact: true }).click()
  await tech.getByRole('button', { name: '刷新', exact: true }).click()
  const list = tech.getByRole('region', { name: '项目进度列表', exact: true })
  const normalToggle = list.getByRole('button', { name: /^正常项目/ })
  await expect(normalToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(
    list.getByRole('button', { name: normalProject.name, exact: true }),
  ).toHaveCount(0)
  for (const p of [overdueProject, riskProject, pendingProject])
    await expect(
      list.getByRole('button', { name: p.name, exact: true }),
    ).toBeVisible()
  await expect(
    list
      .getByRole('table', { name: '项目结果', exact: true })
      .getByRole('row')
      .nth(1),
  ).toContainText(overdueProject.name)
  await normalToggle.focus()
  await tech.keyboard.press('Enter')
  await expect(normalToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(
    list.getByRole('button', { name: normalProject.name, exact: true }),
  ).toBeVisible()
  await normalToggle.click()
  await list
    .getByRole('searchbox', { name: '搜索项目' })
    .fill(normalProject.name)
  await expect(
    list.getByRole('button', { name: normalProject.name, exact: true }),
  ).toBeVisible()
  await expect(normalToggle).toHaveCount(0)
  await list
    .getByRole('searchbox', { name: '搜索项目' })
    .fill('无匹配-' + prefix)
  await expect(
    list.getByRole('heading', { name: '没有符合筛选条件的项目' }),
  ).toBeVisible()
  const kpis = tech.getByRole('group', { name: '项目指标', exact: true })
  await kpis.getByRole('button', { name: /^在研新品/ }).click()
  await expect(list.getByRole('searchbox', { name: '搜索项目' })).toHaveValue(
    '',
  )
  await expect(list.getByRole('status')).toContainText('共 5 个项目')
  await expect(normalToggle).toHaveAttribute('aria-expanded', 'true')
  await list.getByLabel('仅看异常', { exact: true }).check()
  await expect(list.getByLabel('仅看异常', { exact: true })).toBeChecked()
  await expect(list.getByRole('status')).toContainText('共 3 个项目')
  await expect(
    list.getByRole('button', { name: normalProject.name, exact: true }),
  ).toHaveCount(0)
  await tech.evaluate(() => window.scrollTo(0, 0))
  await tech.screenshot({
    path: '/tmp/npi-ui-dashboard-desktop.png',
    fullPage: true,
  })
  await list.screenshot({ path: '/tmp/npi-dashboard-exceptions-desktop.png' })
  await kpis.getByRole('button', { name: /^完成项目按期率/ }).click()
  await expect(list.getByLabel('仅看异常', { exact: true })).not.toBeChecked()
  await expect(list.getByRole('button', { name, exact: true })).toBeVisible()
  await expect(list.getByRole('status')).toContainText('按期 1 个')
  await kpis.getByRole('button', { name: /^本月样机目标/ }).click()
  await expect(
    list.getByRole('button', { name: normalProject.name, exact: true }),
  ).toBeVisible()
  await expect(
    list.getByRole('button', { name: otherManufacturing.name, exact: true }),
  ).toBeVisible()
  await kpis.getByRole('button', { name: /^风险项目/ }).click()
  await expect(list.getByRole('status')).toContainText('共 1 个项目')
  await expect(
    list.getByRole('button', { name: riskProject.name, exact: true }),
  ).toBeVisible()
  await kpis.getByRole('button', { name: /^待回复项目/ }).click()
  await expect(
    list.getByRole('button', { name: pendingProject.name, exact: true }),
  ).toBeVisible()
  await kpis.getByRole('button', { name: /^逾期项目/ }).click()
  await expect(
    list.getByRole('button', { name: overdueProject.name, exact: true }),
  ).toBeVisible()
  await tech.getByRole('button', { name: '制造准备', exact: true }).click()
  const prep = tech.getByRole('region', { name: '制造四节点任务', exact: true })
  await prep.getByLabel('仅本人负责', { exact: true }).check()
  await expect(prep.locator('tbody tr')).toHaveCount(0)
  await expect(
    tech.getByRole('region', { name: '今日变化', exact: true }),
  ).toHaveCount(0)
  await tech.getByRole('button', { name: '首页', exact: true }).click()
  await expect(normalToggle).toHaveAttribute('aria-expanded', 'false')
  await tech.setViewportSize({ width: 390, height: 844 })
  await list.getByRole('searchbox', { name: '搜索项目' }).fill(prefix)
  assert.equal(
    await tech.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
    false,
  )
  await list.screenshot({ path: '/tmp/npi-project-list-mobile.png' })
  await list
    .getByRole('button', { name: normalProject.name, exact: true })
    .click()
  await expect(
    tech.getByRole('heading', { name: new RegExp(normalProject.name) }),
  ).toBeVisible()
  const mfgDashboard = await pageFor('manufacturing')
  await mfgDashboard
    .getByRole('button', { name: '制造准备', exact: true })
    .click()
  const ownList = mfgDashboard.getByRole('region', {
    name: '制造四节点任务',
    exact: true,
  })
  await expect(ownList.getByLabel('仅本人负责', { exact: true })).toBeChecked()
  await ownList.getByLabel('业务任务状态').selectOption('all')
  await ownList.getByLabel('业务任务搜索').fill(normalProject.name)
  await expect(ownList.locator('tbody tr')).toHaveCount(4)
  await ownList.getByLabel('业务任务搜索').fill(otherManufacturing.name)
  await expect(ownList.locator('tbody tr')).toHaveCount(0)
  console.log(
    'PASS: normal-project folding/keyboard access, search recovery, all KPI drilldowns, dashboard exception filter, scoped manufacturing metrics and mobile project navigation.',
  )
  // Prototype alignment: abnormal materials by default and actual inline manufacturing writes.
  const normalMaterial = await apiFixture(
    'technical',
    `/projects/${pendingProject.id}/external-items`,
    'POST',
    {
      name: '齐套正常连接器',
      qty: '1',
      ownerId: accounts.procurement!.id,
      requiredDate: day,
      affectsKit: true,
    },
  )
  await apiFixture(
    'procurement',
    `/tracking/${normalMaterial.id}/promise`,
    'POST',
    { expectedVersion: normalMaterial.version, committedDate: day },
  )
  await apiFixture(
    'technical',
    `/projects/${pendingProject.id}/external-items`,
    'POST',
    {
      name: '齐套待回复连接器',
      qty: '1',
      ownerId: accounts.procurement!.id,
      requiredDate: day,
      affectsKit: true,
    },
  )
  await mfgDashboard.getByRole('button', { name: '刷新', exact: true }).click()
  await openProjectDirectory(mfgDashboard, pendingProject.name)
  await expect(
    mfgDashboard.getByRole('tab', { name: '概览', exact: true }),
  ).toHaveAttribute('data-state', 'active')
  await mfgDashboard.getByRole('tab', { name: '样机齐套', exact: true }).click()
  const kitList = mfgDashboard.getByRole('region', {
    name: '齐套物料清单',
    exact: true,
  })
  await expect(
    kitList.getByRole('row').filter({ hasText: '齐套正常连接器' }),
  ).toHaveCount(0)
  await expect(
    kitList.getByRole('row').filter({ hasText: '齐套待回复连接器' }),
  ).toHaveCount(1)
  await kitList.getByRole('button', { name: '全部跟踪', exact: true }).click()
  await expect(
    kitList.getByRole('row').filter({ hasText: '齐套正常连接器' }),
  ).toHaveCount(1)
  await kitList.getByLabel('齐套物料来源').selectOption('ERP_BOM')
  await expect(
    kitList.getByRole('row').filter({ hasText: '连接器' }),
  ).toHaveCount(0)
  await kitList.getByLabel('齐套物料来源').selectOption('EXTERNAL')
  await kitList
    .getByRole('searchbox', { name: '搜索齐套物料' })
    .fill('待回复连接器')
  await expect(
    kitList.getByRole('row').filter({ hasText: '连接器' }),
  ).toHaveCount(1)
  await kitList.getByRole('searchbox', { name: '搜索齐套物料' }).fill('')
  await mfgDashboard.evaluate(() => window.scrollTo(0, 0))
  await mfgDashboard.screenshot({
    path: '/tmp/npi-ui-kit-desktop.png',
    fullPage: true,
  })
  const inline = mfgDashboard.getByRole('region', {
    name: '制造部集中回复',
    exact: true,
  })
  for (const label of ['工艺准备', '工装准备', '零部件齐套', '样机装配'])
    await inline.getByLabel(`${label}承诺日期`, { exact: true }).fill(day)
  await inline
    .getByRole('button', { name: '保存制造回复', exact: true })
    .click()
  await expect(inline.getByRole('status')).toContainText('制造承诺已保存')
  const firstPlan = await apiFixture(
    'manufacturing',
    `/projects/${pendingProject.id}`,
  )
  assert.equal(
    firstPlan.items.filter(
      (i: { sourceType: string; currentCommittedDate: string }) =>
        i.sourceType === 'MANUFACTURING' && i.currentCommittedDate === day,
    ).length,
    4,
  )
  await inline
    .getByLabel('零部件齐套承诺日期', { exact: true })
    .fill(relativeDay(1))
  await inline
    .getByRole('button', { name: '保存制造回复', exact: true })
    .click()
  assert.equal(
    await inline
      .getByLabel('零部件齐套改期原因', { exact: true })
      .evaluate((e: HTMLInputElement) => e.validity.valueMissing),
    true,
  )
  await inline
    .getByLabel('零部件齐套改期原因', { exact: true })
    .fill('装配前复检需要一天')
  // An intervening API update must not overwrite or silently discard the draft.
  await apiFixture(
    'manufacturing',
    `/projects/${pendingProject.id}/manufacturing-plan`,
    'PUT',
    {
      expectedVersion: firstPlan.plan.version,
      processCommitted: relativeDay(2),
      changeReasons: { processCommitted: '验证并发更新' },
    },
  )
  await mfgDashboard.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(
    inline.getByRole('button', { name: '载入最新计划', exact: true }),
  ).toBeVisible()
  await expect(
    inline.getByLabel('零部件齐套承诺日期', { exact: true }),
  ).toHaveValue(relativeDay(1))
  await expect(
    inline.getByRole('button', { name: '保存制造回复', exact: true }),
  ).toBeDisabled()
  await inline
    .getByRole('button', { name: '载入最新计划', exact: true })
    .click()
  await inline
    .getByLabel('零部件齐套承诺日期', { exact: true })
    .fill(relativeDay(1))
  await inline
    .getByLabel('零部件齐套改期原因', { exact: true })
    .fill('装配前复检需要一天')
  await inline
    .getByRole('button', { name: '保存制造回复', exact: true })
    .click()
  await expect(inline.getByRole('status')).toContainText('制造承诺已保存')
  const revised = await apiFixture(
    'manufacturing',
    `/projects/${pendingProject.id}`,
  )
  const kitNode = revised.items.find(
    (i: { trackingType: string }) => i.trackingType === 'kit',
  )
  assert.equal(kitNode.firstCommittedDate, day)
  assert.equal(kitNode.currentCommittedDate, relativeDay(1))
  assert.equal(kitNode.changeCount, 1)
  await mfgDashboard.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await mfgDashboard.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
    false,
  )
  await inline.screenshot({
    path: '/tmp/npi-ui-inline-manufacturing-mobile.png',
  })
  await mfgDashboard.getByRole('tab', { name: '制造准备', exact: true }).click()
  await expect(
    mfgDashboard.getByRole('heading', { name: '制造承诺历史', exact: true }),
  ).toBeVisible()
  console.log(
    'PASS: overview files and nodes, four-step BOM import, kit metrics/source/search/exception filters, inline manufacturing replies/reasons/concurrency/history and mobile layout.',
  )
  const inheritanceSource = await apiFixture('technical', `/projects/${id}`)
  const inheritor = await pageFor('technical')
  await inheritor
    .getByRole('region', { name: '项目进度列表', exact: true })
    .getByRole('button', { name: '已完成', exact: true })
    .click()
  await inheritor
    .getByRole('searchbox', { name: '搜索项目', exact: true })
    .fill(inheritanceSource.name)
  await inheritor
    .getByRole('button', { name: inheritanceSource.name, exact: true })
    .click()
  await inheritor
    .getByRole('button', { name: '以此项目新建', exact: true })
    .click()
  const inheritanceDialog = inheritor.getByRole('dialog')
  const inheritedName = `继承界面-${Date.now()}`
  await inheritanceDialog
    .getByLabel('新品名称', { exact: true })
    .fill(inheritedName)
  await inheritanceDialog
    .getByLabel('要求齐套日期', { exact: true })
    .fill('2026-12-01')
  await inheritanceDialog
    .getByLabel('样机要求日期', { exact: true })
    .fill('2026-12-05')
  await inheritanceDialog
    .getByLabel('继承采购件负责人', { exact: true })
    .selectOption(accounts.otherBuyer!.id)
  await inheritanceDialog
    .getByRole('button', { name: '预览继承范围', exact: true })
    .click()
  await expect(
    inheritanceDialog.getByRole('region', { name: '项目继承预览' }),
  ).toContainText('新项目从“设计中”开始')
  await inheritanceDialog
    .getByRole('button', { name: '返回调整', exact: true })
    .click()
  await expect(
    inheritanceDialog.getByLabel('新品名称', { exact: true }),
  ).toHaveValue(inheritedName)
  await inheritanceDialog
    .getByRole('button', { name: '预览继承范围', exact: true })
    .click()
  await inheritanceDialog.screenshot({
    path: '/tmp/npi-inherit-preview-desktop.png',
  })
  await inheritor.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await inheritor.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
    false,
  )
  assert.equal(
    await inheritanceDialog.evaluate(
      (el) => el.scrollWidth > el.clientWidth + 1,
    ),
    false,
    'Inheritance dialog must not scroll sideways',
  )
  await inheritanceDialog
    .getByRole('button', { name: '确认新建项目', exact: true })
    .scrollIntoViewIfNeeded()
  await inheritor.screenshot({
    path: '/tmp/npi-inherit-preview-mobile.png',
    fullPage: true,
  })
  await inheritanceDialog
    .getByRole('button', { name: '确认新建项目', exact: true })
    .click()
  await expect(inheritanceDialog).toHaveCount(0)
  await expect(
    inheritor.getByRole('heading', { name: new RegExp(inheritedName) }),
  ).toBeVisible()
  const newDashboard = await apiFixture('technical', '/dashboard')
  const inherited = newDashboard.projects.find(
    (p: { name: string }) => p.name === inheritedName,
  )
  const newDetail = await apiFixture('technical', `/projects/${inherited.id}`)
  assert.equal(newDetail.currentNpiStage, 'design')
  assert.equal(newDetail.history.length, 0)
  assert.ok(
    newDetail.items.every(
      (t: {
        firstCommittedDate: string | null
        currentCommittedDate: string | null
        actualCompleteDate: string | null
      }) =>
        !t.firstCommittedDate &&
        !t.currentCommittedDate &&
        !t.actualCompleteDate,
    ),
  )
  assert.equal(newDetail.imports.length, 1)
  assert.equal(
    newDetail.profile.ratedPowerKw,
    inheritanceSource.profile.ratedPowerKw,
  )
  assert.equal(
    (await apiFixture('technical', `/projects/${inherited.id}/issues`)).length,
    0,
  )
  assert.equal(
    (await apiFixture('technical', `/files/project/${inherited.id}`)).files
      .length,
    0,
  )
  const unchangedSource = await apiFixture('technical', `/projects/${id}`)
  assert.deepEqual(unchangedSource.items, inheritanceSource.items)
  assert.deepEqual(unchangedSource.history, inheritanceSource.history)
  await inheritor.getByRole('tab', { name: '承诺与动态', exact: true }).click()
  await expect(
    inheritor.getByText(new RegExp('来源：' + inheritanceSource.name)),
  ).toBeVisible()
  console.log(
    'PASS: completed-source inheritance preview, back-to-edit preservation, mobile confirmation, independent BOM and reset history with no copied issues/files.',
  )
  // Upper supported BOM size: pagination must never reduce the imported rows.
  const scaleName = `大BOM验收-${Date.now()}`
  const scaleProject = await apiFixture('technical', '/projects', 'POST', {
    name: scaleName,
    motorModel: 'SCALE-5000',
    technicalOwnerId: accounts.technical!.id,
    manufacturingOwnerId: accounts.manufacturing!.id,
    requiredKitDate: day,
    prototypeRequiredDate: day,
  })
  const scale = await pageFor('technical')
  await scale.getByRole('button', { name: scaleName, exact: true }).click()
  await scale.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  const scaleBook = new ExcelJS.Workbook()
  await scaleBook.xlsx.load(
    Uint8Array.from(await workbook('SCALE-00001')).buffer,
  )
  const scaleSheet = scaleBook.worksheets[0]!
  for (let n = 1; n <= 5000; n++) {
    const code = String(n).padStart(5, '0')
    scaleSheet.getRow(n + 5).values = [
      '+'.repeat(n <= 8 ? n : 2),
      n * 10,
      `SCALE-${code}`,
      `大BOM物料${code}`,
      1,
      '只',
      '采购',
      '采购库',
      '采购',
    ]
  }
  const scaleBytes = Buffer.from(await scaleBook.xlsx.writeBuffer())
  await scale
    .getByLabel('导入模板', { exact: true })
    .selectOption('erp-multilevel-v1')
  await scale.getByLabel('上传ERP BOM', { exact: true }).setInputFiles({
    name: 'scale-5000.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: scaleBytes,
  })
  await scale.getByRole('button', { name: '解析预览', exact: true }).click()
  const previewRows = scale
    .getByRole('table', { name: 'BOM导入预览', exact: true })
    .locator('tbody tr')
  await expect(previewRows).toHaveCount(100, { timeout: 60000 })
  const previewPager = scale.getByRole('navigation', {
    name: '导入预览分页',
    exact: true,
  })
  await expect(previewPager.getByRole('status')).toContainText('共5000行')
  await scale.locator('.npi-preview-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await previewPager.getByRole('button', { name: '末页', exact: true }).click()
  await expect(previewRows.last()).toContainText('SCALE-05000')
  await expect
    .poll(() =>
      scale.locator('.npi-preview-scroll').evaluate((el) => el.scrollTop),
    )
    .toBe(0)
  await expect(previewRows.first()).toBeInViewport()
  await scale.getByText('查看校验信息（5000）', { exact: true }).click()
  const validationPager = scale.getByRole('navigation', {
    name: '校验信息分页',
    exact: true,
  })
  await validationPager
    .getByRole('button', { name: '末页', exact: true })
    .click()
  await expect(
    scale.getByText('第4906行 · WARNING · 规格、仓库或领料部门存在空值', {
      exact: true,
    }),
  ).toBeInViewport()
  await expect(
    scale.getByText('第5005行 · WARNING · 规格、仓库或领料部门存在空值', {
      exact: true,
    }),
  ).toBeVisible()
  await scale.getByText('查看校验信息（5000）', { exact: true }).click()
  await scale
    .getByRole('button', { name: '下一步：解析确认', exact: true })
    .click()
  await scale
    .getByRole('button', { name: '确认导入为新版本', exact: true })
    .click()
  await expect(scale.getByLabel('BOM版本', { exact: true })).not.toHaveValue(
    '',
    {
      timeout: 60000,
    },
  )
  const tree = await apiFixture(
    'technical',
    `/projects/${scaleProject.id}/bom/tree`,
  )
  assert.equal(tree.rows.length, 5000)
  assert.equal(Math.max(...tree.rows.map((r: { level: number }) => r.level)), 8)
  assert.equal(tree.rows[7].parentId, tree.rows[6].id)
  assert.equal(tree.rows[4999].parentId, tree.rows[0].id)
  const original = await scale.request.get(
    `${root}/api/v1/npi/projects/${scaleProject.id}/bom/${tree.importId}/source`,
  )
  assert.equal(original.status(), 200)
  assert.deepEqual(await original.body(), scaleBytes)
  assert.equal((await detail(scale, scaleProject.id)).untrackedBomCount, 5000)
  const table = scale.getByRole('table', { name: '完整BOM明细', exact: true })
  const pager = scale.getByRole('navigation', {
    name: 'BOM明细分页',
    exact: true,
  })
  await expect(table.locator('tbody tr')).toHaveCount(100)
  await pager.getByRole('button', { name: '末页', exact: true }).click()
  await expect(table.locator('tbody tr').last()).toContainText('SCALE-05000')
  const firstPageGeometry = await table
    .locator('tbody tr')
    .first()
    .evaluate((el) => {
      const row = el.getBoundingClientRect()
      const header = document
        .querySelector('.npi-project-summary')!
        .getBoundingClientRect()
      return {
        top: row.top,
        bottom: row.bottom,
        headerBottom: header.bottom,
        viewport: innerHeight,
      }
    })
  assert.ok(
    firstPageGeometry.top >= firstPageGeometry.headerBottom &&
      firstPageGeometry.bottom <= firstPageGeometry.viewport,
    JSON.stringify(firstPageGeometry),
  )

  await scale
    .getByRole('navigation', { name: 'BOM明细顶部翻页', exact: true })
    .getByLabel('BOM明细顶部翻页页码')
    .selectOption('25')
  await expect(table.locator('tbody tr').first()).toContainText('SCALE-02401')
  await expect(table.locator('tbody tr').first()).toBeInViewport()
  await table
    .locator('tbody tr')
    .first()
    .screenshot({ path: '/tmp/npi-scroll-first-row.png' })
  await scale.getByLabel('搜索BOM', { exact: true }).fill(' SCALE-05000 ')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(pager).toHaveCount(0)
  await scale.getByLabel('搜索BOM', { exact: true }).fill('does-not-exist')
  await expect(
    scale.getByText('没有符合筛选的BOM物料', { exact: true }),
  ).toBeVisible()
  await scale.getByLabel('搜索BOM', { exact: true }).fill('')
  await expect(pager.getByRole('status')).toContainText('第1/50页')
  await scale.getByRole('button', { name: '只看一级', exact: true }).click()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await scale.getByRole('button', { name: '完整BOM', exact: true }).click()
  await table
    .getByRole('button', { name: '收起大BOM物料00001', exact: true })
    .click()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(pager).toHaveCount(0)
  await table
    .getByRole('button', { name: '展开大BOM物料00001', exact: true })
    .click()
  await expect(table.locator('tbody tr')).toHaveCount(100)
  await pager.scrollIntoViewIfNeeded()
  await scale.screenshot({ path: '/tmp/npi-bom-pagination-desktop.png' })
  await scale.setViewportSize({ width: 390, height: 844 })
  await pager.getByRole('button', { name: '末页', exact: true }).click()
  await pager.scrollIntoViewIfNeeded()
  assert.equal(
    await scale.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await scale.screenshot({ path: '/tmp/npi-bom-pagination-mobile.png' })
  await scale.getByLabel('搜索BOM', { exact: true }).fill('SCALE-05000')
  await table.getByRole('button', { name: /建议跟踪|设为重点/ }).click()
  await scale
    .getByLabel('回复责任人', { exact: true })
    .selectOption(accounts.procurement!.id)
  await saved(scale)
  const scaleDetail = await detail(scale, scaleProject.id)
  const scaleTracked = scaleDetail.items.find(
    (i: { bomItemId: string }) => i.bomItemId === tree.rows[4999].id,
  )
  assert.ok(scaleTracked)
  assert.equal(scaleDetail.untrackedBomCount, 4999)
  await apiFixture(
    'procurement',
    `/tracking/${scaleTracked.id}/complete`,
    'POST',
    {
      expectedVersion: scaleTracked.version,
      actualCompleteDate: day,
    },
  )
  await apiFixture(
    'technical',
    `/projects/${scaleProject.id}/external-items`,
    'POST',
    {
      name: '未完成的BOM外物料',
      qty: '2',
      ownerId: accounts.procurement!.id,
      requiredDate: day,
      affectsKit: true,
    },
  )
  await scale.reload({ waitUntil: 'domcontentloaded' })
  await scale.getByRole('button', { name: scaleName, exact: true }).click()
  await scale.getByRole('tab', { name: '样机齐套', exact: true }).click()
  const readiness = scale.getByRole('group', {
    name: '齐套物料统计',
    exact: true,
  })
  await expect(
    readiness.getByRole('button', { name: /^已满足/ }).locator('strong'),
  ).toHaveText('1')
  await expect(
    readiness.getByRole('button', { name: /^缺料/ }).locator('strong'),
  ).toHaveText('1')
  await expect(
    readiness.getByRole('button', { name: /^未跟踪/ }).locator('strong'),
  ).toHaveText('4999')
  await readiness.getByRole('button', { name: /^已满足/ }).click()
  const kitRows = scale
    .getByRole('region', { name: '齐套物料清单', exact: true })
    .locator('tbody tr')
  await expect(kitRows).toHaveCount(1)
  await expect(kitRows.first()).toContainText('大BOM物料05000')
  await readiness.getByRole('button', { name: /^缺料/ }).click()
  await expect(kitRows).toHaveCount(1)
  await expect(kitRows.first()).toContainText('未完成的BOM外物料')
  await scale.evaluate(() => window.scrollTo(0, 0))
  await scale.screenshot({
    path: '/tmp/npi-kit-readiness-mobile.png',
    fullPage: true,
  })
  await scale.setViewportSize({ width: 1440, height: 1000 })
  await scale.evaluate(() => window.scrollTo(0, 0))
  await scale.screenshot({
    path: '/tmp/npi-kit-readiness-desktop.png',
    fullPage: true,
  })
  await readiness.getByRole('button', { name: /^未跟踪/ }).click()
  await expect(
    scale.getByRole('tab', { name: 'ERP BOM', exact: true }),
  ).toHaveAttribute('data-state', 'active')
  await expect(pager.getByRole('status')).toContainText('共4999行')
  await scale.getByLabel('搜索BOM', { exact: true }).fill('SCALE-05000')
  await expect(table.locator('tbody tr')).toHaveCount(0)
  // Old tracked rows must not reduce the new active BOM's untracked count.
  await importBom(scale, await workbook('SCALE-REPLACEMENT'))
  assert.equal((await detail(scale, scaleProject.id)).untrackedBomCount, 1)
  console.log(
    'PASS: full 5000-row/8-level XLSX import, original download, bounded preview/validation/tree pagination, search reset, collapse/expand, last-row tracking, mobile layout and actual-completion readiness with untracked current-version isolation.',
  )
  // External material form: role-specific choices and durable per-actor default.
  await scale.getByRole('tab', { name: '样机齐套', exact: true }).click()
  const addExternalButton = scale.getByRole('button', {
    name: '添加BOM外物料',
    exact: true,
  })
  await addExternalButton.click()
  const externalDialog = scale.getByRole('dialog', {
    name: '添加BOM外物料',
    exact: true,
  })
  const externalOwner = externalDialog.getByLabel('回复责任人', { exact: true })
  await expect(
    externalDialog.getByLabel('物料类型', { exact: true }),
  ).toHaveValue('purchase')
  await expect(externalOwner).toHaveValue(accounts.procurement!.id)
  assert.ok(
    !(
      await externalOwner
        .locator('option')
        .evaluateAll((items) =>
          items.map((i) => (i as HTMLOptionElement).value),
        )
    ).includes(accounts.manufacturing!.id),
  )
  await externalDialog
    .getByLabel('物料名称', { exact: true })
    .fill('取消和失败不创建')
  await externalDialog.getByLabel('数量', { exact: true }).fill('0')
  await externalOwner.selectOption(accounts.otherBuyer!.id)
  await externalDialog
    .getByRole('button', { name: '保存', exact: true })
    .click()
  await expect(externalDialog.getByRole('alert')).toBeVisible()
  await expect(
    externalDialog.getByLabel('物料名称', { exact: true }),
  ).toHaveValue('取消和失败不创建')
  assert.equal(
    (await apiFixture('technical', '/meta')).recentProcurementOwnerId,
    accounts.procurement!.id,
  )
  await externalDialog
    .getByRole('button', { name: '取消', exact: true })
    .click()
  await addExternalButton.click()
  await expect(externalOwner).toHaveValue(accounts.procurement!.id)
  await externalOwner.selectOption(accounts.otherBuyer!.id)
  const recentName = `最近采购人验证-${Date.now()}`
  await externalDialog.getByLabel('物料名称', { exact: true }).fill(recentName)
  await externalDialog
    .getByLabel('规格', { exact: true })
    .fill('类型切换保留规格')
  await externalDialog
    .getByLabel('物料类型', { exact: true })
    .selectOption('material')
  await expect(externalOwner).toHaveValue('')
  assert.ok(
    !(
      await externalOwner
        .locator('option')
        .evaluateAll((items) =>
          items.map((i) => (i as HTMLOptionElement).value),
        )
    ).includes(accounts.procurement!.id),
  )
  await externalOwner.selectOption(accounts.manufacturing!.id)
  await externalDialog
    .getByLabel('物料类型', { exact: true })
    .selectOption('purchase')
  await expect(externalOwner).toHaveValue(accounts.otherBuyer!.id)
  await expect(externalDialog.getByLabel('规格', { exact: true })).toHaveValue(
    '类型切换保留规格',
  )
  await saved(scale)
  assert.equal(
    (await apiFixture('technical', '/meta')).recentProcurementOwnerId,
    accounts.otherBuyer!.id,
  )
  const recentWork = await apiFixture('otherBuyer', '/workbench/procurement')
  assert.ok(
    recentWork.items.some(
      (i: { name: string; status: string }) =>
        i.name === recentName && i.status === 'pending_reply',
    ),
  )
  const afterRecent = await detail(scale, scaleProject.id)
  assert.equal(
    afterRecent.items.filter((i: { name: string }) => i.name === recentName)
      .length,
    1,
  )
  assert.equal(
    afterRecent.items.filter(
      (i: { name: string }) => i.name === '取消和失败不创建',
    ).length,
    0,
  )
  await addExternalButton.click()
  await expect(externalOwner).toHaveValue(accounts.otherBuyer!.id)
  await externalDialog.screenshot({
    path: '/tmp/npi-external-recent-desktop.png',
  })
  await externalDialog
    .getByRole('button', { name: '取消', exact: true })
    .click()
  await scale.reload({ waitUntil: 'domcontentloaded' })
  await scale.getByRole('button', { name: scaleName, exact: true }).click()
  await scale.getByRole('tab', { name: '样机齐套', exact: true }).click()
  await scale.setViewportSize({ width: 390, height: 844 })
  await addExternalButton.click()
  await expect(externalOwner).toHaveValue(accounts.otherBuyer!.id)
  assert.equal(
    await externalDialog.evaluate((e) => e.scrollWidth > e.clientWidth + 1),
    false,
  )
  await externalDialog.screenshot({
    path: '/tmp/npi-external-recent-mobile.png',
  })
  const mobileExternalName = `手机新增采购件-${Date.now()}`
  await externalDialog
    .getByLabel('物料名称', { exact: true })
    .fill(mobileExternalName)
  await saved(scale)
  assert.ok(
    (await apiFixture('otherBuyer', '/workbench/procurement')).items.some(
      (i: { name: string }) => i.name === mobileExternalName,
    ),
  )
  console.log(
    'PASS: external purchase default survives reload, role-specific options, type-switch field preservation, failure/cancel isolation, single saved task and mobile form.',
  )
  // Phone BOM opens on exceptions; search can still reach untracked deep rows.
  await scale.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  const phoneBook = new ExcelJS.Workbook()
  await phoneBook.xlsx.load(
    Uint8Array.from(await workbook('PHONE-ROOT')).buffer,
  )
  const phoneSheet = phoneBook.worksheets[0]!
  phoneSheet.getCell('J5').value = '子件规格'
  phoneSheet.getRow(6).values = [
    '+',
    10,
    'PHONE-ROOT',
    '手机样机总成',
    1,
    '套',
    '自制',
    '总成库',
    '装配',
    '160机座',
  ]
  phoneSheet.getRow(7).values = [
    '++',
    20,
    'PHONE-RISK',
    '手机异常机壳',
    1,
    '只',
    '自制',
    '半成品库',
    '金工',
    '铸铝机壳',
  ]
  const longPhoneCode = 'PHONE-UNTRACKED-' + 'ABCDEFGHIJ'.repeat(8)
  phoneSheet.getRow(8).values = [
    '+++',
    30,
    longPhoneCode,
    '深层未跟踪定位件',
    4,
    '只',
    '采购',
    '标准件库',
    '装配',
    '带台阶定位销'.repeat(16),
  ]
  phoneSheet.getRow(9).values = [
    '++',
    40,
    'PHONE-COMPLETE',
    '手机已完成轴承',
    2,
    '只',
    '采购',
    '采购库',
    '装配',
    '6208',
  ]
  await importBom(scale, Buffer.from(await phoneBook.xlsx.writeBuffer()))
  const phoneTree = await apiFixture(
    'technical',
    `/projects/${scaleProject.id}/bom/tree`,
  )
  await apiFixture(
    'technical',
    `/bom-items/${phoneTree.rows[1].id}/tracking`,
    'PATCH',
    {
      ownerId: accounts.manufacturing!.id,
      requiredDate: day,
      trackingEnabled: true,
      affectsKit: true,
      expectedVersion: 0,
    },
  )
  const phoneComplete = await apiFixture(
    'technical',
    `/bom-items/${phoneTree.rows[3].id}/tracking`,
    'PATCH',
    {
      ownerId: accounts.procurement!.id,
      requiredDate: day,
      trackingEnabled: true,
      affectsKit: true,
      expectedVersion: 0,
    },
  )
  await apiFixture(
    'procurement',
    `/tracking/${phoneComplete.id}/complete`,
    'POST',
    {
      expectedVersion: phoneComplete.version,
      actualCompleteDate: day,
    },
  )
  await scale.reload({ waitUntil: 'domcontentloaded' })
  await scale.getByRole('button', { name: scaleName, exact: true }).click()
  await scale.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table).toContainText('手机异常机壳')
  await expect(table).toContainText('待回复')
  await expect(table).toContainText('半成品库')
  await expect(table).toContainText('上级：手机样机总成')
  await expect(
    scale.getByRole('button', { name: '异常物料', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  assert.equal(
    await table.evaluate((e) => e.scrollWidth > e.clientWidth + 1),
    false,
  )
  await table.screenshot({ path: '/tmp/npi-phone-bom-exceptions.png' })
  await scale.getByLabel('搜索BOM', { exact: true }).fill('PHONE-UNTRACKED')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table).toContainText(longPhoneCode)
  await expect(table).toContainText('上级：手机异常机壳')
  await expect(table).toContainText('标准件库')
  assert.equal(
    await table.evaluate((e) => e.scrollWidth > e.clientWidth + 1),
    false,
  )
  await table.screenshot({ path: '/tmp/npi-phone-bom-search.png' })
  const phoneTrack = table.getByRole('button', { name: /设为重点|建议跟踪/ })
  const trackBox = await phoneTrack.boundingBox()
  assert.ok(trackBox && trackBox.x >= 0 && trackBox.x + trackBox.width <= 391)
  await phoneTrack.click()
  await saved(scale)
  const phoneDetail = await detail(scale, scaleProject.id)
  assert.ok(
    phoneDetail.items.some(
      (i: { bomItemId: string; trackingEnabled: boolean }) =>
        i.bomItemId === phoneTree.rows[2].id && i.trackingEnabled,
    ),
  )
  await scale.getByLabel('搜索BOM', { exact: true }).fill('')
  await expect(table.locator('tbody tr')).toHaveCount(2)
  await scale.getByLabel('搜索BOM', { exact: true }).fill('no-such-phone-part')
  await expect(table.locator('tbody tr')).toHaveCount(0)
  await expect(
    scale.getByText('没有符合筛选的BOM物料', { exact: true }),
  ).toBeVisible()
  await scale.getByLabel('搜索BOM', { exact: true }).fill('')
  await expect(table.locator('tbody tr')).toHaveCount(2)
  await scale.getByRole('button', { name: '完整BOM', exact: true }).click()
  await expect(table.locator('tbody tr')).toHaveCount(4)
  await table
    .getByRole('button', { name: '收起手机样机总成', exact: true })
    .click()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await scale.getByRole('button', { name: '异常物料', exact: true }).click()
  await expect(table.locator('tbody tr')).toHaveCount(2)
  await scale.getByRole('button', { name: '完整BOM', exact: true }).click()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await scale.getByLabel('搜索BOM', { exact: true }).fill('PHONE-UNTRACKED')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table).toContainText('深层未跟踪定位件')
  await scale.getByLabel('搜索BOM', { exact: true }).fill('')
  await table
    .getByRole('button', { name: '展开手机样机总成', exact: true })
    .click()
  await scale.setViewportSize({ width: 1440, height: 1000 })
  await expect(table.locator('tbody tr')).toHaveCount(4)
  await scale.setViewportSize({ width: 390, height: 844 })
  await expect(table.locator('tbody tr')).toHaveCount(4)
  // Reopening the project resets its default; resize reacts until the user chooses a filter.
  await scale.setViewportSize({ width: 1440, height: 1000 })
  await scale.reload({ waitUntil: 'domcontentloaded' })
  await scale.getByRole('button', { name: scaleName, exact: true }).click()
  await scale.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  await expect(table.locator('tbody tr')).toHaveCount(4)
  await table.screenshot({ path: '/tmp/npi-bom-context-desktop.png' })
  await scale.setViewportSize({ width: 390, height: 844 })
  await expect(table.locator('tbody tr')).toHaveCount(2)
  assert.equal(
    await scale.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  console.log(
    'PASS: phone default exceptions, complete-tree search, mobile cards without horizontal scrolling, long code/spec wrapping, parent/warehouse/status context, deep-row tracking and explicit filter preservation across resize.',
  )
  const beforeStop = await detail(scale, scaleProject.id)
  for (const rowId of [phoneTree.rows[1].id, phoneTree.rows[2].id]) {
    const tracked = beforeStop.items.find(
      (i: { bomItemId: string }) => i.bomItemId === rowId,
    )
    await apiFixture('technical', `/bom-items/${rowId}/tracking`, 'PATCH', {
      ownerId: tracked.ownerId,
      requiredDate: day,
      expectedVersion: tracked.version,
      trackingEnabled: false,
      affectsKit: false,
      reason: '停止跟踪边界验证',
    })
  }
  await scale.reload({ waitUntil: 'domcontentloaded' })
  await scale.getByRole('button', { name: scaleName, exact: true }).click()
  await scale.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  await expect(table.locator('tbody tr')).toHaveCount(0)
  await expect(
    scale.getByText('当前没有异常BOM物料', { exact: true }),
  ).toBeVisible()
  await scale.getByLabel('搜索BOM', { exact: true }).fill('PHONE-RISK')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table.locator('td[data-label="状态 / 责任人"]')).toHaveText(
    '未跟踪',
  )
  console.log(
    'PASS: collapsed normal ancestors never hide exception results, and stopped tracking is excluded while remaining searchable.',
  )
  // Manufacturing exception: paged BOM selection, one transaction, explicit conflict reload.
  await scale.setViewportSize({ width: 1440, height: 1000 })
  const exceptionBook = new ExcelJS.Workbook()
  await exceptionBook.xlsx.load(
    Uint8Array.from(await workbook('EXC-0001')).buffer,
  )
  const exceptionSheet = exceptionBook.worksheets[0]!
  for (let i = 1; i <= 22; i++)
    exceptionSheet.getRow(i + 5).values = [
      '+'.repeat(i === 1 ? 1 : i === 22 ? 3 : 2),
      i * 10,
      `EXC-${String(i).padStart(4, '0')}`,
      `制造跟踪件${i}`,
      1,
      '只',
      '自制',
      '半成品库',
      '金工',
    ]
  await importBom(scale, Buffer.from(await exceptionBook.xlsx.writeBuffer()))
  const exceptionTree = await apiFixture(
    'technical',
    `/projects/${scaleProject.id}/bom/tree`,
  )
  await apiFixture(
    'technical',
    `/bom-items/${exceptionTree.rows[1].id}/tracking`,
    'PATCH',
    {
      expectedVersion: 0,
      ownerId: accounts.procurement!.id,
      requiredDate: day,
      affectsKit: true,
      trackingEnabled: true,
    },
  )
  const doneExceptionRow = await apiFixture(
    'technical',
    `/bom-items/${exceptionTree.rows[2].id}/tracking`,
    'PATCH',
    {
      expectedVersion: 0,
      ownerId: accounts.manufacturing!.id,
      requiredDate: day,
      affectsKit: true,
      trackingEnabled: true,
    },
  )
  await apiFixture(
    'manufacturing',
    `/tracking/${doneExceptionRow.id}/complete`,
    'POST',
    { expectedVersion: doneExceptionRow.version, actualCompleteDate: day },
  )
  await scale.getByRole('tab', { name: '制造准备', exact: true }).click()
  await expect(
    scale.getByRole('button', { name: '添加异常件', exact: true }),
  ).toHaveCount(0)
  const exceptionMfg = await pageFor('manufacturing')
  await openProjectDirectory(exceptionMfg, scaleName)
  await exceptionMfg.getByRole('tab', { name: '制造准备', exact: true }).click()
  await exceptionMfg
    .getByRole('button', { name: '添加异常件', exact: true })
    .click()
  const exceptionDialog = exceptionMfg.getByRole('dialog', {
    name: '添加制造异常件',
    exact: true,
  })
  await expect(
    exceptionDialog.getByRole('button', { name: /^选择EXC-0002 / }),
  ).toBeDisabled()
  await expect(
    exceptionDialog.getByRole('button', { name: /^选择EXC-0003 / }),
  ).toBeDisabled()
  await exceptionDialog.locator('.npi-exception-list').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await exceptionDialog
    .getByRole('navigation', { name: '异常件BOM分页', exact: true })
    .getByRole('button', { name: '末页', exact: true })
    .click()
  await expect
    .poll(() =>
      exceptionDialog
        .locator('.npi-exception-list')
        .evaluate((el) => el.scrollTop),
    )
    .toBe(0)
  await expect(
    exceptionDialog.getByRole('button', { name: /^选择EXC-0021 / }),
  ).toBeInViewport()
  await exceptionDialog
    .getByRole('button', {
      name: '选择EXC-0022 制造跟踪件22 第27行',
      exact: true,
    })
    .click()
  await expect(exceptionDialog).toContainText('上级：制造跟踪件21')
  await exceptionDialog
    .getByLabel('预计完成日期', { exact: true })
    .fill(relativeDay(3))
  await exceptionDialog
    .getByLabel('异常原因', { exact: true })
    .fill('工装修复需要三天')
  await exceptionDialog.screenshot({
    path: '/tmp/npi-mfg-exception-desktop.png',
  })
  await exceptionDialog
    .getByRole('button', { name: '保存异常件', exact: true })
    .click()
  await expect(exceptionDialog).toHaveCount(0)
  const exceptionDetails = await detail(exceptionMfg, scaleProject.id)
  const reported = exceptionDetails.items.find(
    (i: { bomItemId: string }) => i.bomItemId === exceptionTree.rows[21].id,
  )
  assert.ok(reported)
  assert.equal(reported.firstCommittedDate, relativeDay(3))
  assert.equal(reported.currentCommittedDate, relativeDay(3))
  assert.equal(reported.ownerId, accounts.manufacturing!.id)
  const mfgExceptionList = exceptionMfg.getByRole('region', {
    name: '制造异常物料',
    exact: true,
  })
  await expect(
    mfgExceptionList.getByRole('row').filter({ hasText: '制造跟踪件22' }),
  ).toContainText(relativeDay(3))
  await exceptionMfg
    .getByRole('button', { name: '添加异常件', exact: true })
    .click()
  await exceptionDialog
    .getByLabel('搜索异常件BOM', { exact: true })
    .fill('EXC-0022')
  await exceptionDialog
    .getByRole('button', {
      name: '选择EXC-0022 制造跟踪件22 第27行',
      exact: true,
    })
    .click()
  await expect(
    exceptionDialog.getByLabel('预计完成日期', { exact: true }),
  ).toHaveValue(relativeDay(3))
  await exceptionDialog
    .getByLabel('预计完成日期', { exact: true })
    .fill(relativeDay(5))
  await exceptionDialog
    .getByLabel('异常原因', { exact: true })
    .fill('修复延长，确认不影响齐套')
  await exceptionDialog.getByLabel('影响齐套', { exact: true }).uncheck()
  await apiFixture(
    'manufacturing',
    `/tracking/${reported.id}/promise`,
    'POST',
    {
      expectedVersion: reported.version,
      committedDate: relativeDay(4),
      reason: '另一个窗口更新',
    },
  )
  await exceptionDialog
    .getByRole('button', { name: '保存异常件', exact: true })
    .click()
  await expect(exceptionDialog.getByRole('alert')).toContainText('记录已改变')
  await expect(
    exceptionDialog.getByLabel('预计完成日期', { exact: true }),
  ).toHaveValue(relativeDay(5))
  await expect(
    exceptionDialog.getByLabel('异常原因', { exact: true }),
  ).toHaveValue('修复延长，确认不影响齐套')
  await expect(
    exceptionDialog.getByLabel('影响齐套', { exact: true }),
  ).not.toBeChecked()
  const afterConflict = await detail(exceptionMfg, scaleProject.id)
  assert.equal(
    afterConflict.items.find((i: { id: string }) => i.id === reported.id)
      .affectsKit,
    true,
  )
  await exceptionDialog
    .getByRole('button', { name: '重新载入BOM', exact: true })
    .click()
  await expect(
    exceptionDialog.getByRole('button', { name: '保存异常件', exact: true }),
  ).toBeDisabled()
  await exceptionDialog
    .getByRole('button', { name: '核对后载入最新BOM', exact: true })
    .click()
  await expect(
    exceptionDialog.locator('.npi-exception-selected'),
  ).toContainText(relativeDay(4))
  await expect(
    exceptionDialog.getByRole('button', { name: '保存异常件', exact: true }),
  ).toBeEnabled()
  await exceptionMfg.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await exceptionDialog.evaluate((e) => e.scrollWidth > e.clientWidth + 1),
    false,
  )
  await exceptionDialog.screenshot({
    path: '/tmp/npi-mfg-exception-mobile.png',
  })
  await exceptionDialog
    .getByRole('button', { name: '保存异常件', exact: true })
    .click()
  await expect(exceptionDialog).toHaveCount(0)
  const finalException = await detail(exceptionMfg, scaleProject.id)
  const finalTracked = finalException.items.find(
    (i: { id: string }) => i.id === reported.id,
  )
  assert.equal(finalTracked.firstCommittedDate, relativeDay(3))
  assert.equal(finalTracked.currentCommittedDate, relativeDay(5))
  assert.equal(finalTracked.affectsKit, false)
  assert.equal(
    finalException.history.filter(
      (h: { objectId: string }) => h.objectId === reported.id,
    ).length,
    3,
  )
  await exceptionMfg
    .getByRole('tab', { name: '承诺与动态', exact: true })
    .click()
  await expect(exceptionMfg.getByText(/添加制造异常件/).first()).toBeVisible()
  console.log(
    'PASS: manufacturing exception paged selection, disabled purchase/completed rows, atomic first promise, visible exception list, stale-input preservation, explicit reload and mobile save with immutable first commitment.',
  )
  // Procurement home: actual API data, discoverable counts, search and mobile reply.
  const purchasePrefix = `采购首页-${Date.now()}`
  for (const [label, offset] of [
    ['待回复', null],
    ['逾期', -1],
    ['风险', 3],
    ['正常', 0],
    ['远期', 15],
    ['完成', 0],
  ] as const) {
    let purchaseItem = await apiFixture(
      'technical',
      `/projects/${scaleProject.id}/external-items`,
      'POST',
      {
        name: `${purchasePrefix}-${label}`,
        ownerId: accounts.otherBuyer!.id,
        requiredDate: day,
        qty: 1,
        unit: '件',
        affectsKit: true,
        supplier: `${purchasePrefix}-供应商`,
        specification: '采购搜索规格',
      },
    )
    if (offset !== null)
      purchaseItem = await apiFixture(
        'otherBuyer',
        `/tracking/${purchaseItem.id}/promise`,
        'POST',
        {
          expectedVersion: purchaseItem.version,
          committedDate: relativeDay(offset),
        },
      )
    if (label === '完成')
      purchaseItem = await apiFixture(
        'otherBuyer',
        `/tracking/${purchaseItem.id}/complete`,
        'POST',
        {
          expectedVersion: purchaseItem.version,
          actualCompleteDate: day,
        },
      )
  }
  const purchasePage = await pageFor('otherBuyer')
  const purchaseList = purchasePage.getByRole('region', {
    name: '我的采购件清单',
    exact: true,
  })
  const purchaseCards = purchasePage.getByRole('group', {
    name: '我的采购待办统计',
    exact: true,
  })
  const purchasesFromApi = (
    await apiFixture('otherBuyer', '/workbench/procurement')
  ).items
  for (const [status, label] of [
    ['pending_reply', '待我回复'],
    ['overdue', '我的逾期件'],
    ['risk', '我的风险件'],
    ['all', '全部未完成'],
  ]) {
    const expected = purchasesFromApi.filter((i: { status: string }) =>
      status === 'all' ? i.status !== 'completed' : i.status === status,
    ).length
    const card = purchaseCards.getByRole('button', { name: label, exact: true })
    await expect(card.locator('strong')).toHaveText(String(expected))
    await card.click()
    await expect(card).toHaveAttribute('aria-pressed', 'true')
    await expect(purchaseList.locator('tbody tr')).toHaveCount(expected)
  }
  const purchaseSearch = purchaseList.getByLabel('搜索我的采购件', {
    exact: true,
  })
  await purchaseSearch.fill(purchasePrefix)
  await expect(purchaseList.locator('tbody tr')).toHaveCount(5)
  await expect(purchaseList.locator('tbody tr').first()).toContainText(
    `${purchasePrefix}-逾期`,
  )
  await purchaseSearch.fill(`${purchasePrefix}-供应商`)
  await expect(purchaseList.locator('tbody tr')).toHaveCount(5)
  await purchaseSearch.fill(scaleName)
  await expect(
    purchaseList.getByText(`${purchasePrefix}-待回复`, { exact: true }),
  ).toBeVisible()
  await purchaseSearch.fill('不会匹配的采购物料')
  await expect(
    purchaseList.getByText('当前没有符合条件的采购件', { exact: true }),
  ).toBeVisible()
  await purchaseCards
    .getByRole('button', { name: '待我回复', exact: true })
    .click()
  await expect(purchaseSearch).toHaveValue('')
  await purchaseSearch.fill(purchasePrefix)
  await purchasePage.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await purchasePage.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
    false,
  )
  await purchasePage.screenshot({
    path: '/tmp/npi-purchase-home-mobile.png',
    fullPage: true,
  })
  await purchaseList.getByRole('button', { name: '回复', exact: true }).click()
  await purchasePage
    .getByRole('dialog')
    .locator('input[type=date]')
    .fill(relativeDay(2))
  await saved(purchasePage)
  await expect(purchaseList.locator('tbody tr')).toHaveCount(0)
  await expect(purchaseSearch).toHaveValue(purchasePrefix)
  await purchaseCards
    .getByRole('button', { name: '我的风险件', exact: true })
    .click()
  await purchaseSearch.fill(purchasePrefix)
  await expect(purchaseList.locator('tbody tr')).toHaveCount(3)
  await purchaseList.getByLabel('采购筛选', { exact: true }).selectOption('7')
  await expect(purchaseList.locator('tbody tr')).toHaveCount(3)
  await purchaseList
    .getByLabel('采购筛选', { exact: true })
    .selectOption('completed')
  await expect(purchaseList.locator('tbody tr')).toHaveCount(1)
  await purchaseList
    .getByRole('button', { name: '重置筛选', exact: true })
    .click()
  await expect(purchaseSearch).toHaveValue('')
  await purchasePage.setViewportSize({ width: 1440, height: 1000 })
  await purchaseSearch.fill(purchasePrefix)
  await purchasePage.screenshot({
    path: '/tmp/npi-purchase-home-desktop.png',
    fullPage: true,
  })
  console.log(
    'PASS: procurement home API-backed counts, urgency ordering, project/material/supplier search, empty recovery, mobile reply refresh and upcoming/completed filters.',
  )
  await purchaseSearch.fill(`${purchasePrefix}-待回复`)
  const historicalRow = purchaseList
    .locator('tbody tr')
    .filter({ hasText: `${purchasePrefix}-待回复` })
  await expect(historicalRow).toContainText('改期 0 次')
  await historicalRow.getByRole('button', { name: '改期', exact: true }).click()
  await purchasePage
    .getByLabel('预计到货日期', { exact: true })
    .fill(relativeDay(4))
  await purchasePage
    .getByLabel('变更原因（必填）', { exact: true })
    .fill('供应商产能调整，重新确认交期')
  await saved(purchasePage)
  await expect(historicalRow).toContainText('改期 1 次')
  const historyButton = historicalRow.getByRole('button', {
    name: `${purchasePrefix}-待回复承诺历史`,
    exact: true,
  })
  const historyRoute = '**/api/v1/npi/tracking/*/history'
  await purchasePage.route(historyRoute, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '历史服务暂时不可用' }),
    }),
  )
  await historyButton.click()
  const historyDialog = purchasePage.getByRole('dialog')
  await expect(historyDialog.getByRole('alert')).toContainText(
    '历史服务暂时不可用',
  )
  await purchasePage.unroute(historyRoute)
  await historyDialog
    .getByRole('button', { name: '重新载入历史', exact: true })
    .click()
  await expect(historyDialog).toContainText('改期 1 次')
  await expect(historyDialog).toContainText(`首次承诺：${relativeDay(2)}`)
  await expect(historyDialog).toContainText(`当前承诺：${relativeDay(4)}`)
  await expect(historyDialog.locator('.npi-history')).toHaveCount(2)
  await expect(historyDialog).toContainText('供应商产能调整，重新确认交期')
  await expect(historyDialog).toContainText('浏览器-otherBuyer')
  await historyDialog.screenshot({ path: '/tmp/npi-item-history-desktop.png' })
  await purchasePage.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await historyDialog.evaluate((e) => e.scrollWidth > e.clientWidth + 1),
    false,
  )
  await historyDialog.screenshot({ path: '/tmp/npi-item-history-mobile.png' })
  const historyTitle = historyDialog.getByRole('heading')
  const historyClose = await historyDialog
    .getByRole('button', { name: 'Close', exact: true })
    .boundingBox()
  assert.ok(historyClose)
  assert.equal(
    await historyTitle.evaluate((heading, close) => {
      const range = document.createRange()
      range.selectNodeContents(heading)
      return Array.from(range.getClientRects()).some(
        (rect) =>
          rect.right > close.x &&
          rect.left < close.x + close.width &&
          rect.bottom > close.y &&
          rect.top < close.y + close.height,
      )
    }, historyClose),
    false,
  )
  await historyDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await purchaseCards
    .getByRole('button', { name: '待我回复', exact: true })
    .click()
  await purchaseSearch.fill(recentName)
  await purchaseList
    .getByRole('button', { name: `${recentName}承诺历史`, exact: true })
    .click()
  await expect(historyDialog).toContainText('尚无承诺记录')
  await expect(historyDialog).not.toContainText('供应商产能调整，重新确认交期')
  await historyDialog.getByRole('button', { name: '关闭', exact: true }).click()
  console.log(
    'PASS: purchase change count refresh, scoped history, first/current dates, reasons and actor timeline, service error retry, empty-history isolation and mobile history layout.',
  )
  const duplicateFocusName = `同名定位件-${Date.now()}`
  const locatedItems = []
  for (const [specification, offset] of [
    ['定位规格A', 40],
    ['定位规格B', 20],
  ] as const) {
    let focusTrack = await apiFixture(
      'technical',
      `/projects/${scaleProject.id}/external-items`,
      'POST',
      {
        name: duplicateFocusName,
        specification,
        trackingType: 'material',
        ownerId: accounts.manufacturing!.id,
        requiredDate: day,
        qty: 1,
        unit: '件',
        affectsKit: true,
      },
    )
    focusTrack = await apiFixture(
      'manufacturing',
      `/tracking/${focusTrack.id}/promise`,
      'POST',
      {
        expectedVersion: focusTrack.version,
        committedDate: relativeDay(offset),
      },
    )
    locatedItems.push(focusTrack)
  }
  const focusPage = await pageFor('manufacturing')
  await focusPage.getByRole('button', { name: '首页', exact: true }).click()
  const focusProjectRow = focusPage
    .getByRole('region', { name: '项目进度列表', exact: true })
    .locator('tbody tr')
    .filter({ hasText: scaleName })
  await focusProjectRow
    .getByRole('button', { name: duplicateFocusName, exact: true })
    .click()
  await expect(
    focusPage.getByRole('tab', { name: '样机齐套', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  const focusMaterials = focusPage.getByRole('region', {
    name: '齐套物料清单',
    exact: true,
  })
  await expect(focusMaterials.locator('tbody tr')).toHaveCount(1)
  const focusRow = focusMaterials.locator('tbody tr').first()
  await expect(focusRow).toHaveAttribute('data-npi-item', locatedItems[0].id)
  await expect(focusRow).toContainText('定位规格A')
  await expect(focusMaterials).not.toContainText('定位规格B')
  await expect(focusRow).toBeInViewport()
  await focusRow.getByRole('button', { name: '改期', exact: true }).click()
  await focusPage
    .getByLabel('当前承诺日期', { exact: true })
    .fill(relativeDay(41))
  await focusPage
    .getByLabel('变更原因（必填）', { exact: true })
    .fill('定位后直接核实并回复')
  await saved(focusPage)
  await expect(focusRow).toContainText(relativeDay(41))
  await expect(focusMaterials.locator('tbody tr')).toHaveCount(1)
  await focusPage.screenshot({
    path: '/tmp/npi-item-focus-desktop.png',
    fullPage: true,
  })
  await focusPage.getByRole('button', { name: '取消定位', exact: true }).click()
  await expect(
    focusMaterials.locator('tbody tr').filter({ hasText: duplicateFocusName }),
  ).toHaveCount(2)
  await expect(
    focusPage.getByRole('status', { name: '事项定位', exact: true }),
  ).toHaveCount(0)
  const focusProjectDetail = await apiFixture(
    'technical',
    `/projects/${scaleProject.id}`,
  )
  let focusNode = focusProjectDetail.items.find(
    (i: { trackingType: string }) => i.trackingType === 'process',
  )
  focusNode = await apiFixture(
    'technical',
    `/tracking/${focusNode.id}/plan`,
    'PATCH',
    {
      expectedVersion: focusNode.version,
      requiredDate: relativeDay(-367),
      reason: '制造待办定位验收',
    },
  )
  focusNode = await apiFixture(
    'manufacturing',
    `/tracking/${focusNode.id}/promise`,
    'POST',
    {
      expectedVersion: focusNode.version,
      committedDate: relativeDay(-366),
      reason: '制造待办定位验收',
    },
  )
  await focusPage.getByRole('button', { name: '首页', exact: true }).click()
  await focusPage.getByRole('button', { name: '刷新', exact: true }).click()
  await focusPage.setViewportSize({ width: 390, height: 844 })
  await focusPage
    .locator('.npi-work-brief')
    .getByRole('button')
    .filter({ hasText: `${scaleName} · 工艺准备` })
    .click()
  await expect(
    focusPage.getByRole('tab', { name: '制造准备', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  const locatedNode = focusPage.locator(`[data-npi-item="${focusNode.id}"]`)
  await expect(locatedNode).toHaveClass(/npi-focused-item/)
  await expect(locatedNode).toBeInViewport()
  await expect(
    locatedNode.getByRole('button', { name: '改期', exact: true }),
  ).toBeEnabled()
  assert.equal(
    await focusPage.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
    false,
  )
  await focusPage.screenshot({
    path: '/tmp/npi-item-focus-mobile.png',
    fullPage: true,
  })
  await focusPage.getByRole('button', { name: '首页', exact: true }).click()
  await focusPage
    .getByRole('region', { name: '项目进度列表', exact: true })
    .getByRole('button', { name: scaleName, exact: true })
    .click()
  await expect(
    focusPage.getByRole('tab', { name: '概览', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    focusPage.getByRole('status', { name: '事项定位', exact: true }),
  ).toHaveCount(0)
  console.log(
    'PASS: exact-ID bottleneck drilldown with duplicate names, focused reply refresh, clear-to-exceptions, completed read-only history target, mobile manufacturing todo focus and ordinary project navigation reset.',
  )
  // Ordinary navigation starts at the top; object drilldowns above remain focused.
  await scale.setViewportSize({ width: 1440, height: 1000 })
  await scale.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await scale.getByRole('button', { name: '首页', exact: true }).click()
  await expect.poll(() => scale.evaluate(() => scrollY)).toBe(0)
  await scale.getByRole('button', { name: scaleName, exact: true }).click()
  await expect(
    scale.getByRole('tab', { name: '概览', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => scale.evaluate(() => scrollY)).toBe(0)
  console.log(
    'PASS: explicit navigation resets scroll while targeted item drilldowns retain focus; BOM and preview paging reveal the new first row below the sticky project summary.',
  )
  const quantityProject = await apiFixture('technical', '/projects', 'POST', {
    name: `数量精度-${Date.now()}`,
    motorModel: 'DECIMAL-UI',
    technicalOwnerId: accounts.technical!.id,
    manufacturingOwnerId: accounts.manufacturing!.id,
    requiredKitDate: day,
    prototypeRequiredDate: relativeDay(5),
  })
  const quantityDetail = await apiFixture(
    'technical',
    `/projects/${quantityProject.id}`,
  )
  const quantityPage = await pageFor('technical')
  await quantityPage
    .getByRole('button', { name: quantityDetail.name, exact: true })
    .click()
  await quantityPage.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  const quantityBook = new ExcelJS.Workbook()
  const quantityFixture = await workbook('PRECISE-001')
  await quantityBook.xlsx.load(
    new Uint8Array(quantityFixture) as unknown as Parameters<
      typeof quantityBook.xlsx.load
    >[0],
  )
  quantityBook.worksheets[0]!.getCell('E6').value = '999999999999.123456'
  const originalQuantityBytes = Buffer.from(
    await quantityBook.xlsx.writeBuffer(),
  )
  await importBom(quantityPage, originalQuantityBytes)
  await expect(
    quantityPage.getByRole('table', { name: '完整BOM明细', exact: true }),
  ).toContainText('999999999999.123456')
  quantityBook.worksheets[0]!.getCell('E6').value = '999999999999.123457'
  await importBom(
    quantityPage,
    Buffer.from(await quantityBook.xlsx.writeBuffer()),
  )
  await quantityPage
    .getByRole('button', { name: '与上一版本比较', exact: true })
    .click()
  await expect(
    quantityPage.getByText(
      '数量变化 · PRECISE-001 · 999999999999.123456 → 999999999999.123457',
      { exact: false },
    ),
  ).toBeVisible()
  await quantityPage.screenshot({
    path: '/tmp/npi-quantity-diff-desktop.png',
    fullPage: true,
  })
  quantityBook.worksheets[0]!.getCell('E6').value = '1.2345675'
  await quantityPage
    .getByLabel('导入模板', { exact: true })
    .selectOption('erp-multilevel-v1')
  await quantityPage.getByLabel('上传ERP BOM', { exact: true }).setInputFiles({
    name: 'rounded.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await quantityBook.xlsx.writeBuffer()),
  })
  await quantityPage
    .getByRole('button', { name: '解析预览', exact: true })
    .click()
  await expect(
    quantityPage.getByRole('table', { name: 'BOM导入预览', exact: true }),
  ).toContainText('1.234568')
  await quantityPage.getByText(/查看校验信息/).click()
  await expect(
    quantityPage.getByText(/数量按6位小数舍入为1.234568/),
  ).toBeVisible()
  await quantityPage
    .getByRole('button', { name: '取消预览', exact: true })
    .click()
  const quantityFinal = await detail(quantityPage, quantityProject.id)
  assert.equal(quantityFinal.imports.length, 2)
  const quantityOriginal = await quantityPage.request.get(
    root +
      `/api/v1/npi/projects/${quantityProject.id}/bom/${quantityFinal.imports[1].id}/source`,
  )
  assert.equal(quantityOriginal.status(), 200)
  assert.deepEqual(await quantityOriginal.body(), originalQuantityBytes)
  console.log(
    'PASS: exact 18-digit decimal text through actual XLSX UI, one-millionth version difference, visible half-up rounding warning and unchanged original.',
  )
  const settingsPrefix = `配置验收-${Date.now()}`
  const settingsEmailPrefix = `settings-${Date.now()}`
  const settingsPeople: Array<{ id: string; name: string; email: string }> = []
  for (let i = 0; i < 26; i++) {
    const account = {
      id: crypto.randomUUID(),
      name: `${settingsPrefix}-人员${String(i === 23 ? 24 : i).padStart(2, '0')}`,
      email: `${settingsEmailPrefix}-${String(i).padStart(2, '0')}-long-address-for-mobile@browser.test.invalid`,
    }
    await client`insert into users(id,email,name,active) values(${account.id},${account.email},${account.name},${i < 25})`
    if (i < 24)
      await client`insert into npi_user_roles(user_id,role) values(${account.id},${i < 20 ? 'technical' : 'procurement'})`
    settingsPeople.push(account)
  }
  const settingsBase = (await apiFixture('admin', '/meta')).templates.find(
    (t: { id: string }) => t.id === 'erp-multilevel-v1',
  ).config
  for (let i = 0; i < 12; i++) {
    await apiFixture('admin', '/templates', 'PUT', {
      config: {
        ...settingsBase,
        id: crypto.randomUUID(),
        name: `${settingsPrefix}-模板${String(i).padStart(2, '0')}`,
        sheetName: `${settingsEmailPrefix}-${String(i).padStart(2, '0')}`,
      },
      enabled: false,
      expectedVersion: 0,
    })
  }
  const templateAdmin = await pageFor('admin', true)
  await templateAdmin
    .getByRole('button', { name: '基础数据', exact: true })
    .click()
  const settingsTemplates = templateAdmin.getByRole('region', {
    name: '导入模板管理',
    exact: true,
  })
  await settingsTemplates
    .getByLabel('搜索导入模板', { exact: true })
    .fill(settingsPrefix)
  const settingsTemplateRows = settingsTemplates.locator('.npi-settings-row')
  const settingsTemplatePager = settingsTemplates.getByRole('navigation', {
    name: '导入模板分页',
    exact: true,
  })
  await expect(settingsTemplateRows).toHaveCount(10)
  await settingsTemplatePager
    .getByRole('button', { name: '末页', exact: true })
    .click()
  await expect(settingsTemplateRows).toHaveCount(2)
  await expect(settingsTemplateRows.first()).toContainText('模板10')
  await settingsTemplates
    .getByLabel('筛选模板状态', { exact: true })
    .selectOption('enabled')
  await expect(settingsTemplateRows).toHaveCount(0)
  await expect(
    settingsTemplates.getByText('没有匹配的导入模板，请调整搜索或状态筛选。', {
      exact: true,
    }),
  ).toBeVisible()
  await settingsTemplates
    .getByLabel('筛选模板状态', { exact: true })
    .selectOption('disabled')
  await expect(settingsTemplateRows).toHaveCount(10)
  await expect(settingsTemplatePager.getByRole('status')).toContainText(
    '第1/2页',
  )
  await settingsTemplates
    .getByLabel('搜索导入模板', { exact: true })
    .fill(` ${settingsEmailPrefix.toUpperCase()}-09 `)
  await expect(settingsTemplateRows).toHaveCount(1)
  await expect(settingsTemplateRows.first()).toContainText('模板09')
  await expect(settingsTemplatePager).toHaveCount(0)
  await templateAdmin
    .getByRole('button', { name: '系统设置', exact: true })
    .click()
  const settingsUsers = templateAdmin.getByRole('region', {
    name: '业务岗位管理',
    exact: true,
  })
  await settingsUsers
    .getByLabel('搜索岗位人员', { exact: true })
    .fill(settingsPrefix)
  const settingsUserRows = settingsUsers.locator('.npi-settings-row')
  const settingsUserPager = settingsUsers.getByRole('navigation', {
    name: '业务岗位分页',
    exact: true,
  })
  await expect(settingsUserRows).toHaveCount(20)
  await expect(settingsUsers).toContainText('筛选 25 /')
  await settingsUserPager
    .getByRole('button', { name: '末页', exact: true })
    .click()
  await expect(settingsUserRows).toHaveCount(5)
  await expect(settingsUserRows.first()).toContainText('人员20')
  await expect
    .poll(async () => {
      const first = await settingsUserRows.first().boundingBox()
      return !!first && first.y >= 0 && first.y < 844
    })
    .toBe(true)
  await settingsUsers
    .getByLabel('筛选NPI岗位', { exact: true })
    .selectOption('unassigned')
  await expect(settingsUserRows).toHaveCount(1)
  await expect(settingsUserRows.first()).toContainText('人员24')
  await settingsUserRows
    .getByRole('button', { name: '分配岗位', exact: true })
    .click()
  await templateAdmin
    .getByLabel('NPI岗位', { exact: true })
    .selectOption('supervisor')
  let configurationDashboardRequests = 0
  await templateAdmin.route('**/api/v1/npi/dashboard', async (route) => {
    configurationDashboardRequests++
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '配置保存不应请求项目驾驶舱' }),
    })
  })
  await saved(templateAdmin)
  await templateAdmin.unroute('**/api/v1/npi/dashboard')
  assert.equal(configurationDashboardRequests, 0)
  await expect(settingsUserRows).toHaveCount(0)
  await settingsUsers
    .getByLabel('筛选NPI岗位', { exact: true })
    .selectOption('supervisor')
  await expect(settingsUserRows).toHaveCount(1)
  assert.equal(
    (await apiFixture('admin', '/meta')).users.find(
      (u: { id: string }) => u.id === settingsPeople[24]!.id,
    ).role,
    'supervisor',
  )
  assert.equal(
    (await apiFixture('admin', '/meta')).users.find(
      (u: { id: string }) => u.id === settingsPeople[23]!.id,
    ).role,
    'procurement',
  )
  const settingsSearchEmail = ` ${settingsPeople[24]!.email.toUpperCase()} `
  await settingsUsers
    .getByLabel('搜索岗位人员', { exact: true })
    .fill(settingsSearchEmail)
  await expect(settingsUserRows).toHaveCount(1)
  assert.equal(
    await templateAdmin.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  const settingsIdentity = await settingsUserRows
    .first()
    .locator(':scope > div')
    .boundingBox()
  assert.ok(
    settingsIdentity && settingsIdentity.width >= 280,
    'Mobile identity must remain readable beside role actions',
  )
  await templateAdmin.screenshot({
    path: '/tmp/npi-settings-users-mobile.png',
    fullPage: true,
  })
  await templateAdmin
    .getByRole('button', { name: '基础数据', exact: true })
    .click()
  await expect(
    settingsTemplates.getByLabel('搜索导入模板', { exact: true }),
  ).toHaveValue('')
  await templateAdmin
    .getByRole('button', { name: '系统设置', exact: true })
    .click()
  await expect(
    settingsUsers.getByLabel('搜索岗位人员', { exact: true }),
  ).toHaveValue('')
  await settingsUsers
    .getByLabel('搜索岗位人员', { exact: true })
    .fill('不存在的人员')
  await expect(settingsUserRows).toHaveCount(0)
  await settingsUsers
    .getByRole('button', { name: '清除人员筛选', exact: true })
    .click()
  await expect(settingsUserRows).toHaveCount(20)
  await templateAdmin
    .getByRole('button', { name: '基础数据', exact: true })
    .click()
  await settingsTemplates
    .getByRole('button', { name: '清除模板筛选', exact: true })
    .click()
  await settingsTemplates
    .getByLabel('搜索导入模板', { exact: true })
    .fill(settingsPrefix)
  await templateAdmin.setViewportSize({ width: 1440, height: 1000 })
  await templateAdmin.screenshot({
    path: '/tmp/npi-settings-templates-desktop.png',
    fullPage: true,
  })
  await settingsTemplates
    .getByRole('button', { name: '清除模板筛选', exact: true })
    .click()
  await templateAdmin.setViewportSize({ width: 390, height: 844 })
  console.log(
    'PASS: bounded settings pages, module filter reset, name/email/sheet search, enabled and unassigned filters, inactive user exclusion, real role update, recovery and mobile long-email layout.',
  )
  await templateAdmin
    .getByRole('button', { name: '新建导入模板', exact: true })
    .click()
  const editor = templateAdmin.getByRole('dialog')
  const templateName = `表单模板-${Date.now()}`
  const sheetName = `UI-BOM-${Date.now()}`
  await expect(editor.getByLabel('字段映射配置（JSON）')).toHaveCount(0)
  await editor.getByLabel('模板名称', { exact: true }).fill(templateName)
  await editor.getByLabel('工作表名称', { exact: true }).fill(sheetName)
  await editor.getByLabel('表头所在行', { exact: true }).fill('3')
  await editor.getByLabel('数据起始行', { exact: true }).fill('3')
  for (const [label, value] of [
    ['母件编码单元格', 'A1'],
    ['母件名称单元格', 'B1'],
    ['母件规格单元格', 'C1'],
  ])
    await editor.getByLabel(label!, { exact: true }).fill(value!)
  await editor.getByLabel('层级格式', { exact: true }).selectOption('number')
  for (const [label, value] of [
    ['层级', '层'],
    ['物料编码', '编码'],
    ['物料名称', '品名'],
    ['基本用量', '用量'],
    ['计量单位', '单位'],
    ['子件行号', ''],
    ['规格', ''],
    ['供应类型', ''],
    ['仓库', ''],
    ['领料部门', ''],
    ['生效日期', ''],
    ['备注', ''],
    ['跟踪属性', '跟踪属性'],
  ])
    await editor.getByLabel(label + '列标题', { exact: true }).fill(value!)
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('数据起始行')
  await editor.getByLabel('数据起始行', { exact: true }).fill('4')
  await editor
    .getByRole('button', { name: '高级配置（JSON）', exact: true })
    .click()
  const validEditorJson = await editor
    .getByLabel('字段映射配置（JSON）')
    .inputValue()
  await editor.getByLabel('字段映射配置（JSON）').fill('{invalid')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.getByRole('alert')).toBeVisible()
  await expect(
    editor.getByRole('button', { name: '保存', exact: true }),
  ).toBeEnabled()
  await editor
    .getByRole('button', { name: '放弃JSON修改', exact: true })
    .click()
  await expect(editor.getByLabel('模板名称', { exact: true })).toHaveValue(
    templateName,
  )
  await editor
    .getByRole('button', { name: '高级配置（JSON）', exact: true })
    .click()
  const customEditorConfig = JSON.parse(validEditorJson)
  customEditorConfig.fieldMapping.customerNote = '客户标记'
  await editor
    .getByLabel('字段映射配置（JSON）')
    .fill(JSON.stringify(customEditorConfig))
  await editor
    .getByRole('button', { name: '返回表单配置', exact: true })
    .click()
  await editor.getByLabel('启用此模板', { exact: true }).uncheck()
  await templateAdmin.route('**/api/v1/npi/templates', (r) =>
    r.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '暂时无法保存，请重试' }),
    }),
  )
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('暂时无法保存')
  await expect(
    editor.getByLabel('物料编码列标题', { exact: true }),
  ).toHaveValue('编码')
  assert.equal(
    await editor.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    false,
  )
  await editor.screenshot({ path: '/tmp/npi-template-form-mobile.png' })
  await templateAdmin.unroute('**/api/v1/npi/templates')
  await saved(templateAdmin)
  await templateAdmin
    .getByLabel('搜索导入模板', { exact: true })
    .fill(templateName)
  const templateRow = templateAdmin
    .locator('.npi-settings-row')
    .filter({ hasText: templateName })
  await expect(templateRow).toContainText('已停用')
  let templateMeta = await apiFixture('admin', '/meta')
  let newTemplate = templateMeta.templates.find(
    (t: { name: string }) => t.name === templateName,
  )
  assert.equal(newTemplate.enabled, false)
  assert.equal(newTemplate.config.fieldMapping.customerNote, '客户标记')
  assert.equal('specification' in newTemplate.config.fieldMapping, false)
  await templateAdmin.bringToFront()
  await templateRow
    .getByRole('button', { name: '编辑映射', exact: true })
    .click()
  await editor.getByLabel('启用此模板', { exact: true }).check()
  await editor
    .getByLabel('模板名称', { exact: true })
    .fill(templateName + '-本地修改')
  await apiFixture('admin', '/templates', 'PUT', {
    config: newTemplate.config,
    enabled: false,
    expectedVersion: newTemplate.version,
  })
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('记录已改变')
  await expect(editor.getByLabel('模板名称', { exact: true })).toHaveValue(
    templateName + '-本地修改',
  )
  await editor
    .getByRole('button', { name: '载入最新模板（放弃本次修改）', exact: true })
    .click()
  await expect(editor.getByLabel('模板名称', { exact: true })).toHaveValue(
    templateName,
  )
  await editor.getByLabel('启用此模板', { exact: true }).check()
  await saved(templateAdmin)
  await expect(templateRow).toContainText('已启用')
  templateMeta = await apiFixture('admin', '/meta')
  newTemplate = templateMeta.templates.find(
    (t: { name: string }) => t.name === templateName,
  )
  const templateProject = await apiFixture('technical', '/projects', 'POST', {
    name: `模板导入-${Date.now()}`,
    motorModel: 'TEMPLATE-UI',
    technicalOwnerId: accounts.technical!.id,
    manufacturingOwnerId: accounts.manufacturing!.id,
    requiredKitDate: day,
    prototypeRequiredDate: relativeDay(5),
  })
  const templateDetail = await apiFixture(
    'technical',
    `/projects/${templateProject.id}`,
  )
  const templateTech = await pageFor('technical')
  await templateTech
    .getByRole('button', { name: templateDetail.name, exact: true })
    .click()
  await templateTech.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  await templateTech
    .getByLabel('导入模板', { exact: true })
    .selectOption(newTemplate.id)
  const mappedBook = new ExcelJS.Workbook()
  const mappedSheet = mappedBook.addWorksheet(sheetName)
  mappedSheet.getRow(1).values = ['UI-TEMPLATE', '模板母件', 'M160']
  mappedSheet.getRow(3).values = [
    '层',
    '编码',
    '品名',
    '用量',
    '单位',
    '客户标记',
    '跟踪属性',
  ]
  mappedSheet.getRow(4).values = [
    1,
    '001-CUSTOM',
    '表单映射物料',
    1.5,
    '只',
    '测试标记',
    '客户指定件',
  ]
  mappedSheet.getRow(5).values = [
    2,
    '002-STANDARD',
    '普通标准件',
    1,
    '只',
    '',
    '普通标准件',
  ]
  mappedSheet.getRow(6).values = [
    3,
    '003-LONG',
    '深层长周期件',
    1,
    '只',
    '',
    '长周期采购件',
  ]
  mappedSheet.getRow(7).values = [
    1,
    '004-STOCK',
    '常备标准件',
    1,
    '只',
    '',
    '常备库存件',
  ]
  mappedSheet.getRow(8).values = [
    1,
    '005-NEW',
    '新规格外购件',
    1,
    '只',
    '',
    '新规格外购件',
  ]
  mappedSheet.getRow(9).values = [
    1,
    '006-CRITICAL',
    '关键标准件',
    1,
    '只',
    '',
    '普通标准件、关键件',
  ]
  const mappedBytes = Buffer.from(await mappedBook.xlsx.writeBuffer())
  await importBom(templateTech, mappedBytes, 'mapped-bom.xlsx', newTemplate.id)
  const mappedTree = await apiFixture(
    'technical',
    `/projects/${templateProject.id}/bom/tree`,
  )
  assert.equal(mappedTree.rows.length, 6)
  assert.equal(mappedTree.rows[0].materialCode, '001-CUSTOM')
  assert.equal(mappedTree.rows[0].qty, '1.5')
  assert.deepEqual(
    mappedTree.rows.map(
      (r: { suggestedTracking: boolean }) => r.suggestedTracking,
    ),
    [true, false, true, false, true, true],
  )
  assert.deepEqual(mappedTree.rows[2].trackingSuggestion.reasons, [
    '长周期采购件：不限BOM层级',
  ])
  let suggestedProject = await detail(templateTech, templateProject.id)
  assert.equal(
    suggestedProject.items.filter(
      (i: { sourceType: string }) => i.sourceType !== 'MANUFACTURING',
    ).length,
    0,
  )
  assert.equal(suggestedProject.untrackedBomCount, 6)
  await templateTech
    .getByRole('button', { name: '建议待确认', exact: true })
    .click()
  const suggestedRows = templateTech
    .getByRole('table', { name: '完整BOM明细', exact: true })
    .locator('tbody tr')
  await expect(suggestedRows).toHaveCount(4)
  await expect(suggestedRows.filter({ hasText: '深层长周期件' })).toContainText(
    '不限BOM层级',
  )
  await templateTech.setViewportSize({ width: 390, height: 844 })
  await suggestedRows
    .filter({ hasText: '表单映射物料' })
    .getByRole('button', { name: '建议跟踪 +', exact: true })
    .click()
  await expect(templateTech.getByRole('dialog')).toContainText(
    '建议依据：客户指定件',
  )
  await templateTech
    .getByLabel('回复责任人', { exact: true })
    .selectOption(accounts.procurement!.id)
  await saved(templateTech)
  await expect(suggestedRows).toHaveCount(3)
  suggestedProject = await detail(templateTech, templateProject.id)
  const confirmedSuggestions = suggestedProject.items.filter(
    (i: { sourceType: string }) => i.sourceType !== 'MANUFACTURING',
  )
  assert.equal(confirmedSuggestions.length, 1)
  assert.equal(confirmedSuggestions[0].ownerId, accounts.procurement!.id)
  assert.equal(confirmedSuggestions[0].currentCommittedDate, null)
  assert.equal(suggestedProject.untrackedBomCount, 5)
  assert.equal(
    await templateTech.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await templateTech.screenshot({
    path: '/tmp/npi-suggestions-mobile.png',
    fullPage: true,
  })
  await templateAdmin.bringToFront()
  await templateRow
    .getByRole('button', { name: '编辑映射', exact: true })
    .click()
  await editor.getByLabel('启用此模板', { exact: true }).uncheck()
  await saved(templateAdmin)
  await expect(templateRow).toContainText('已停用')
  const mappedSource = await templateTech.request.get(
    root +
      `/api/v1/npi/projects/${templateProject.id}/bom/${mappedTree.importId}/source`,
  )
  assert.equal(mappedSource.status(), 200)
  assert.deepEqual(await mappedSource.body(), mappedBytes)
  console.log(
    'PASS: explicit SRS43 properties survive import, deep suggestions remain visible, default stock/standard exclusions, manual confirmation alone creates tracking, mobile reasons and original bytes.',
  )
  console.log(
    'PASS: structured mobile template editor, optional mappings, advanced JSON recovery, failed-save preservation, explicit conflict reload, activation and actual numeric-level XLSX import.',
  )
  const identityProject = await apiFixture('technical', '/projects', 'POST', {
    name: `物料身份验收-${Date.now()}`,
    motorModel: 'IDENTITY-UI',
    technicalOwnerId: accounts.technical!.id,
    manufacturingOwnerId: accounts.manufacturing!.id,
    requiredKitDate: day,
    prototypeRequiredDate: relativeDay(5),
  })
  const identityDetail = await apiFixture(
    'technical',
    `/projects/${identityProject.id}`,
  )
  const identityTech = await pageFor('technical')
  await identityTech
    .getByRole('button', { name: identityDetail.name, exact: true })
    .click()
  await identityTech.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  const identityBook = new ExcelJS.Workbook()
  const identityCode = '001' + '8'.repeat(90) + 'E-48'
  const identityFixture = await workbook(identityCode)
  await identityBook.xlsx.load(
    new Uint8Array(identityFixture) as unknown as Parameters<
      typeof identityBook.xlsx.load
    >[0],
  )
  const identitySheet = identityBook.worksheets[0]!
  identitySheet.getRow(7).values = [
    '+',
    20,
    identityCode,
    '浏览器关键轴承',
    2,
    '只',
    '采购',
    '采购库',
    '采购',
  ]
  identitySheet.getRow(8).values = [
    '+',
    30,
    'OTHER-CODE',
    '浏览器关键轴承',
    1,
    '只',
    '采购',
    '采购库',
    '采购',
  ]
  await importBom(
    identityTech,
    Buffer.from(await identityBook.xlsx.writeBuffer()),
  )
  const identityTree = await apiFixture(
    'technical',
    `/projects/${identityProject.id}/bom/tree`,
  )
  const identityTracks: Array<{ id: string }> = []
  for (const [index, row] of identityTree.rows.entries()) {
    identityTracks.push(
      await apiFixture('technical', `/bom-items/${row.id}/tracking`, 'PATCH', {
        expectedVersion: 0,
        trackingEnabled: true,
        affectsKit: true,
        trackingType: 'purchase',
        ownerId: index < 2 ? accounts.procurement!.id : accounts.otherBuyer!.id,
        requiredDate: day,
      }),
    )
  }
  await identityTech.getByRole('button', { name: '刷新', exact: true }).click()
  await identityTech.getByRole('tab', { name: '样机齐套', exact: true }).click()
  await identityTech
    .getByLabel('搜索齐套物料', { exact: true })
    .fill('  ' + identityCode + '  ')
  const identityKit = identityTech.getByRole('region', {
    name: '齐套物料清单',
    exact: true,
  })
  await expect(identityKit.locator('tbody tr')).toHaveCount(2)
  await expect(
    identityKit.locator(`[data-npi-item="${identityTracks[0]!.id}"]`),
  ).toContainText('原表第6行')
  await expect(
    identityKit.locator(`[data-npi-item="${identityTracks[1]!.id}"]`),
  ).toContainText('原表第7行')
  const identityBuyer = await pageFor('procurement', true)
  await identityBuyer
    .getByLabel('搜索我的采购件', { exact: true })
    .fill(identityCode)
  const identityList = identityBuyer.getByRole('region', {
    name: '我的采购件清单',
    exact: true,
  })
  await expect(identityList.locator('tbody tr')).toHaveCount(2)
  const identityFirst = identityList.locator(
    `[data-npi-item="${identityTracks[0]!.id}"]`,
  )
  await expect(identityFirst).toContainText('BOM基本用量：1 只')
  await expect(
    identityList.locator(`[data-npi-item="${identityTracks[1]!.id}"]`),
  ).toContainText('BOM基本用量：2 只')
  assert.equal(
    await identityBuyer.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  assert.equal(
    await identityFirst
      .locator('td')
      .first()
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    false,
    'Long ERP code must wrap inside its card, not be clipped by the table scroller',
  )
  await identityFirst.getByRole('button', { name: '回复', exact: true }).click()
  const identityDialog = identityBuyer.getByRole('dialog')
  await expect(identityDialog).toContainText(identityCode)
  await expect(identityDialog).toContainText('原表第6行')
  assert.equal(
    await identityBuyer.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await identityDialog.screenshot({
    path: '/tmp/npi-reference-reply-mobile.png',
  })
  await saved(identityBuyer)
  await expect(
    identityFirst.getByRole('button', { name: '改期', exact: true }),
  ).toBeVisible()
  const identityAfter = await detail(identityTech, identityProject.id)
  assert.equal(
    identityAfter.items.find(
      (i: { id: string }) => i.id === identityTracks[0]!.id,
    ).currentCommittedDate,
    day,
  )
  assert.equal(
    identityAfter.items.find(
      (i: { id: string }) => i.id === identityTracks[1]!.id,
    ).currentCommittedDate,
    null,
  )
  await identityFirst
    .getByRole('button', { name: '浏览器关键轴承承诺历史', exact: true })
    .click()
  await expect(identityDialog).toContainText(identityCode)
  await expect(identityDialog).toContainText('原表第6行')
  await identityDialog
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await identityBuyer
    .getByLabel('搜索我的采购件', { exact: true })
    .fill(identityProject.code)
  await expect(identityList.locator('tbody tr')).toHaveCount(2)
  await identityFirst.screenshot({
    path: '/tmp/npi-reference-material-mobile.png',
  })
  console.log(
    'PASS: ERP code/project-code search, duplicate-name/code row identity, exact-item mobile reply and history, quantities and no unrelated buyer rows.',
  )
  const motherProject = await apiFixture('technical', '/projects', 'POST', {
    name: `母件人工确认-${Date.now()}`,
    motorModel: 'MOTHER-UI',
    technicalOwnerId: accounts.technical!.id,
    manufacturingOwnerId: accounts.manufacturing!.id,
    requiredKitDate: day,
    prototypeRequiredDate: relativeDay(5),
  })
  const motherPage = await pageFor('technical', true)
  const motherDetail = await apiFixture(
    'technical',
    `/projects/${motherProject.id}`,
  )
  await motherPage
    .getByRole('button', { name: motherDetail.name, exact: true })
    .click()
  await motherPage.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  const motherBook = new ExcelJS.Workbook()
  const motherFixture = await workbook('MOTHER-CHILD')
  await motherBook.xlsx.load(
    new Uint8Array(motherFixture) as unknown as Parameters<
      typeof motherBook.xlsx.load
    >[0],
  )
  motherBook.worksheets[0]!.getCell('A4').value = ''
  const motherBytes = Buffer.from(await motherBook.xlsx.writeBuffer())
  await motherPage
    .getByLabel('导入模板', { exact: true })
    .selectOption('erp-multilevel-v1')
  await motherPage.getByLabel('上传ERP BOM', { exact: true }).setInputFiles({
    name: 'missing-mother.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: motherBytes,
  })
  await motherPage
    .getByRole('button', { name: '解析预览', exact: true })
    .click()
  const motherForm = motherPage.getByRole('region', {
    name: '母件信息确认',
    exact: true,
  })
  await motherForm.getByLabel('母件编码', { exact: true }).fill('MANUAL-UI-001')
  await motherForm
    .getByLabel('母件名称', { exact: true })
    .fill('已核对母件名称')
  await motherForm.getByLabel('母件规格', { exact: true }).fill('M180')
  await motherForm
    .getByLabel('母件确认原因', { exact: true })
    .fill('根据图纸核对缺失的母件信息')
  const motherEndpoint = `**/api/v1/npi/projects/${motherProject.id}/bom/import-preview`
  await motherPage.route(motherEndpoint, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '临时不可用，请重试' }),
    }),
  )
  await motherForm
    .getByRole('button', { name: '确认母件并重新预览', exact: true })
    .click()
  await expect(motherForm.getByRole('alert')).toBeVisible()
  await expect(motherForm.getByLabel('母件编码', { exact: true })).toHaveValue(
    'MANUAL-UI-001',
  )
  await expect(
    motherForm.getByLabel('母件确认原因', { exact: true }),
  ).toHaveValue('根据图纸核对缺失的母件信息')
  assert.equal(
    await motherPage.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await motherForm.screenshot({ path: '/tmp/npi-mother-form-mobile.png' })
  await motherPage.unroute(motherEndpoint)
  await motherForm
    .getByRole('button', { name: '确认母件并重新预览', exact: true })
    .click()
  await expect(motherForm).toContainText('确认后：MANUAL-UI-001')
  await motherPage
    .getByRole('button', { name: '保存为草稿', exact: true })
    .click()
  await motherPage.reload()
  await motherPage
    .getByRole('button', { name: motherDetail.name, exact: true })
    .click()
  await motherPage.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
  await motherPage
    .getByRole('button', { name: '恢复预览', exact: true })
    .click()
  await expect(motherForm).toContainText('确认后：MANUAL-UI-001')
  await motherForm
    .getByRole('button', { name: '重新确认母件', exact: true })
    .click()
  await motherForm.getByLabel('母件编码', { exact: true }).fill('MANUAL-UI-002')
  await motherForm
    .getByLabel('母件确认原因', { exact: true })
    .fill('按最新图纸复核')
  await motherForm
    .getByRole('button', { name: '确认母件并重新预览', exact: true })
    .click()
  await expect(motherForm).toContainText('确认后：MANUAL-UI-002')
  await motherPage
    .getByRole('button', { name: '保存为草稿', exact: true })
    .click()
  await motherPage
    .getByRole('button', { name: '恢复预览', exact: true })
    .click()
  await expect(motherForm).toContainText('确认后：MANUAL-UI-002')
  await motherPage
    .getByRole('button', { name: '下一步：解析确认', exact: true })
    .click()
  await motherPage
    .getByRole('button', { name: '确认导入为新版本', exact: true })
    .click()
  await expect(
    motherPage.getByText('BOM新版本导入完成', {
      exact: true,
    }),
  ).toBeVisible()
  const motherImported = await detail(motherPage, motherProject.id)
  const motherEvent = motherImported.events.find(
    (e: { action: string }) => e.action === 'BOM_IMPORTED',
  )
  assert.equal(
    motherEvent.detail.motherConfirmation.confirmed.code,
    'MANUAL-UI-002',
  )
  const motherOriginal = await motherPage.request.get(
    root +
      `/api/v1/npi/projects/${motherProject.id}/bom/${motherImported.imports[0].id}/source`,
  )
  assert.equal(motherOriginal.status(), 200)
  assert.deepEqual(await motherOriginal.body(), motherBytes)
  await motherPage.getByRole('tab', { name: '承诺与动态', exact: true }).click()
  await expect(
    motherPage
      .getByText('确认后：MANUAL-UI-002 · 已核对母件名称 · M180', {
        exact: true,
      })
      .first(),
  ).toBeVisible()
  await motherPage.setViewportSize({ width: 1440, height: 1000 })
  await motherPage.screenshot({
    path: '/tmp/npi-mother-history-desktop.png',
    fullPage: true,
  })
  console.log(
    'PASS: missing mother mobile form, retry preserves input, durable draft reconfirmation, import audit and byte-identical source.',
  )
  if (process.env.NPI_SAMPLE_DIR) {
    const realResults = []
    for (const [sampleName, expectedRows, expectedRoots] of [
      ['161F1246BM0001.xlsx', 47, 16],
      ['161H1866BM0001-M12x30.xlsx', 56, 23],
    ] as const) {
      const sampleBytes: Buffer = fs.readFileSync(
        `${process.env.NPI_SAMPLE_DIR}/${sampleName}`,
      )
      const sampleProject = await apiFixture('technical', '/projects', 'POST', {
        name: `真实BOM验收-${sampleName}-${Date.now()}`,
        motorModel: 'ERP-SAMPLE-VERIFY',
        technicalOwnerId: accounts.technical!.id,
        manufacturingOwnerId: accounts.manufacturing!.id,
        requiredKitDate: day,
        prototypeRequiredDate: relativeDay(5),
      })
      const samplePage = await pageFor('technical')
      const sampleDetail = await apiFixture(
        'technical',
        `/projects/${sampleProject.id}`,
      )
      await samplePage
        .getByRole('button', { name: sampleDetail.name, exact: true })
        .click()
      await samplePage
        .getByRole('tab', { name: 'ERP BOM', exact: true })
        .click()
      await importBom(samplePage, sampleBytes, sampleName)
      const sampleTree = await apiFixture(
        'technical',
        `/projects/${sampleProject.id}/bom/tree`,
      )
      assert.equal(sampleTree.rows.length, expectedRows)
      assert.equal(
        sampleTree.rows.filter((r: { level: number }) => r.level === 1).length,
        expectedRoots,
      )
      assert.equal(
        Math.max(...sampleTree.rows.map((r: { level: number }) => r.level)),
        4,
      )
      const sampleOriginal = await samplePage.request.get(
        root +
          `/api/v1/npi/projects/${sampleProject.id}/bom/${sampleTree.importId}/source`,
      )
      assert.equal(sampleOriginal.status(), 200)
      assert.deepEqual(await sampleOriginal.body(), sampleBytes)
      const sampleById = new Map(
        sampleTree.rows.map((r: { id: string; rowNo: number }) => [
          r.id,
          r.rowNo,
        ]),
      )
      realResults.push({
        name: sampleName,
        rows: sampleTree.rows.map(
          (r: {
            rowNo: number
            level: number
            materialCode: string
            materialName: string
            qty: string
            parentId: string | null
          }) => ({
            rowNo: r.rowNo,
            level: r.level,
            materialCode: r.materialCode,
            materialName: r.materialName,
            qty: r.qty,
            parentRowNo: r.parentId ? sampleById.get(r.parentId) : null,
          }),
        ),
      })
      await samplePage.screenshot({
        path: `/tmp/npi-real-bom-${expectedRows}.png`,
        fullPage: true,
      })
      console.log(
        `PASS: real ERP sample ${sampleName}: ${expectedRows} rows, ${expectedRoots} roots, 4 levels; actual UI import and byte-identical original download.`,
      )
    }
    fs.writeFileSync(
      '/tmp/npi-real-bom-browser.json',
      JSON.stringify(realResults, null, 2),
    )
  } else
    console.log(
      'SKIP: original ERP sample browser checks require NPI_SAMPLE_DIR.',
    )
  assert.deepEqual(errors, [])
  console.log(
    'PASS: isolated real-browser project creation, XLSX imports, buyer mobile promise, MOVED diff, technical migration, manufacturing read-only review, retirement audit, unchanged history and mobile layout.',
  )
} catch (error) {
  failed = true
  console.error(error)
  for (const [i, ctx] of contexts.entries()) {
    const page = ctx.pages()[0]
    if (page) {
      await page
        .screenshot({
          path: `/tmp/npi-bom-browser-failure-${i}.png`,
          fullPage: true,
        })
        .catch(() => {})
      fs.writeFileSync(
        `/tmp/npi-bom-browser-failure-${i}.txt`,
        await page
          .locator('body')
          .innerText()
          .catch(() => 'No page'),
      )
    }
  }
  throw error
} finally {
  if (dev.pid) {
    try {
      process.kill(-dev.pid, 'SIGTERM')
    } catch {
      /* Already stopped. */
    }
  }
  fs.closeSync(log)
  await (db as unknown as { $client: postgres.Sql }).$client.end({ timeout: 5 })
  await migrationClient.end({ timeout: 5 })
  await client.end({ timeout: 5 })
  // macOS can leave Chrome in its kernel exit state indefinitely. All assertions,
  // HTTP service and DB cleanup finish first; preserve failure status on forced exit.
  const deadline = setTimeout(() => {
    console.warn(
      'Chrome退出等待超时；断言结果已保留，测试服务与数据库连接已关闭。',
    )
    process.exit(failed ? 1 : 0)
  }, 10000)
  browserServer.process().kill('SIGKILL')
  await browserServer.kill()
  await browser.close()
  clearTimeout(deadline)
}
