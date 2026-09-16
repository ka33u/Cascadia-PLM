import { Hono } from 'hono'
import { validateRequestSession } from '../../lib/auth/server'
import * as accounts from '../../lib/auth/accounts'
import { NpiError } from '../../lib/npi/domain'
import { uuidValue } from '../../lib/npi/service'
const app = new Hono<{ Variables: { userId: string } }>()
app.use('*', async (c, next) => {
  const session = await validateRequestSession(c.req.raw)
  if (!session) throw new NpiError('AUTH_REQUIRED', '请先登录', 401)
  if (session.user.mustChangePassword)
    throw new NpiError('PASSWORD_CHANGE_REQUIRED', '请先修改初始密码', 403)
  await accounts.requireAdmin(session.user.id)
  if (c.req.method !== 'GET' && c.req.header('x-npi-actor') !== session.user.id)
    throw new NpiError(
      'ACTOR_CONTEXT_CHANGED',
      '登录账号已改变，请刷新后操作',
      409,
    )
  c.set('userId', session.user.id)
  await next()
})
app.get('/', async (c) =>
  c.json({ accounts: await accounts.listAccounts(c.get('userId')) }),
)
app.get('/history', async (c) =>
  c.json({ events: await accounts.accountHistory(c.get('userId')) }),
)
app.post('/', async (c) =>
  c.json(
    await accounts.createAccount(c.get('userId'), await c.req.json()),
    201,
  ),
)
app.patch('/:id', async (c) =>
  c.json(
    await accounts.updateAccount(
      c.get('userId'),
      uuidValue(c.req.param('id')),
      await c.req.json(),
    ),
  ),
)
app.post('/:id/password', async (c) =>
  c.json(
    await accounts.resetPassword(
      c.get('userId'),
      uuidValue(c.req.param('id')),
      await c.req.json(),
    ),
  ),
)
export default app
