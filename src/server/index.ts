import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { app } from './app'
import { closeDatabase } from '../lib/db'

app.use('*', async (c, next) => {
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  )
  await next()
})
app.use('/assets/*', serveStatic({ root: './dist/client' }))
app.get('*', async (c) => {
  if (!['/', '/npi', '/login', '/account', '/accounts'].includes(c.req.path))
    return c.text('页面不存在', 404)
  try {
    return c.html(await readFile(resolve('dist/client/index.html'), 'utf8'))
  } catch {
    return c.text('请先执行 npm run build，或通过 npm run dev 启动前端', 503)
  }
})
const server = serve({
  fetch: app.fetch,
  hostname: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3410),
})
console.log(
  `新品协同已启动：${process.env.BASE_URL || 'http://localhost:3410'}`,
)
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close(() => {
      void closeDatabase().then(() => process.exit(0))
    })
  })
