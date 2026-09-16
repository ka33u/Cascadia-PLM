import 'dotenv/config'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw new Error('Explicit _test database required')
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const { db, closeDatabase } = await import('../src/lib/db')
const { users } = await import('../src/lib/db/schema/users')
const { npiUserRoles } = await import('../src/lib/db/schema/npi')
const { hashPassword } = await import('../src/lib/auth/accounts')
await migrate(db, { migrationsFolder: 'migrations' })
const admin = crypto.randomUUID(),
  email = admin + '@ui.test.invalid',
  password = 'Admin-' + crypto.randomUUID()
await db
  .insert(users)
  .values({
    id: admin,
    name: '回归管理员',
    email,
    passwordHash: await hashPassword(password),
    mustChangePassword: false,
  })
await db.insert(npiUserRoles).values({ userId: admin, role: 'admin' })
mkdirSync('runtime/test-evidence', { recursive: true })
const root = 'http://localhost:3496',
  log = openSync('runtime/test-evidence/accounts-server.log', 'w')
const server = spawn(process.execPath, ['dist/server.mjs'], {
  stdio: ['ignore', log, log],
  env: { ...process.env, PORT: '3496', BASE_URL: root, HOST: '127.0.0.1' },
})
const browserServer = await chromium.launchServer({
  headless: true,
  ...(process.env.CI ? {} : { channel: 'chrome' }),
})
const browser = await chromium.connect(browserServer.wsEndpoint())
let failed = true
try {
  let ready = false
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(root + '/api/health')).ok) {
        ready = true
        break
      }
    } catch {}
    await delay(250)
  }
  assert.ok(ready)
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage(),
    errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(root + '/login')
  await expect(
    page.getByRole('heading', { name: '登录工作空间' }),
  ).toBeVisible()
  await page.screenshot({
    path: 'runtime/test-evidence/login-desktop.png',
    fullPage: true,
  })
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '新品驾驶舱', exact: true }),
  ).toBeVisible()
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '系统设置', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: '账号管理', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '新增账号', exact: true }).click()
  const memberEmail = crypto.randomUUID() + '@ui.test.invalid',
    temporary = 'Temporary-' + crypto.randomUUID(),
    newPassword = 'Personal-' + crypto.randomUUID()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('姓名', { exact: true }).fill('采购回归人员')
  await dialog.getByLabel('邮箱', { exact: true }).fill(memberEmail)
  await dialog
    .getByLabel('业务岗位', { exact: true })
    .selectOption('procurement')
  await dialog.getByLabel('临时密码', { exact: true }).fill(temporary)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByLabel('查找账号', { exact: true }).fill(memberEmail)
  const row = page
    .getByRole('region', { name: '账号列表', exact: true })
    .locator('tbody tr')
  await expect(row).toContainText('待修改初始密码')
  const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    phone = await phoneContext.newPage()
  phone.on('pageerror', (error) => errors.push(error.message))
  await phone.goto(root + '/login')
  await phone.getByLabel('邮箱', { exact: true }).fill(memberEmail)
  await phone.getByLabel('密码', { exact: true }).fill(temporary)
  await phone.getByRole('button', { name: '登录', exact: true }).click()
  await expect(
    phone.getByRole('heading', { name: '修改密码', exact: true }),
  ).toBeVisible()
  await phone.getByLabel('原密码', { exact: true }).fill(temporary)
  await phone.getByLabel('新密码', { exact: true }).fill(newPassword)
  await phone.getByLabel('确认新密码', { exact: true }).fill(newPassword + 'x')
  await phone.getByRole('button', { name: '保存新密码', exact: true }).click()
  await expect(phone.getByRole('alert')).toContainText('两次输入的新密码不一致')
  await phone.getByLabel('确认新密码', { exact: true }).fill(newPassword)
  await phone.getByRole('button', { name: '保存新密码', exact: true }).click()
  await expect(phone.getByRole('status')).toContainText('密码已修改')
  await phone.screenshot({
    path: 'runtime/test-evidence/account-mobile.png',
    fullPage: true,
  })
  await phone.getByRole('link', { name: '进入工作空间 →', exact: true }).click()
  await expect(
    phone.getByRole('heading', { name: '我的采购件', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '刷新账号', exact: true }).click()
  await expect(row).toContainText('已启用')
  await row.getByRole('button', { name: '重置密码', exact: true }).click()
  await dialog
    .getByLabel('临时密码', { exact: true })
    .fill('Reset-' + crypto.randomUUID())
  await dialog
    .getByLabel('调整原因', { exact: true })
    .fill('验证独立密码重置与强制退出')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await phone.reload()
  await expect(
    phone.getByRole('heading', { name: '登录工作空间', exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: 'runtime/test-evidence/accounts-desktop.png',
    fullPage: true,
  })
  await page.getByRole('link', { name: '我的账号', exact: true }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '登录工作空间', exact: true }),
  ).toBeVisible()
  assert.deepEqual(errors, [])
  console.log(
    'PASS: actual login, integrated account creation, mobile forced password change, field validation, password reset, session revocation and logout.',
  )
  failed = false
 } catch(error) {
  console.error(error)
  for (const [i,context] of browser.contexts().entries()) {
    const page=context.pages()[0]
    if(page) {
      await page.screenshot({path:'runtime/test-evidence/account-failure-'+i+'.png',fullPage:true}).catch(()=>{})
      console.error(await page.locator('body').innerText().catch(()=>''))
    }
  }
  throw error
} finally {
  server.kill('SIGTERM')
  closeSync(log)
  await closeDatabase()
  const deadline = setTimeout(() => process.exit(failed ? 1 : 0), 10000)
  await browser.close()
  await browserServer.close()
  clearTimeout(deadline)
}
