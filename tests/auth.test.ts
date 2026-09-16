import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq } from 'drizzle-orm'
if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw new Error('Explicit _test database required')
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
const base = 'http://localhost:3499'
process.env.BASE_URL = base
const { db, client, closeDatabase } = await import('../src/lib/db')
const { users, sessions } = await import('../src/lib/db/schema/users')
const { npiUserRoles } = await import('../src/lib/db/schema/npi')
const { hashPassword, checkPassword } = await import('../src/lib/auth/accounts')
const { createSession, tokenHash } = await import('../src/lib/auth/session')
const { app } = await import('../src/server/app')
await migrate(db, { migrationsFolder: 'migrations' })
const password = 'Test-' + crypto.randomUUID()
const admin = crypto.randomUUID(),
  email = admin + '@auth.test.invalid'
await db.insert(users).values({
  id: admin,
  email,
  name: '独立账号验收管理员',
  passwordHash: await hashPassword(password),
  mustChangePassword: false,
})
await db.insert(npiUserRoles).values({ userId: admin, role: 'admin' })
const adminToken = (await createSession(admin)).sessionToken
async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  token = adminToken,
  actor = admin,
  extra: Record<string, string> = {},
) {
  const response = await app.request(base + path, {
    method,
    headers: {
      origin: base,
      'content-type': 'application/json',
      cookie: 'session=' + token,
      'x-npi-actor': actor,
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, data: await response.json() }
}
const login = async (email: string, password: string) =>
  call('/api/auth/login', 'POST', { email, password }, '')
const tokenOf = (response: Response) =>
  /session=([a-f0-9]{64})/.exec(
    response.headers.get('set-cookie') || '',
  )?.[1] || ''
let member = '',
  memberEmail = '',
  memberToken = '',
  memberPassword = ''
try {
  await test('Login uses one hashed session, strict HttpOnly cookies, normalized email and no password exposure', async () => {
    const { response, data } = await login(email.toUpperCase(), password)
    assert.equal(response.status, 200)
    const token = tokenOf(response)
    assert.equal(token.length, 64)
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/i)
    assert.match(response.headers.get('set-cookie')!, /SameSite=Strict/i)
    assert.doesNotMatch(
      JSON.stringify(data),
      /passwordHash|password_hash|sessionToken/,
    )
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, tokenHash(token)))
    assert.ok(session)
    assert.notEqual(session.id, token)
    const [user] = await db.select().from(users).where(eq(users.id, admin))
    assert.match(user!.passwordHash!, /^\$argon2id\$/)
    assert.equal(await checkPassword(user!.passwordHash, password), true)
    await call('/api/auth/logout', 'POST', {}, token)
    assert.equal(
      (await call('/api/auth/me', 'GET', undefined, token)).response.status,
      401,
    )
  })
  await test('Unauthenticated, cross-origin, malformed and non-admin requests cannot manage accounts', async () => {
    assert.equal(
      (await call('/api/accounts', 'GET', undefined, '')).response.status,
      401,
    )
    assert.equal(
      (
        await call('/api/auth/login', 'POST', { email, password }, '', admin, {
          origin: 'https://attacker.invalid',
        })
      ).response.status,
      403,
    )
    assert.equal(
      (await call('/api/accounts', 'POST', {}, adminToken, 'another-actor'))
        .response.status,
      409,
    )
    const buyer = crypto.randomUUID()
    await db.insert(users).values({
      id: buyer,
      name: '采购验收',
      email: buyer + '@auth.test.invalid',
      mustChangePassword: false,
    })
    await db.insert(npiUserRoles).values({ userId: buyer, role: 'procurement' })
    const token = (await createSession(buyer)).sessionToken
    assert.equal(
      (await call('/api/accounts', 'GET', undefined, token, buyer)).response
        .status,
      403,
    )
    assert.equal(
      (await call('/api/accounts', 'POST', {}, token, buyer)).response.status,
      403,
    )
  })
  await test('Creating an account forces password change before any business API is allowed', async () => {
    memberEmail = crypto.randomUUID() + '@auth.test.invalid'
    memberPassword = 'Temporary-' + crypto.randomUUID()
    const created = await call('/api/accounts', 'POST', {
      name: '新建采购',
      email: memberEmail,
      role: 'procurement',
      password: memberPassword,
    })
    assert.equal(created.response.status, 201)
    member = created.data.id
    const signed = await login(memberEmail, memberPassword)
    assert.equal(signed.data.user.mustChangePassword, true)
    memberToken = tokenOf(signed.response)
    const blocked = await call(
      '/api/v1/npi/meta',
      'GET',
      undefined,
      memberToken,
      member,
    )
    assert.equal(blocked.response.status, 403)
    assert.equal(blocked.data.code, 'PASSWORD_CHANGE_REQUIRED')
    assert.equal(
      (
        await call(
          '/api/auth/password',
          'POST',
          { oldPassword: 'wrong', password: 'New-' + crypto.randomUUID() },
          memberToken,
          member,
        )
      ).response.status,
      403,
    )
    const next = 'Changed-' + crypto.randomUUID()
    const another = (await createSession(member)).sessionToken
    const changed = await call(
      '/api/auth/password',
      'POST',
      { oldPassword: memberPassword, password: next },
      memberToken,
      member,
    )
    assert.equal(changed.response.status, 200)
    memberPassword = next
    assert.equal(
      (await call('/api/v1/npi/meta', 'GET', undefined, memberToken, member))
        .response.status,
      200,
    )
    assert.equal(
      (await call('/api/auth/me', 'GET', undefined, another, member)).response
        .status,
      401,
    )
  })
  await test('Concurrent versioned role edits have one winner, expire sessions and audit before/after', async () => {
    const accounts = (await call('/api/accounts')).data.accounts
    const account = accounts.find((a: { id: string }) => a.id === member)
    const results = await Promise.all(
      ['supervisor', 'technical'].map((role) =>
        call('/api/accounts/' + member, 'PATCH', {
          role,
          reason: '并发改岗验收',
          expectedVersion: account.version,
        }),
      ),
    )
    assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 409])
    assert.equal(
      (await call('/api/auth/me', 'GET', undefined, memberToken, member))
        .response.status,
      401,
    )
    const history = (await call('/api/accounts/history')).data.events
    assert.equal(
      history.filter(
        (e: { targetId: string; action: string }) =>
          e.targetId === member && e.action === 'ACCOUNT_UPDATED',
      ).length,
      1,
    )
    const event = history.find(
      (e: { targetId: string; action: string }) =>
        e.targetId === member && e.action === 'ACCOUNT_UPDATED',
    )
    assert.equal(event.detail.before.role, 'procurement')
    assert.equal(event.detail.reason, '并发改岗验收')
  })
  await test('Password reset is reasoned and versioned, invalidates all sessions and forces change again', async () => {
    const account = (await call('/api/accounts')).data.accounts.find(
      (a: { id: string }) => a.id === member,
    )
    memberToken = tokenOf((await login(memberEmail, memberPassword)).response)
    const newPassword = 'Reset-' + crypto.randomUUID()
    assert.equal(
      (
        await call('/api/accounts/' + member + '/password', 'POST', {
          password: newPassword,
          expectedVersion: account.version,
        })
      ).response.status,
      422,
    )
    assert.equal(
      (
        await call('/api/accounts/' + member + '/password', 'POST', {
          password: newPassword,
          reason: '重置验收',
          expectedVersion: account.version - 1,
        })
      ).response.status,
      409,
    )
    assert.equal(
      (
        await call('/api/accounts/' + member + '/password', 'POST', {
          password: newPassword,
          reason: '重置验收',
          expectedVersion: account.version,
        })
      ).response.status,
      200,
    )
    assert.equal(
      (await call('/api/auth/me', 'GET', undefined, memberToken, member))
        .response.status,
      401,
    )
    assert.equal(
      (await login(memberEmail, memberPassword)).response.status,
      401,
    )
    memberPassword = newPassword
    const signed = await login(memberEmail, newPassword)
    assert.equal(signed.response.status, 200)
    assert.equal(signed.data.user.mustChangePassword, true)
    memberToken = tokenOf(signed.response)
  })
  await test('Deactivation rejects existing sessions and new login; administrator cannot deactivate or demote self', async () => {
    const accounts = (await call('/api/accounts')).data.accounts
    const current = accounts.find((a: { id: string }) => a.id === admin),
      account = accounts.find((a: { id: string }) => a.id === member)
    for (const patch of [{ active: false }, { role: 'technical' }])
      assert.equal(
        (
          await call('/api/accounts/' + admin, 'PATCH', {
            ...patch,
            expectedVersion: current.version,
            reason: '保护验收',
          })
        ).response.status,
        409,
      )
    assert.equal(
      (
        await call('/api/accounts/' + member, 'PATCH', {
          active: false,
          reason: '停用验收',
          expectedVersion: account.version,
        })
      ).response.status,
      200,
    )
    assert.equal(
      (await login(memberEmail, memberPassword)).response.status,
      401,
    )
    assert.equal(
      (await call('/api/auth/me', 'GET', undefined, memberToken, member))
        .response.status,
      401,
    )
  })
  await test('Ten incorrect passwords lock the account for fifteen minutes and expiry restores login', async () => {
    const id = crypto.randomUUID(),
      address = id + '@auth.test.invalid'
    await db.insert(users).values({
      id,
      name: '锁定验收',
      email: address,
      passwordHash: await hashPassword(password),
      mustChangePassword: false,
    })
    await db.insert(npiUserRoles).values({ userId: id, role: 'technical' })
    for (let i = 0; i < 10; i++)
      assert.equal((await login(address, 'bad-password')).response.status, 401)
    const [locked] = await db.select().from(users).where(eq(users.id, id))
    assert.equal(locked!.failedAttempts, 10)
    assert.ok(locked!.lockedUntil!.getTime() > Date.now() + 14 * 60000)
    assert.equal((await login(address, password)).response.status, 401)
    await db
      .update(users)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.id, id))
    assert.equal((await login(address, password)).response.status, 200)
    const [restored] = await db.select().from(users).where(eq(users.id, id))
    assert.equal(restored!.failedAttempts, 0)
    assert.equal(restored!.lockedUntil, null)
  })
  await test('Expired sessions and administrator API-key attempts are rejected', async () => {
    const expired = (await createSession(admin)).sessionToken
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, tokenHash(expired)))
    assert.equal(
      (await call('/api/auth/me', 'GET', undefined, expired)).response.status,
      401,
    )
    assert.equal(
      (
        await call('/api/v1/npi/meta', 'GET', undefined, adminToken, admin, {
          authorization: 'Bearer fake',
        })
      ).response.status,
      401,
    )
    const audits =
      await client`select detail from account_events where target_id=${member}`
    assert.ok(!JSON.stringify(audits).includes(memberPassword))
  })
} finally {
  await closeDatabase()
}
