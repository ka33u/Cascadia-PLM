// SPDX-License-Identifier: AGPL-3.0-or-later
// Focused Word/Excel attachments UI; removes only its own UUID fixtures in finally.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import postgres from 'postgres'
import { officeFixtures } from './npi-office-fixtures'
import type { Browser } from '@playwright/test'

const url = process.env.TEST_DATABASE_URL
if (!url) throw Error('Explicit TEST_DATABASE_URL required')
const target = new URL(url)
if (
  !target.pathname.endsWith('_test') ||
  !['localhost', '127.0.0.1', '[::1]', '::1'].includes(target.hostname) ||
  target.searchParams.has('host')
)
  throw Error('Only a local _test database is allowed')
process.env.DATABASE_URL = url
const vaultRoot = fs.mkdtempSync('/tmp/npi-office-files-vault-')
process.env.VAULT_ROOT = vaultRoot
process.env.VAULT_TYPE = 'local'
const { SessionManager } = await import('../packages/core/src/lib/auth/session')
const service = await import('../packages/core/src/lib/npi/service')
const database = await import('../packages/core/src/lib/db')
const client = postgres(url, { max: 1 })
const appRoot = process.env.NPI_BROWSER_APP_ROOT || process.cwd()
const resultPath = '/tmp/npi-office-files-browser-result.json'
const fixturePath = '/tmp/npi-office-files-browser-fixtures.json'
if (
  fs.existsSync(fixturePath) &&
  !JSON.parse(fs.readFileSync(fixturePath, 'utf8')).cleaned
)
  throw Error('Prior scoped fixtures require cleanup')
fs.rmSync(resultPath, { force: true })
const users = Object.fromEntries(
  ['technical', 'manufacturing', 'procurement', 'nextBuyer', 'supervisor'].map(
    (role) => [role, crypto.randomUUID()],
  ),
)
const userIds = Object.values(users)
let browser: Browser | undefined, server: ReturnType<typeof spawn> | undefined
let cleaned = false,
  passed = false
const errors: Array<string> = [],
  checks: Array<string> = []
const record = (extra: Record<string, unknown> = {}) =>
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({ userIds, vaultRoot, cleaned, ...extra }, null, 2),
  )
