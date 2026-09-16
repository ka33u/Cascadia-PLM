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
const log = fs.openSync('/tmp/npi-bom-context-browser-server.log', 'w')
const projects: Array<string> = [],
  templates: Array<string> = [],
  releases: Array<() => void> = []
const errors: Array<string> = []
try {
  const marker = `BOM归属-${crypto.randomUUID().slice(0, 8)}`
  for (const role of ['technical', 'manufacturing']) {
    const id = crypto.randomUUID()
    users[role] = id
    await client`insert into users(id,email,name,active) values(${id},${id + '@bom-context.test.invalid'},${role},true)`
    await client`insert into npi_user_roles(user_id,role) values(${id},${role})`
  }
  for (const suffix of ['A', 'B']) {
    const p = await service.createProject(users.technical!, {
      name: marker + suffix,
      motorModel: 'CONTEXT-' + suffix,
      technicalOwnerId: users.technical,
      manufacturingOwnerId: users.manufacturing,
      requiredKitDate: '2026-10-15',
      prototypeRequiredDate: '2026-10-20',
    })
    projects.push(p.id)
  }
  const a = projects[0]!,
    b = projects[1]!
  const { defaultTemplate } = await import('../packages/core/src/lib/npi/bom')
  const templateId = 'context-' + crypto.randomUUID(),
    template = { ...defaultTemplate, id: templateId, name: marker + ' 模板' }
  templates.push(templateId)
  await client`insert into npi_import_templates(id,name,config) values(${templateId},${template.name},${JSON.stringify(template)}::jsonb)`
  const bytes = async (name: string, qty = 1) => {
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet(template.sheetName)
    sheet.getCell('A4').value = 'CONTEXT'
    sheet.getCell('B4').value = '归属测试'
    sheet.getCell('C4').value = 'CONTEXT'
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
      'MAT-' + name,
      name,
      qty,
      '件',
      '领用',
      '测试仓',
      '制造',
    ]
    return Buffer.from(await workbook.xlsx.writeBuffer())
  }
  const create = async (id: string, name: string, qty = 1) =>
    service.createPreview(
      users.technical!,
      id,
      new File([new Uint8Array(await bytes(name, qty))], 'context.xlsx'),
      templateId,
    )
  const imports: Array<string> = []
  for (let v = 1; v <= 3; v++) {
    const preview = await create(a, marker + 'A物料V' + v, v)
    const result = await service.confirmImport(users.technical!, a, {
      previewToken: preview.previewToken,
      activate: true,
    })
    imports.push(result.importId)
  }
  const bPreview = await create(b, marker + 'B物料')
  const bImport = await service.confirmImport(users.technical!, b, {
    previewToken: bPreview.previewToken,
    activate: true,
  })
  const draftService =
    await import('../packages/core/src/lib/npi/bom-draft-service')
  const draftPreview = await create(a, marker + 'A草稿物料')
  await draftService.saveBomDraft(
    users.technical!,
    a,
    draftPreview.previewToken,
  )
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
  const session = await SessionManager.createSession(users.technical!)
  sessions.push(session.session.id)
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  context.setDefaultTimeout(15000)
  await context.addCookies([
    { name: 'session', value: session.sessionToken, url: base },
  ])
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(base + '/npi', { waitUntil: 'domcontentloaded' })
  const nav = page.getByRole('navigation', { name: '主导航' })
  const open = async (suffix: string) => {
    await nav.getByRole('button', { name: 'BOM管理', exact: true }).click()
    await page.getByLabel('模块项目搜索').fill(marker + suffix)
    await page.getByRole('button', { name: '进入BOM ↗' }).click()
    await expect(
      page.getByRole('tab', { name: 'ERP BOM', exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(
      page.getByRole('heading', { name: new RegExp(marker + suffix) }).first(),
    ).toBeVisible()
  }
  const hold = async (match: (url: URL) => boolean, fail = false) => {
    let release!: () => void, started!: () => void, delivered!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
        releases.push(resolve)
      }),
      began = new Promise<void>((resolve) => {
        started = resolve
      }),
      done = new Promise<void>((resolve) => {
        delivered = resolve
      })
    await page.route(
      match,
      async (route) => {
        const response = fail ? null : await route.fetch()
        started()
        await held
        if (response) await route.fulfill({ response })
        else
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: '旧请求延迟失败' }),
          })
        delivered()
      },
      { times: 1 },
    )
    return {
      started: began,
      release: async () => {
        const response = page.waitForResponse((r) => match(new URL(r.url())))
        release()
        await done
        await (await response).finished()
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        )
      },
    }
  }
  const tree = (id: string, version: string) => (url: URL) =>
    url.pathname === `/api/v1/npi/projects/${id}/bom/tree` &&
    url.searchParams.get('importId') === version
  const pathIs = (value: string) => (url: URL) =>
    url.pathname === '/api/v1/npi' + value
  await open('A')
  const old = await hold(tree(a, imports[0]!))
  await page.getByLabel('BOM版本', { exact: true }).selectOption(imports[0]!)
  await old.started
  await page.getByLabel('BOM版本', { exact: true }).selectOption(imports[1]!)
  await expect(page.getByRole('table', { name: '完整BOM明细' })).toContainText(
    marker + 'A物料V2',
  )
  await old.release()
  await expect(page.getByLabel('BOM版本', { exact: true })).toHaveValue(
    imports[1]!,
  )
  await expect(
    page.getByRole('table', { name: '完整BOM明细' }),
  ).not.toContainText(marker + 'A物料V1')
  const oldFailure = await hold(tree(a, imports[0]!), true)
  await page.getByLabel('BOM版本', { exact: true }).selectOption(imports[0]!)
  await oldFailure.started
  await page.getByLabel('BOM版本', { exact: true }).selectOption(imports[2]!)
  await expect(page.getByRole('table', { name: '完整BOM明细' })).toContainText(
    marker + 'A物料V3',
  )
  await oldFailure.release()
  await expect(
    page.getByRole('alert').filter({ hasText: '旧请求延迟失败' }),
  ).toHaveCount(0)
  const latestFailure = await hold(tree(a, imports[0]!), true)
  await page.getByLabel('BOM版本', { exact: true }).selectOption(imports[0]!)
  await latestFailure.started
  await expect(page.getByRole('table', { name: '完整BOM明细' })).toHaveCount(0)
  await latestFailure.release()
  await expect(
    page.getByRole('alert').filter({ hasText: '旧请求延迟失败' }),
  ).toBeVisible()
  await expect(page.getByLabel('BOM版本', { exact: true })).toHaveValue(
    imports[2]!,
  )
  await expect(page.getByRole('table', { name: '完整BOM明细' })).toContainText(
    marker + 'A物料V3',
  )
  const oldDiff = await hold(pathIs(`/projects/${a}/bom/diff`))
  await page
    .getByRole('button', { name: '与上一版本比较', exact: true })
    .click()
  await oldDiff.started
  await open('B')
  await oldDiff.release()
  await expect(
    page.getByRole('heading', { name: '版本差异', exact: true }),
  ).toHaveCount(0)
  const ensureB = async () => {
    await expect(
      page.getByRole('heading', { name: new RegExp(marker + 'B') }).first(),
    ).toBeVisible()
    await expect(page.getByLabel('BOM版本', { exact: true })).toHaveValue(
      bImport.importId,
    )
    await expect(
      page.getByRole('table', { name: '完整BOM明细' }),
    ).toContainText(marker + 'B物料')
    await expect(
      page.getByRole('table', { name: 'BOM导入预览', exact: true }),
    ).toHaveCount(0)
  }
  await open('A')
  const staleRefresh = await hold(pathIs(`/projects/${a}`))
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await staleRefresh.started
  await open('B')
  await staleRefresh.release()
  await ensureB()
  await open('A')
  const raw = await bytes(marker + 'A上传物料')
  await page.getByLabel('上传ERP BOM').setInputFiles({
    name: 'A-context.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: raw,
  })
  await page.getByLabel('导入模板', { exact: true }).selectOption(templateId)
  const stalePreview = await hold(pathIs(`/projects/${a}/bom/import-preview`))
  await page.getByRole('button', { name: '解析预览', exact: true }).click()
  await stalePreview.started
  await open('B')
  await stalePreview.release()
  await ensureB()
  await open('A')
  const staleDraft = await hold(
    pathIs(`/projects/${a}/bom/drafts/${draftPreview.previewToken}/resume`),
  )
  await page
    .getByRole('region', { name: '我的BOM草稿' })
    .getByRole('button', { name: '恢复预览', exact: true })
    .click()
  await staleDraft.started
  await open('B')
  await staleDraft.release()
  await ensureB()
  // A confirmed import completes in its original project even if the user moves on before its response.
  await open('A')
  await page.getByLabel('上传ERP BOM').setInputFiles({
    name: 'A-context.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: raw,
  })
  await page.getByLabel('导入模板', { exact: true }).selectOption(templateId)
  await page.getByRole('button', { name: '解析预览', exact: true }).click()
  await expect(
    page.getByRole('table', { name: 'BOM导入预览', exact: true }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: '下一步：解析确认', exact: true })
    .click()
  const importAck = await hold(pathIs(`/projects/${a}/bom/import`))
  await page
    .getByRole('button', { name: '确认导入为新版本', exact: true })
    .click()
  await importAck.started
  await open('B')
  await importAck.release()
  await ensureB()
  await expect(
    page.getByRole('status').filter({ hasText: 'BOM新版本已保存' }),
  ).toContainText(marker + 'A')
  assert.equal(
    (await service.projectDetail(users.technical!, a)).imports.length,
    4,
  )
  assert.equal(
    (await service.projectDetail(users.technical!, b)).imports.length,
    1,
  )
  await expect(page.getByLabel('BOM版本', { exact: true })).toBeEnabled()
  await page.screenshot({ path: '/tmp/npi-bom-context-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '完整BOM', exact: true }).click()
  await page.screenshot({ path: '/tmp/npi-bom-context-mobile.png' })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  )
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '/tmp/npi-bom-context-result.json',
    JSON.stringify(
      {
        passed: true,
        applicationRoot: appRoot,
        latestVersionWins: true,
        oldReadErrorsIgnored: true,
        currentReadFailureRestoresLoadedVersion: true,
        diffProjectBound: true,
        refreshProjectBound: true,
        previewProjectBound: true,
        draftResumeProjectBound: true,
        backgroundImportProjectBound: true,
        versionAndRowsConsistent: true,
        mobileOverflow: false,
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: delayed BOM versions, errors, differences, refresh, previews, drafts and import acknowledgements remain bound to their project; background import affects only its original project.',
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
  for (const id of sessions) await SessionManager.deleteSession(id)
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
