import { Hono } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { deleteCookie, setCookie } from 'hono/cookie'
import { validateRequestSession, requestToken } from '../../lib/auth/server'
import { invalidateSession, SESSION_SECONDS } from '../../lib/auth/session'
import { login } from '../../lib/auth/login'
import { changePassword } from '../../lib/auth/accounts'
import { getActor } from '../../lib/npi/service'
import { NpiError } from '../../lib/npi/domain'

const app = new Hono()
export function sessionCookie(
  c: Parameters<typeof setCookie>[0],
  token: string,
) {
  setCookie(c, 'session', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    secure: process.env.BASE_URL?.startsWith('https://') || false,
    maxAge: SESSION_SECONDS,
  })
}
app.post('/login', async (c) => {
  let address = 'local'
  try {
    address = getConnInfo(c).remote.address || address
  } catch {
    /* In-process requests have no socket. */
  }
  const result = await login(await c.req.json(), address)
  sessionCookie(c, result.sessionToken)
  return c.json({ user: result.user })
})
app.get('/me', async (c) => {
  const session = await validateRequestSession(c.req.raw)
  if (!session) return c.json({ error: '请先登录', code: 'AUTH_REQUIRED' }, 401)
  const actor = await getActor(session.user.id)
  if (session.renewed) sessionCookie(c, requestToken(c.req.raw))
  return c.json({
    user: {
      id: actor.id,
      name: actor.name,
      email: session.user.email,
      role: actor.role,
      mustChangePassword: session.user.mustChangePassword,
    },
  })
})
app.post('/logout', async (c) => {
  await invalidateSession(requestToken(c.req.raw))
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ ok: true })
})
app.post('/password', async (c) => {
  const session = await validateRequestSession(c.req.raw)
  if (!session) throw new NpiError('AUTH_REQUIRED', '请先登录', 401)
  if (c.req.header('x-npi-actor') !== session.user.id)
    throw new NpiError(
      'ACTOR_CONTEXT_CHANGED',
      '登录账号已改变，请刷新后操作',
      409,
    )
  return c.json(
    await changePassword(
      session.user.id,
      session.session.id,
      await c.req.json(),
    ),
  )
})
export default app