record()
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
  probe.close((e) => (e ? reject(e) : resolve())),
)
const log = fs.openSync('/tmp/npi-office-files-browser-server.log', 'w')
try {
  const { SettingsService, SettingKeys } =
    await import('../packages/core/src/lib/config/SettingsService')
  if (await SettingsService.getValue(SettingKeys.VAULT_ROOT))
    throw Error('Test DB must not override temporary Vault root')
  const tokens: Record<string, string> = {}
  for (const [name, id] of Object.entries(users)) {
    const role = name === 'nextBuyer' ? 'procurement' : name
    await client`insert into users(id,email,name,active) values(${id},${id + '@office-files.invalid'},${name},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role})`
    tokens[name] = (await SessionManager.createSession(id)).sessionToken
  }
  const marker = `办公资料专项-${crypto.randomUUID().slice(0, 8)}`
  const project = await service.createProject(users.technical!, {
    code: 'OFFICE-' + crypto.randomUUID(),
    name: marker,
    motorModel: 'FILES',
    technicalOwnerId: users.technical,
    manufacturingOwnerId: users.manufacturing,
    requiredKitDate: '2026-10-15',
    prototypeRequiredDate: '2026-10-20',
  })
  record({ projectId: project.id })
  const purchase = await service.addExternal(users.technical!, project.id, {
    name: '资料核查采购件',
    trackingType: 'purchase',
    ownerId: users.procurement,
    qty: '2',
    requiredDate: '2026-10-15',
    affectsKit: true,
  })
  const files = await officeFixtures()
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
  for (let i = 0; i < 100; i++) {
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
  const pageFor = async (role: string, mobile = false) => {
    const context = await browser!.newContext({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
      acceptDownloads: true,
    })
    context.setDefaultTimeout(30000)
    await context.addCookies([
      { name: 'session', value: tokens[role]!, url: base },
    ])
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
    return page
  }
  const page = await pageFor('technical')
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '新品项目', exact: true })
    .click()
  await page.getByLabel('模块项目搜索').fill(marker)
  await page.getByRole('button', { name: '项目详情 ↗', exact: true }).click()
  await page.getByRole('tab', { name: '项目资料', exact: true }).click()
  const panel = page.getByRole('region', { name: '附件资料', exact: true })
  await expect(panel.getByLabel('选择文件或照片')).toHaveAttribute(
    'accept',
    /\.docx.*\.xlsx/,
  )
  for (const [ext, name] of [
    ['docx', '技术要求.docx'],
    ['xlsx', '项目验收清单.xlsx'],
  ] as const) {
    await panel
      .getByLabel('选择文件或照片')
      .setInputFiles({
        name,
        mimeType: 'application/octet-stream',
        buffer: files[ext],
      })
    const request = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/files/project/${project.id}`) &&
        r.request().method() === 'POST',
    )
    await panel.getByRole('button', { name: '上传资料', exact: true }).click()
    assert.equal((await request).status(), 201)
    const card = panel
      .locator('.npi-file-card')
      .filter({ has: page.getByText(name, { exact: true }) })
    await expect(card).toBeVisible()
    const downloaded = page.waitForEvent('download')
    await card.getByRole('link', { name: '下载文件', exact: true }).click()
    const download = await downloaded
    assert.equal(download.suggestedFilename(), name)
    assert.deepEqual(fs.readFileSync((await download.path())), files[ext])
  }
  await panel.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/npi-office-files-desktop.png' })
  const word = panel
    .locator('.npi-file-card')
    .filter({ has: page.getByText('技术要求.docx', { exact: true }) })
  await word.getByRole('button', { name: '归档资料', exact: true }).click()
  await word.getByLabel('归档原因').fill('已纳入新版技术资料')
  await word.getByRole('button', { name: '确认归档', exact: true }).click()
  await expect(word).toHaveCount(0)
  await panel.getByRole('checkbox', { name: '显示已归档资料' }).check()
  await expect(word).toContainText('已纳入新版技术资料')
  const archived = page.waitForEvent('download')
  await word.getByRole('link', { name: '下载文件' }).click()
  assert.deepEqual(
    fs.readFileSync((await (await archived).path())),
    files.docx,
  )
  checks.push(
    'Desktop: Word and Excel project upload, real downloaded bytes/name preserved, archived Word still downloadable',
  )

  const buyer = await pageFor('procurement', true)
  const material = buyer.locator(`[data-npi-item="${purchase.id}"]`)
  await material.getByRole('button', { name: '资料核查采购件附件资料' }).click()
  const modal = buyer.getByRole('dialog', { name: '资料核查采购件 · 附件资料' })
  await expect(modal.getByLabel('文件分类')).toHaveValue('receipt')
  await modal
    .getByLabel('选择文件或照片')
    .setInputFiles({
      name: '到货验收.xlsx',
      mimeType: 'application/octet-stream',
      buffer: files.xlsx,
    })
  const receipt = buyer.waitForResponse(
    (r) =>
      r.url().endsWith(`/files/tracking/${purchase.id}`) &&
      r.request().method() === 'POST',
  )
  await modal.getByRole('button', { name: '上传资料', exact: true }).click()
  assert.equal((await receipt).status(), 201)
  const receiptCard = modal
    .locator('.npi-file-card')
    .filter({ hasText: '到货验收.xlsx' })
  await expect(receiptCard).toBeVisible()
  const mobileDownload = buyer.waitForEvent('download')
  await receiptCard.getByRole('link', { name: '下载文件' }).click()
  assert.deepEqual(
    fs.readFileSync((await (await mobileDownload).path())),
    files.xlsx,
  )
  assert.equal(
    await buyer.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  await buyer.screenshot({ path: '/tmp/npi-office-files-mobile.png' })
  checks.push(
    'Mobile: assigned buyer uploads Excel receipt and downloads exact bytes with no horizontal overflow',
  )

  const call = async (role: string, endpoint: string, form?: FormData) =>
    fetch(base + '/api/v1/npi' + endpoint, {
      method: form ? 'POST' : 'GET',
      headers: {
        cookie: `session=${tokens[role]}`,
        origin: base,
        'x-npi-actor': users[role]!,
      },
      body: form,
    })
  const payload = (name: string, bytes: Buffer, category = 'technical') => {
    const form = new FormData()
    form.set('file', new File([new Uint8Array(bytes)], name))
    form.set('category', category)
    form.set('requestId', crypto.randomUUID())
    return form
  }
  const rows =
    await client`select l.id,l.tracking_item_id,v.mime_type,v.file_hash,v.file_size,v.original_file_name from npi_file_links l join vault_files v on v.id=l.file_id where l.program_id=${project.id}`
  assert.equal(rows.length, 3)
  for (const row of rows) {
    const bytes = row.original_file_name.endsWith('.docx')
      ? files.docx
      : files.xlsx
    assert.equal(Number(row.file_size), bytes.length)
    const response = await call(
      'supervisor',
      `/file-content/${row.id}?inline=1`,
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), row.mime_type)
    assert.match(response.headers.get('content-disposition')!, /^attachment;/)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    const denied = await call('nextBuyer', `/file-content/${row.id}`)
    assert.equal(denied.status, 403)
    await denied.arrayBuffer()
  }
  for (const [role, endpoint, form, status] of [
    [
      'supervisor',
      `/files/project/${project.id}`,
      payload('不能上传.docx', files.docx),
      403,
    ],
    [
      'procurement',
      `/files/project/${project.id}`,
      payload('不能上传.xlsx', files.xlsx),
      403,
    ],
    [
      'procurement',
      `/files/tracking/${purchase.id}`,
      payload('技术资料.docx', files.docx),
      403,
    ],
    [
      'technical',
      `/files/project/${project.id}`,
      payload('伪装.docx', files.xlsx),
      422,
    ],
    [
      'technical',
      `/files/project/${project.id}`,
      payload('伪装.xlsx', Buffer.from('not a workbook')),
      422,
    ],
  ] as const) {
    const response = await call(role, endpoint, form)
    assert.equal(response.status, status)
    await response.arrayBuffer()
  }
  assert.equal(
    (
      await client`select count(*)::int as n from npi_file_links where program_id=${project.id}`
    )[0]!.n,
    3,
  )
  checks.push(
    'Native Document/Vault: 3 files, correct MIME/size; supervisor download only, unrelated buyer/project access denied; invalid formats create no files; Office always attachment',
  )
  assert.deepEqual(errors, [])
  passed = true
} finally {
  if (browser) await browser.close()
  if (server) {
    const child = server,
      running = () => child.exitCode === null && child.signalCode === null
    if (running()) child.kill('SIGTERM')
    for (let i = 0; i < 25 && running(); i++) await delay(200)
    if (running()) {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  }
  fs.closeSync(log)
  try {
    const own =
      await client`select id from programs where created_by in ${client(userIds)}`
    const projectIds = own.map((r) => String(r.id))
    await client.begin(async (tx) => {
      if (projectIds.length) {
        const spaces =
          await tx`select design_id from npi_document_spaces where program_id in ${tx(projectIds)}`
        await tx`delete from npi_file_links where program_id in ${tx(projectIds)}`
        for (const space of spaces) {
          await tx`delete from items where design_id=${space.design_id}`
          await tx`delete from npi_document_spaces where design_id=${space.design_id}`
          await tx`delete from designs where id=${space.design_id}`
        }
        await tx`delete from npi_promise_history where program_id in ${tx(projectIds)}`
        await tx`delete from npi_events where program_id in ${tx(projectIds)}`
        await tx`delete from npi_tracking_items where program_id in ${tx(projectIds)}`
        await tx`delete from npi_manufacturing_plan where program_id in ${tx(projectIds)}`
        await tx`delete from npi_projects where program_id in ${tx(projectIds)}`
        await tx`delete from program_members where program_id in ${tx(projectIds)}`
        await tx`delete from programs where id in ${tx(projectIds)}`
      }
      await tx`delete from sessions where user_id in ${tx(userIds)}`
      await tx`delete from npi_user_roles where user_id in ${tx(userIds)}`
      await tx`delete from users where id in ${tx(userIds)}`
    })
    const residuals = (
      await client`select (select count(*)::int from users where id in ${client(userIds)}) as users, (select count(*)::int from programs where created_by in ${client(userIds)}) as projects, (select count(*)::int from npi_events where actor_id in ${client(userIds)}) as events, (select count(*)::int from sessions where user_id in ${client(userIds)}) as sessions`
    )[0]!
    assert.ok(Object.values(residuals).every((v) => v === 0))
    fs.rmSync(vaultRoot, { recursive: true, force: true })
    assert.equal(fs.existsSync(vaultRoot), false)
    cleaned = true
    record({ projectIds, residuals })
    fs.writeFileSync(
      resultPath,
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          passed,
          checks,
          cleaned,
          residuals,
          pageErrors: errors,
          applicationRoot: appRoot,
          scope:
            'Word/Excel attachment UI, original byte downloads, archive, format and scoped access checks only; own database fixtures and temporary Vault removed. No full API/browser suite.',
        },
        null,
        2,
      ) + '\n',
    )
  } finally {
    await client.end({ timeout: 5 })
    await (database.db as unknown as { $client: postgres.Sql }).$client.end({
      timeout: 5,
    })
    await database.migrationClient.end({ timeout: 5 })
  }
}
console.log(
  'PASS: Word/Excel uploads/downloads/permissions desktop/mobile; own database fixtures and Vault removed.',
)
