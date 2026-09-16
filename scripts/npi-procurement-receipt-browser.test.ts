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
const vaultRoot = fs.mkdtempSync('/tmp/npi-procurement-receipt-vault-')
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
const log = fs.openSync('/tmp/npi-procurement-receipt-browser-server.log', 'w')
const projects: Array<string> = []
const releases: Array<() => void> = []
const errors: Array<string> = []
try {
  const { SettingsService, SettingKeys } =
    await import('../packages/core/src/lib/config/SettingsService')
  if (await SettingsService.getValue(SettingKeys.VAULT_ROOT))
    throw Error('Test DB must have no Vault root override')
  const marker = `采购到货-${crypto.randomUUID().slice(0, 8)}`
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
  const add = (projectId: string, suffix: string) =>
    service.addExternal(users.technical!, projectId, {
      name: marker + suffix,
      qty: '1',
      unit: '件',
      requiredDate: '2026-10-15',
      ownerId: users.procurement,
      affectsKit: true,
      remark: '原始备注',
    })
  const a = await add(projects[0]!, '物料A'),
    b = await add(projects[1]!, '物料B'),
    c = await add(projects[1]!, '物料C')
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
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

  const session = await SessionManager.createSession(users.procurement!)
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
  const row = (id: string) => page.locator(`[data-npi-item="${id}"]`)
  const arrival = () =>
    page.getByRole('dialog', { name: '确认到货', exact: true })
  const reply = () =>
    page.getByRole('dialog', { name: '采购日期回复', exact: true })
  const postCounts = new Map<string, number>()
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/v1/npi/tracking/')) {
      const pathname = new URL(r.url()).pathname
      postCounts.set(pathname, (postCounts.get(pathname) || 0) + 1)
    }
  })
  const count = (id: string, action = 'complete') =>
    postCounts.get(`/api/v1/npi/tracking/${id}/${action}`) || 0
  const completedEvents = async (id: string) =>
    (
      await client`select count(*)::int as n from npi_events where object_id=${id} and action='COMPLETED'`
    )[0]!.n
  const workbenchPattern = '**/api/v1/npi/workbench/procurement'
  const completionPattern = (id: string) =>
    `**/api/v1/npi/tracking/${id}/complete`
  await page.goto(base + '/npi', { waitUntil: 'networkidle' })
  await row(a.id).getByRole('button', { name: '到货', exact: true }).click()
  await arrival().getByLabel('实际到货日期').fill(today)
  await arrival().getByLabel('到货说明（选填）').fill('包装与数量已核对')
  await page.screenshot({ path: '/tmp/npi-procurement-receipt-mobile.png' })
  // Save succeeds, but the subsequent list read fails.
  let failReads = 2
  await page.route(workbenchPattern, (route) =>
    failReads-- > 0
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '采购列表暂时离线' }),
        })
      : route.continue(),
  )
  await arrival()
    .getByRole('button', { name: '保存并补充资料', exact: true })
    .click()
  await expect(arrival().getByRole('alert')).toContainText(
    '已保存，但列表刷新失败',
  )
  assert.equal(count(a.id), 1)
  assert.equal(await completedEvents(a.id), 1)
  await expect(arrival().getByLabel('实际到货日期')).toBeDisabled()
  await expect(
    arrival().getByRole('button', { name: '保存到货', exact: true }),
  ).toHaveCount(0)
  await arrival()
    .getByRole('button', { name: '重试刷新列表', exact: true })
    .click()
  await expect(arrival().getByRole('alert')).toContainText('列表仍未刷新')
  assert.equal(count(a.id), 1)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await arrival().screenshot({
    path: '/tmp/npi-procurement-receipt-refresh-desktop.png',
  })
  await page.unroute(workbenchPattern)
  // A pending refresh must not be closed or turned into another submit.
  let release!: () => void, start!: () => void
  const held = new Promise<void>((r) => {
      release = r
      releases.push(r)
    }),
    started = new Promise<void>((r) => (start = r))
  await page.route(
    workbenchPattern,
    async (route) => {
      const response = await route.fetch()
      start()
      await held
      await route.fulfill({ response })
    },
    { times: 1 },
  )
  await arrival()
    .getByRole('button', { name: '重试刷新列表', exact: true })
    .click()
  await started
  await page.keyboard.press('Escape')
  await expect(arrival()).toBeVisible()
  await expect(
    arrival().getByRole('button', { name: '关闭', exact: true }),
  ).toBeDisabled()
  release()
  const files = () =>
    page.getByRole('dialog', { name: `${a.name} · 附件资料`, exact: true })
  await expect(files()).toBeVisible()
  await expect(arrival()).toHaveCount(0)
  await expect(files().getByLabel('文件分类')).toHaveValue('receipt')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=',
    'base64',
  )
  await files().getByLabel('资料标题').fill('到货验收照片A')
  await files().getByLabel('选择文件或照片').setInputFiles({
    name: 'receipt-a.png',
    mimeType: 'image/png',
    buffer: png,
  })
  await files().getByRole('button', { name: '上传资料', exact: true }).click()
  await expect(files()).toContainText('资料已上传成功')
  await expect(
    files().getByRole('link', { name: '下载文件', exact: true }),
  ).toBeVisible()
  const [link] =
    await client`select l.*,v.storage_path from npi_file_links l join vault_files v on v.id=l.file_id where l.tracking_item_id=${a.id}`
  assert.ok(link)
  assert.equal(link.program_id, projects[0])
  assert.equal(link.category, 'receipt')
  assert.equal(link.uploaded_by, users.procurement)
  assert.deepEqual(
    fs.readFileSync(path.join(vaultRoot, link.storage_path)),
    png,
  )
  const download = await page.request.get(
    base + `/api/v1/npi/file-content/${link.id}`,
  )
  assert.equal(download.status(), 200)
  assert.deepEqual(await download.body(), png)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await files().screenshot({
    path: '/tmp/npi-procurement-receipt-files-mobile.png',
  })
  await page.keyboard.press('Escape')
  await expect(files()).toHaveCount(0)
  assert.equal(count(a.id), 1)
  assert.equal(await completedEvents(a.id), 1)
  // The server completed B but its response was lost: reload finds completion, no repeated write.
  await row(b.id).getByRole('button', { name: '到货', exact: true }).click()
  await page.route(
    completionPattern(b.id),
    async (route) => {
      const response = await route.fetch()
      assert.equal(response.status(), 200)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '到货响应模拟丢失' }),
      })
    },
    { times: 1 },
  )
  await arrival().getByRole('button', { name: '保存到货', exact: true }).click()
  await expect(arrival().getByRole('alert')).toContainText('读取最新记录')
  await expect(
    arrival().getByRole('button', { name: '保存到货', exact: true }),
  ).toBeDisabled()
  await arrival()
    .getByRole('button', { name: '读取最新记录', exact: true })
    .click()
  await expect(arrival()).toContainText('不能再次修改')
  await arrival()
    .getByRole('button', { name: '补充到货资料', exact: true })
    .click()
  const bFiles = page.getByRole('dialog', {
    name: `${b.name} · 附件资料`,
    exact: true,
  })
  await expect(bFiles).toBeVisible()
  await expect(bFiles).not.toContainText('到货验收照片A')
  await expect(bFiles.getByLabel('文件分类')).toHaveValue('receipt')
  assert.equal(count(b.id), 1)
  assert.equal(await completedEvents(b.id), 1)
  await page.keyboard.press('Escape')
  // A completed reply must also keep its success state when the refreshed actor mismatches.
  await row(c.id).getByRole('button', { name: '回复', exact: true }).click()
  await page.route(
    workbenchPattern,
    async (route) => {
      const response = await route.fetch(),
        data = await response.json()
      await route.fulfill({
        response,
        json: { ...data, actorId: users.buyer2 },
      })
    },
    { times: 1 },
  )
  await reply().getByRole('button', { name: '保存回复', exact: true }).click()
  await expect(reply().getByRole('alert')).toContainText('登录账号已改变')
  await expect(
    reply().getByRole('button', { name: '保存回复', exact: true }),
  ).toHaveCount(0)
  await reply()
    .getByRole('button', { name: '重试刷新列表', exact: true })
    .click()
  await expect(reply()).toHaveCount(0)
  assert.equal(count(c.id, 'promise'), 1)
  assert.equal(
    (
      await client`select count(*)::int as n from npi_promise_history where object_id=${c.id}`
    )[0]!.n,
    1,
  )
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-procurement-receipt-browser-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        refreshFailuresRecovered: 2,
        completionPosts: { A: count(a.id), B: count(b.id) },
        completionEvents: {
          A: await completedEvents(a.id),
          B: await completedEvents(b.id),
        },
        replyPosts: count(c.id, 'promise'),
        pendingCloseProtected: true,
        lostResponseRecovered: true,
        changedActorBlocked: true,
        attachmentIntentPreserved: true,
        photoUploadedAndDownloaded: true,
        photoOwnershipCorrect: true,
        otherProjectFilesIsolated: true,
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: procurement saved-state refresh retry, pending close protection, lost-response recovery, changed-actor guard, receipt photo upload/download and cross-project isolation; desktop/mobile.',
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
}
