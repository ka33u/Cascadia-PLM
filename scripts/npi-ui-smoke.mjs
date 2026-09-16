import fs from 'node:fs/promises'
import { chromium } from '@playwright/test'
const login = await fs.readFile('.npi-local/首次登录.txt', 'utf8')
const email = /^账号：(.*)$/m.exec(login)?.[1],
  password = /^初始密码：(.*)$/m.exec(login)?.[1]
if (!email || !password)
  throw new Error('Local bootstrap credential file missing')
const browserServer = await chromium.launchServer({
  channel: 'chrome',
  headless: true,
  host: '127.0.0.1',
})
const browser = await chromium.connect(browserServer.wsEndpoint())
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
})
const page = await context.newPage()
const errors = []
let failed = false
page.on('pageerror', (error) => errors.push(error.message))
try {
  await page.goto('http://localhost:3410/npi')
  await page.waitForURL(/login/)
  await page.getByTestId('login-username').fill(email)
  await page.locator('input[type=password]').fill(password)
  await page.locator('button[type=submit]').click()
  await page.waitForURL(/\/npi\/?$/)
  await page.getByRole('heading', { name: '新品驾驶舱', exact: true }).waitFor()
  await page
    .getByRole('region', { name: '项目进度列表', exact: true })
    .waitFor()
  await page.screenshot({ path: '/tmp/npi-desktop.png', fullPage: true })
  await page
    .getByRole('button', { name: '新建新品', exact: true })
    .first()
    .click()
  await page.getByRole('dialog').waitFor()
  await page
    .getByLabel('新品名称', { exact: true })
    .fill('表单验证（取消不保存）')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '基础数据', exact: true }).click()
  await page
    .getByRole('heading', { name: 'BOM导入模板', exact: true })
    .waitFor()
  await page
    .getByLabel('搜索导入模板', { exact: true })
    .fill('erp-multilevel-v1')
  await page.getByRole('button', { name: '编辑映射', exact: true }).click()
  await page.getByLabel('模板名称', { exact: true }).waitFor()
  await page.getByRole('dialog').evaluate((el) => {
    el.scrollTop = 0
  })
  await page
    .getByRole('dialog')
    .screenshot({ path: '/tmp/npi-template-form-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('dialog').evaluate((el) => {
    el.scrollTop = 0
  })
  await page
    .getByRole('dialog')
    .screenshot({ path: '/tmp/npi-template-form-top-mobile.png' })
  if (
    await page
      .getByRole('dialog')
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1)
  )
    throw new Error('Template editor overflows on mobile')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page
    .getByRole('button', { name: '高级配置（JSON）', exact: true })
    .click()
  await page.getByLabel('字段映射配置（JSON）').fill('{invalid')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('alert').waitFor()
  if (
    await page.getByRole('button', { name: '保存', exact: true }).isDisabled()
  )
    throw new Error('Invalid JSON left form locked')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '首页', exact: true }).click()
  await page.screenshot({ path: '/tmp/npi-mobile.png', fullPage: true })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  )
  if (overflow) throw new Error('Mobile viewport overflows')
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(
    'PASS: local login, NPI dashboard, project dialog, template validation, mobile layout; no page errors.',
  )
} catch (error) {
  failed = true
  console.error(error)
  throw error
} finally {
  // Bound macOS Chrome teardown without masking any failed assertion.
  const deadline = setTimeout(() => {
    console.warn('Chrome退出等待超时；保留烟测结果并结束测试进程。')
    process.exit(failed ? 1 : 0)
  }, 10000)
  browserServer.process().kill('SIGKILL')
  await browserServer.kill()
  await browser.close()
  clearTimeout(deadline)
}
