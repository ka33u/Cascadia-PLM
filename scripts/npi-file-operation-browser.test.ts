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
const fixtureRecord = '/tmp/npi-file-operation-fixtures.json'
if (
  fs.existsSync(fixtureRecord) &&
  !JSON.parse(fs.readFileSync(fixtureRecord, 'utf8')).cleaned
)
  throw Error(
    'Previous file-operation test fixtures need cleanup before another run',
  )
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const vaultRoot = fs.mkdtempSync('/tmp/npi-file-operation-vault-')
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
const log = fs.openSync('/tmp/npi-file-operation-browser-server.log', 'w')
const projects: Array<string> = []
const releases: Array<() => void> = []
const errors: Array<string> = []
try {
  const { SettingsService, SettingKeys } =
    await import('../packages/core/src/lib/config/SettingsService')
  if (await SettingsService.getValue(SettingKeys.VAULT_ROOT))
    throw Error('Test DB must have no Vault root override')
  const marker = `资料操作-${crypto.randomUUID().slice(0, 8)}`
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
  const a = await add(projects[0]!, '物料A')
  const { createIssue } =
    await import('../packages/core/src/lib/npi/issue-service')
  const issueTitle = marker + '上传保护问题'
  const issue = await createIssue(users.technical!, projects[0]!, {
    title: issueTitle,
    description: '核对资料保存期间的操作保护',
    severity: 'High',
    ownerId: users.technical,
    targetDate: '2026-10-15',
  })
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
  const hold = async (url: string) => {
    let release!: () => void, start!: () => void
    const held = new Promise<void>((r) => {
        release = r
        releases.push(r)
      }),
      started = new Promise<void>((r) => (start = r))
    let responseStatus = 0,
      routeError = ''
    await page.route(
      '**/api/v1/npi' + url,
      async (route) => {
        try {
          if (route.request().method() !== 'POST') {
            await route.continue()
            return
          }
          const response = await route.fetch()
          responseStatus = response.status()
          start()
          await held
          await route.fulfill({ response })
        } catch (error) {
          routeError = String(error)
          start()
          await route.abort().catch(() => {})
        }
      },
      { times: 1 },
    )
    return {
      started,
      release,
      check: () => {
        assert.equal(routeError, '')
        assert.ok(
          [200, 201].includes(responseStatus),
          'Unexpected HTTP ' + responseStatus,
        )
      },
    }
  }
  const resistClose = async (dialog: ReturnType<typeof page.getByRole>) => {
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await dialog
      .getByRole('button', { name: 'Close', exact: true })
      .evaluate((el: HTMLElement) => el.click())
    await expect(dialog).toBeVisible()
    await page.mouse.click(2, 2)
    await expect(dialog).toBeVisible()
    assert.equal(await dialog.getAttribute('data-saving'), 'true')
  }
  await page.goto(base + '/npi', { waitUntil: 'networkidle' })
  const nav = page.getByRole('navigation', { name: '主导航' })
  await nav.getByRole('button', { name: '新品项目', exact: true }).click()
  await page.getByLabel('模块项目搜索').fill(marker + 'A')
  await page.getByRole('button', { name: '项目详情 ↗', exact: true }).click()
  await page.getByRole('tab', { name: '样机齐套', exact: true }).click()
  await page
    .locator(`[data-npi-item="${a.id}"]`)
    .getByRole('button', { name: `${a.name}附件资料`, exact: true })
    .click()
  const files = page.getByRole('dialog', {
    name: `${a.name} · 附件资料`,
    exact: true,
  })
  await expect(files).toBeVisible()
  await files.getByLabel('资料标题').fill('物料操作保护规格书')
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n',
  )
  await files.getByLabel('选择文件或照片').setInputFiles({
    name: 'guard-spec.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  })
  const uploadPath = `/files/tracking/${a.id}`
  const upload = await hold(uploadPath)
  await files.getByRole('button', { name: '上传资料', exact: true }).click()
  await upload.started
  upload.check()
  await resistClose(files)
  await expect(files.getByLabel('选择文件或照片')).toBeDisabled()
  await expect(
    files.getByRole('button', { name: '正在上传…', exact: true }),
  ).toBeDisabled()
  await files
    .locator('form.npi-file-upload')
    .evaluate((form: HTMLFormElement) => form.requestSubmit())
  assert.equal(count(uploadPath), 1)
  await files.screenshot({ path: '/tmp/npi-file-operation-upload-mobile.png' })
  upload.release()
  await expect(files).toContainText('资料已上传成功')
  await expect(
    files.getByRole('button', { name: '归档资料', exact: true }),
  ).toBeEnabled()
  const [link] =
    await client`select l.*, v.storage_path from npi_file_links l join vault_files v on v.id=l.file_id where l.tracking_item_id=${a.id}`
  assert.ok(link)
  assert.equal(link.category, 'technical')
  assert.deepEqual(
    fs.readFileSync(path.join(vaultRoot, link.storage_path)),
    pdf,
  )
  // Archive cannot be cancelled or edited while its write is in flight.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await files.getByRole('button', { name: '归档资料', exact: true }).click()
  await files.getByLabel('归档原因').fill('规格书已被新版本替代')
  const archivePath = `/file-archive/${link.id}`,
    archive = await hold(archivePath)
  await files.getByRole('button', { name: '确认归档', exact: true }).click()
  await archive.started
  archive.check()
  await resistClose(files)
  await expect(files.getByLabel('归档原因')).toBeDisabled()
  await expect(
    files.getByRole('button', { name: '取消', exact: true }),
  ).toBeDisabled()
  await files.screenshot({
    path: '/tmp/npi-file-operation-archive-desktop.png',
  })
  archive.release()
  await expect(files).toContainText('资料已归档')
  await files.getByLabel('显示已归档资料').check()
  await expect(files).toContainText('规格书已被新版本替代')
  const download = await page.request.get(
    base + `/api/v1/npi/file-content/${link.id}`,
  )
  assert.equal(download.status(), 200)
  assert.deepEqual(await download.body(), pdf)
  assert.equal(count(archivePath), 1)
  assert.equal(
    (
      await client`select count(*)::int as n from npi_events where object_id=${link.id} and action='FILE_ARCHIVED'`
    )[0]!.n,
    1,
  )
  await page.keyboard.press('Escape')
  await expect(files).toHaveCount(0)
  // Issue files share the same parent guard; issue actions pause until upload/refresh ends.
  await page.getByRole('tab', { name: /^项目问题/ }).click()
  await page.getByRole('button', { name: new RegExp(issueTitle) }).click()
  const issueDialog = page.getByRole('dialog', {
    name: issueTitle,
    exact: true,
  })
  const photo = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=',
    'base64',
  )
  await issueDialog.getByLabel('资料标题').fill('问题现场照片')
  await issueDialog.getByLabel('选择文件或照片').setInputFiles({
    name: 'issue-guard.png',
    mimeType: 'image/png',
    buffer: photo,
  })
  const issuePath = `/files/issue/${issue.id}`,
    issueUpload = await hold(issuePath)
  await issueDialog
    .getByRole('button', { name: '上传资料', exact: true })
    .click()
  await issueUpload.started
  issueUpload.check()
  await resistClose(issueDialog)
  await expect(
    issueDialog.getByRole('button', { name: '记录进展', exact: true }),
  ).toBeDisabled()
  await expect(
    issueDialog.getByRole('button', { name: '刷新问题详情', exact: true }),
  ).toBeDisabled()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await issueDialog
    .getByRole('region', { name: '附件资料' })
    .screenshot({ path: '/tmp/npi-file-operation-issue-mobile.png' })
  issueUpload.release()
  await expect(issueDialog).toContainText('资料已上传成功')
  await expect(
    issueDialog.getByRole('button', { name: '记录进展', exact: true }),
  ).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(issueDialog).toHaveCount(0)
  assert.equal(count(issuePath), 1)
  assert.equal(count(`/issues/${issue.id}/notes`), 0)
  const [issueLink] =
    await client`select * from npi_file_links where issue_id=${issue.id}`
  assert.ok(issueLink)
  assert.equal(issueLink.program_id, projects[0])
  assert.equal(issueLink.category, 'issue')
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-file-operation-browser-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        uploadCloseProtected: true,
        archiveCloseProtected: true,
        issueCloseProtected: true,
        repeatUploadPrevented: true,
        outsideCloseProtected: true,
        archiveReasonLocked: true,
        archiveRecordPreserved: true,
        archivedDownloadMatches: true,
        issueActionsPaused: true,
        uploadPosts: count(uploadPath),
        archivePosts: count(archivePath),
        issueUploadPosts: count(issuePath),
        issueNotePosts: count(`/issues/${issue.id}/notes`),
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: material and issue upload close protection, duplicate submit guard, archive reason/close lock, archive history and original download, issue action coordination; desktop/mobile.',
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
