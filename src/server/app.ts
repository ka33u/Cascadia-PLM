import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { sql } from 'drizzle-orm'
import { db } from '../lib/db'
import { NpiError } from '../lib/npi/domain'
import auth from './routes/auth'
import accounts from './routes/accounts'
import npi from './routes/npi'

export const app = new Hono()
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 6 * 1024 * 1024,
    onError: (c) => c.json({ error: '请求过大' }, 413),
  }),
)
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'same-origin')
  c.header('X-Frame-Options', 'DENY')
  if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin')
    const expected = process.env.BASE_URL
      ? new URL(process.env.BASE_URL).origin
      : new URL(c.req.url).origin
    if (
      !origin ||
      origin !== expected ||
      c.req.header('sec-fetch-site') === 'cross-site'
    )
      return c.json({ code: 'ORIGIN_DENIED', error: '请从本系统页面提交' }, 403)
  }
  await next()
})
app.use(
  '/api/auth/*',
  bodyLimit({
    maxSize: 16384,
    onError: (c) => c.json({ error: '请求过大' }, 413),
  }),
)
app.use(
  '/api/accounts/*',
  bodyLimit({
    maxSize: 65536,
    onError: (c) => c.json({ error: '请求过大' }, 413),
  }),
)
app.use('/api/*', async (c, next) => {
  if (
    !c.req.path.startsWith('/api/v1/npi/') &&
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    !c.req.header('content-type')?.startsWith('multipart/form-data')
  ) {
    const data = await c.req.json().catch(() => null)
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return c.json(
        { code: 'VALIDATION_ERROR', error: '请求正文必须是JSON对象' },
        422,
      )
  }
  await next()
})
app.onError((error, c) => {
  if (error instanceof NpiError)
    return c.json(
      { code: error.code, error: error.message },
      error.status as 400 | 401 | 403 | 404 | 409 | 422 | 429,
    )
  if (error instanceof SyntaxError)
    return c.json({ code: 'VALIDATION_ERROR', error: '请求格式不正确' }, 400)
  const pg = error as Error & { code?: string; cause?: { code?: string } }
  if (pg.code === '23505' || pg.cause?.code === '23505')
    return c.json(
      { code: 'DUPLICATE_RECORD', error: '邮箱或记录已存在，请刷新核对' },
      409,
    )
  console.error('Request failed:', error)
  return c.json(
    { code: 'INTERNAL_ERROR', error: '服务暂时不可用，请刷新核对提交结果' },
    500,
  )
})
app.route('/api/auth', auth)
app.route('/api/accounts', accounts)
app.route('/api/v1/npi', npi)
app.get('/api/health', async (c) => {
  await db.execute(sql`select 1`)
  return c.json({
    status: 'ok',
    application: 'npi-workspace',
    version: '2.0.0',
  })
})
app.all('/api/*', (c) =>
  c.json({ code: 'NOT_FOUND', error: '接口不存在' }, 404),
)
