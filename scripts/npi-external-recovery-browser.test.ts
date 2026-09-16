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
const fixtureRecord = '/tmp/npi-external-recovery-fixtures.json'
if (
  fs.existsSync(fixtureRecord) &&
  !JSON.parse(fs.readFileSync(fixtureRecord, 'utf8')).cleaned
)
  throw Error(
    'Previous file-operation test fixtures need cleanup before another run',
  )
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const vaultRoot = fs.mkdtempSync('/tmp/npi-external-recovery-vault-')
process.env.VAULT_ROOT = vaultRoot
process.env.VAULT_TYPE = 'local'
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
const log = fs.openSync('/tmp/npi-external-recovery-browser-server.log', 'w')
const projects: Array<string> = []
const releases: Array<() => void> = []
const errors: Array<string> = []
try {
  const { SettingsService, SettingKeys } =
    await import('../packages/core/src/lib/config/SettingsService')
  if (await SettingsService.getValue(SettingKeys.VAULT_ROOT))
    throw Error('Test DB must have no Vault root override')
  const marker = `外物料恢复-${crypto.randomUUID().slice(0, 8)}`
  for (const role of ['technical', 'manufacturing', 'procurement', 'buyer2']) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@purchase-reply.test.invalid'},${role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role === 'buyer2' ? 'procurement' : role})`
  }
  for (const suffix of ['A', 'B']) {
    const project = await service.createProject(users.technical!, {
      name: marker + suffix,
      motorModel: 'PURCHASE-' + suffix,
      technicalOwnerId: users.technical,
      manufacturingOwnerId: users.manufacturing,
      requiredKitDate: '2026-10-15',
      prototypeRequiredDate: '2026-10-20',
    })
    projects.push(project.id)
  }
  const appRoot = process.env.NPI_BROWSER_APP_ROOT || process.cwd()
  fs.writeFileSync(
    fixtureRecord,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        appRoot,
        ownerPid: process.pid,
        projectIds: projects,
        userIds: Object.values(users),
        vaultRoot,
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

  const session = await SessionManager.createSession(users.technical!)
  sessions.push(session.session.id)
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  })
  context.setDefaultTimeout(15000)
  await context.addCookies([
    { name: 'session', value: session.sessionToken, url: base },
  ])
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  const posts = new Map<string, number>()
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/v1/npi/')) {
      const key = new URL(r.url()).pathname
      posts.set(key, (posts.get(key) || 0) + 1)
    }
  })
  const count = (url: string) => posts.get('/api/v1/npi' + url) || 0
  await page.goto(base + '/npi', { waitUntil: 'networkidle' })
  const nav = page.getByRole('navigation', { name: '主导航' })
  const openProject = async (suffix: string) => {
    await nav.getByRole('button', { name: '新品项目', exact: true }).click()
    await page.getByLabel('模块项目搜索').fill(marker + suffix)
    await page.getByRole('button', { name: '项目详情 ↗', exact: true }).click()
    await page.getByRole('tab', { name: '样机齐套', exact: true }).click()
  }
  await openProject('A')
  await page.getByRole('button', { name: '添加BOM外物料', exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: '添加BOM外物料',
    exact: true,
  })
  const nameA = marker + '采购编码器'
  await dialog.getByLabel('物料名称', { exact: true }).fill(nameA)
  await dialog.getByLabel('规格', { exact: true }).fill('客户指定接口')
  await dialog.getByLabel('回复责任人').selectOption(users.procurement!)
  await dialog.getByLabel('数量', { exact: true }).fill('999999999999.123456')
  const createPath = `/projects/${projects[0]}/external-items`
  let release!: () => void,
    started!: () => void,
    status = 0,
    routeError = ''
  const held = new Promise<void>((r) => {
      release = r
      releases.push(r)
    }),
    began = new Promise<void>((r) => {
      started = r
    })
  await page.route(
    '**/api/v1/npi' + createPath,
    async (route) => {
      try {
        const response = await route.fetch()
        status = response.status()
        started()
        await held
        await route.abort('connectionfailed')
      } catch (error) {
        routeError = String(error)
        started()
        await route.abort().catch(() => {})
      }
    },
    { times: 1 },
  )
  await dialog
    .getByRole('button', { name: '保存并补充资料', exact: true })
    .click()
  await began
  assert.equal(status, 201)
  assert.equal(routeError, '')
  await page.keyboard.press('Escape')
  await dialog
    .getByRole('button', { name: 'Close', exact: true })
    .evaluate((el: HTMLElement) => el.click())
  await page.mouse.click(2, 2)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('物料名称', { exact: true })).toBeDisabled()
  await dialog
    .locator('form')
    .evaluate((el: HTMLFormElement) => el.requestSubmit())
  assert.equal(count(createPath), 1)
  release()
  await expect(dialog.getByRole('alert')).toContainText('保存结果待确认')
  await expect(dialog.getByRole('alert')).toBeInViewport()
  await dialog.screenshot({
    path: '/tmp/npi-external-recovery-unknown-mobile.png',
  })
  await dialog
    .getByRole('button', { name: '重试本次保存', exact: true })
    .click()
  const files = page.getByRole('dialog', {
    name: `${nameA} · 附件资料`,
    exact: true,
  })
  await expect(files).toBeVisible()
  assert.equal(count(createPath), 2)
  const projectA = await service.projectDetail(users.technical!, projects[0]!)
  const a = projectA.items.find((i) => i.sourceType === 'EXTERNAL')!
  assert.equal(
    projectA.items.filter((i) => i.sourceType === 'EXTERNAL').length,
    1,
  )
  assert.equal(a.qty, '999999999999.123456')
  assert.equal(a.ownerId, users.procurement)
  assert.equal(a.status, 'pending_reply')
  assert.equal(projectA.kit.predictionComplete, false)
  assert.equal(
    (await service.procurement(users.procurement!)).items.filter(
      (i) => i.id === a.id,
    ).length,
    1,
  )
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n',
  )
  await files.getByLabel('资料标题').fill('编码器技术规格书')
  await files.getByLabel('选择文件或照片').setInputFiles({
    name: 'encoder-spec.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  })
  await files.getByRole('button', { name: '上传资料', exact: true }).click()
  await expect(files).toContainText('资料已上传成功')
  await files.screenshot({
    path: '/tmp/npi-external-recovery-files-mobile.png',
  })
  const [link] =
    await client`select l.*,v.storage_path from npi_file_links l join vault_files v on v.id=l.file_id where l.tracking_item_id=${a.id}`
  assert.ok(link)
  assert.equal(link.program_id, projects[0])
  assert.equal(link.category, 'technical')
  assert.deepEqual(
    fs.readFileSync(path.join(vaultRoot, link.storage_path)),
    pdf,
  )
  for (const role of ['procurement', 'buyer2']) {
    const login = await SessionManager.createSession(users[role]!)
    sessions.push(login.session.id)
    const buyerContext = await browser.newContext()
    await buyerContext.addCookies([
      { name: 'session', value: login.sessionToken, url: base },
    ])
    const download = await buyerContext.request.get(
      base + `/api/v1/npi/file-content/${link.id}`,
    )
    assert.equal(download.status(), role === 'procurement' ? 200 : 403)
    if (role === 'procurement') assert.deepEqual(await download.body(), pdf)
    await buyerContext.close()
  }
  await page.keyboard.press('Escape')
  await expect(files).toHaveCount(0)
  // B covers a confirmed validation rejection, then a saved result with two read failures.
  await openProject('B')
  await page.getByRole('button', { name: '添加BOM外物料', exact: true }).click()
  const nameB = marker + '试验支架'
  await expect(dialog.getByLabel('回复责任人')).toHaveValue(users.procurement!)
  await dialog.getByLabel('物料名称', { exact: true }).fill(nameB)
  await dialog.getByLabel('数量', { exact: true }).fill('0')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('物料未新增')
  await expect(dialog.getByLabel('数量', { exact: true })).toBeEnabled()
  await dialog.getByLabel('数量', { exact: true }).fill('2.500001')
  await dialog.getByLabel('物料类型').selectOption('material')
  await dialog.getByLabel('回复责任人').selectOption(users.manufacturing!)
  let readFailures = 0
  await page.route(
    '**/api/v1/npi/dashboard',
    async (route) => {
      readFailures++
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '测试：项目汇总暂不可用' }),
      })
    },
    { times: 2 },
  )
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(
    '物料已新增，列表刷新失败',
  )
  await page.setViewportSize({ width: 1440, height: 1000 })
  await dialog.screenshot({
    path: '/tmp/npi-external-recovery-saved-desktop.png',
  })
  await dialog
    .getByRole('button', { name: '重试刷新列表', exact: true })
    .click()
  await expect(dialog.getByRole('alert')).toContainText('列表仍未刷新')
  await dialog
    .getByRole('button', { name: '重试刷新列表', exact: true })
    .click()
  await expect(dialog).toHaveCount(0)
  const projectB = await service.projectDetail(users.technical!, projects[1]!),
    b = projectB.items.find((i) => i.sourceType === 'EXTERNAL')!
  assert.equal(
    projectB.items.filter((i) => i.sourceType === 'EXTERNAL').length,
    1,
  )
  assert.equal(b.qty, '2.500001')
  assert.equal(b.ownerId, users.manufacturing)
  assert.equal(b.trackingType, 'material')
  assert.equal(
    (await service.assignedMaterials(users.manufacturing!)).items.filter(
      (i) => i.id === b.id,
    ).length,
    1,
  )
  const events =
    await client`select object_id,count(*)::int as n from npi_events where program_id in (${projects[0]!},${projects[1]!}) and action='EXTERNAL_CREATED' group by object_id`
  assert.equal(events.length, 2)
  assert.ok(events.every((r) => r.n === 1))
  assert.equal(
    (
      await client`select count(*)::int as n from npi_file_links where program_id=${projects[1]!}`
    )[0]!.n,
    0,
  )
  assert.equal(count(createPath), 2)
  assert.equal(count(`/projects/${projects[1]}/external-items`), 2)
  assert.equal(readFailures, 2)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-external-recovery-browser-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        lostResponseRecovered: true,
        singleMaterialPerSubmission: true,
        creationEvents: 2,
        closeAndDoubleSubmitProtected: true,
        validationCorrection: true,
        refreshOnlyRetry: true,
        refreshFailures: readFailures,
        directTechnicalFiles: true,
        exactQuantityPreserved: true,
        buyerQueueUnique: true,
        manufacturingQueueUnique: true,
        fileBytesAndOwnershipVerified: true,
        otherBuyerDownloadDenied: true,
        crossProjectIsolation: true,
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: external create response recovery, validation correction, refresh-only retry, single records and queues, direct technical PDF upload/download, role/project isolation and mobile layouts.',
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
    const spaces =
      await client`select design_id from npi_document_spaces where program_id=${id}`
    await client`delete from npi_file_links where program_id=${id}`
    for (const space of spaces) {
      await client`delete from items where design_id=${space.design_id}`
      await client`delete from npi_document_spaces where program_id=${id}`
      await client`delete from designs where id=${space.design_id}`
    }
    const ownedIssues =
      await client`select item_id from npi_issue_links where program_id=${id}`
    await client`delete from npi_issue_links where program_id=${id}`
    for (const owned of ownedIssues)
      await client`delete from items where id=${owned.item_id}`
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
  fs.rmSync(vaultRoot, { recursive: true, force: true })
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
