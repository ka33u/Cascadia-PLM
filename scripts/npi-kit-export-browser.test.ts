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
const log = fs.openSync('/tmp/npi-kit-export-browser-server.log', 'w')
try {
  for (const role of ['technical', 'manufacturing']) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@kit-export-browser.test.invalid'},${role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role})`
  }
  const session = await SessionManager.createSession(users.technical!)
  sessions.push(session.session.id)
  const projectName = '齐套导出浏览器验证'
  const project = await service.createProject(users.technical!, {
    name: projectName,
    code: `EX-${crypto.randomUUID().slice(0, 8)}`,
    motorModel: 'EXPORT-BROWSER',
    technicalOwnerId: users.technical,
    manufacturingOwnerId: users.manufacturing,
    requiredKitDate: '2026-10-15',
    prototypeRequiredDate: '2026-10-20',
  })
  const quantity = '999999999999.123456'
  for (let i = 0; i < 26; i++)
    await service.addExternal(users.technical!, project.id, {
      name: i === 0 ? '精密测试件' : `导出物料${i}`,
      trackingType: i === 0 ? 'other' : 'material',
      qty: i === 0 ? quantity : '1',
      unit: '件',
      ownerId: users.manufacturing,
      requiredDate: '2026-10-15',
      affectsKit: true,
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
    if (server.exitCode !== null)
      throw new Error('Isolated export test server exited')
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
      /* child startup */
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
    errors: Array<string> = [],
    writes: Array<string> = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('request', (r) => {
    if (
      r.url().includes('/api/v1/npi/') &&
      ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method())
    )
      writes.push(r.url())
  })
  await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: projectName, exact: true }).click()
  await page.getByRole('tab', { name: '样机齐套', exact: true }).click()
  const region = page.getByRole('region', { name: '齐套物料清单', exact: true })
  const download = async (name: string, output: string) => {
    const received = page.waitForEvent('download')
    await region.getByRole('button', { name, exact: true }).click()
    const file = await received
    assert.equal(await file.failure(), null)
    await file.saveAs(output)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(fs.readFileSync(output) as unknown as ArrayBuffer)
    return workbook.getWorksheet('齐套物料')!
  }
  await expect(
    region.getByRole('button', { name: '导出当前筛选（26项）' }),
  ).toBeEnabled()
  const all = await download(
    '导出当前筛选（26项）',
    '/tmp/npi-kit-export-desktop.xlsx',
  )
  assert.equal(all.rowCount, 31)
  const exported = all.getRows(6, 26)!
  assert.ok(exported.some((row) => row.getCell(3).value === '导出物料25'))
  assert.equal(
    exported.find((row) => row.getCell(3).value === '精密测试件')?.getCell(10)
      .value,
    quantity,
  )
  await expect(
    region.getByRole('button', { name: '导出当前筛选（26项）' }),
  ).toBeEnabled()
  await region
    .getByRole('button', { name: '导出当前筛选（26项）' })
    .scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/npi-kit-export-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await region
    .getByLabel('齐套物料来源', { exact: true })
    .selectOption('external_other')
  const one = await download(
    '导出当前筛选（1项）',
    '/tmp/npi-kit-export-mobile.xlsx',
  )
  assert.equal(one.rowCount, 6)
  assert.equal(one.getCell('C6').value, '精密测试件')
  assert.equal(one.getCell('J6').value, quantity)
  assert.equal(one.getCell('J6').type, ExcelJS.ValueType.String)
  assert.match(String(one.getCell('A2').value), /其他BOM外物料/)
  await expect(
    region.getByRole('button', { name: '导出当前筛选（1项）' }),
  ).toBeEnabled()
  await region
    .getByRole('button', { name: '导出当前筛选（1项）' })
    .scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/npi-kit-export-mobile.png' })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await region.getByLabel('搜索齐套物料', { exact: true }).fill('不存在的物料')
  await expect(
    region.getByRole('button', { name: '导出当前筛选（0项）' }),
  ).toBeDisabled()
  assert.deepEqual(writes, [], 'Export must not mutate NPI data')
  assert.deepEqual(errors, [], 'Actual browser must have no page errors')
  fs.writeFileSync(
    '/tmp/npi-kit-export-browser-result.json',
    JSON.stringify(
      {
        passed: true,
        desktopRows: 26,
        mobileFilteredRows: 1,
        exactQuantity: quantity,
        pageErrors: errors,
        businessWrites: writes,
        mobileOverflow: false,
        screenshots: [
          '/tmp/npi-kit-export-desktop.png',
          '/tmp/npi-kit-export-mobile.png',
        ],
        builtApplication: appRoot,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: actual built browser downloads all 26 rows and mobile filtered row, preserves exact quantities, disables empty exports, no page errors or business writes.',
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
