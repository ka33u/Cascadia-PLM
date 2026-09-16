import { createHash } from 'node:crypto'
import { eq, lt, sql } from 'drizzle-orm'
import { db } from '../db'
import { accountEvents, loginLimits, users } from '../db/schema/users'
import { npiUserRoles } from '../db/schema/npi'
import { NpiError } from '../npi/domain'
import { checkPassword, emailValue, hashPassword } from './accounts'
import { createSession } from './session'

// Unknown addresses still perform the same password work as existing accounts.
const dummyHash = hashPassword('unused-' + crypto.randomUUID())
export async function login(input: Record<string, unknown>, address: string) {
  const email = emailValue(input.email)
  if (
    typeof input.password !== 'string' ||
    !input.password ||
    input.password.length > 128
  )
    throw new NpiError('LOGIN_FAILED', '邮箱或密码不正确', 401)
  const password = input.password
  const key = createHash('sha256').update(address).digest('hex')
  const [limit] = await db
    .insert(loginLimits)
    .values({ key, count: 1, expiresAt: new Date(Date.now() + 15 * 60000) })
    .onConflictDoUpdate({
      target: loginLimits.key,
      set: {
        count: sql`case when ${loginLimits.expiresAt} < now() then 1 else ${loginLimits.count} + 1 end`,
        expiresAt: sql`case when ${loginLimits.expiresAt} < now() then now() + interval '15 minutes' else ${loginLimits.expiresAt} end`,
      },
    })
    .returning()
  if (limit!.count > 100)
    throw new NpiError(
      'LOGIN_RATE_LIMIT',
      '登录尝试过于频繁，请15分钟后重试',
      429,
    )
  await db.delete(loginLimits).where(lt(loginLimits.expiresAt, new Date()))
  const result = await db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.email, email))
      .for('update')
    const valid = await checkPassword(
      user?.passwordHash || (await dummyHash),
      password,
    )
    const locked = user?.lockedUntil && user.lockedUntil.getTime() > Date.now()
    const [mapping] = user
      ? await tx
          .select()
          .from(npiUserRoles)
          .where(eq(npiUserRoles.userId, user.id))
      : []
    if (!user || !user.active || !valid || locked || !mapping) {
      if (user && !locked) {
        const failures = (user.lockedUntil ? 0 : user.failedAttempts) + 1
        await tx
          .update(users)
          .set({
            failedAttempts: failures,
            lockedUntil:
              failures >= 10 ? new Date(Date.now() + 15 * 60000) : null,
          })
          .where(eq(users.id, user.id))
        await tx.insert(accountEvents).values({
          targetId: user.id,
          action: failures >= 10 ? 'LOGIN_LOCKED' : 'LOGIN_FAILED',
        })
      }
      return null
    }
    await tx
      .update(users)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(users.id, user.id))
    const session = await createSession(user.id, tx)
    await tx.insert(accountEvents).values({
      actorId: user.id,
      targetId: user.id,
      action: 'LOGIN_SUCCEEDED',
    })
    return {
      ...session,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: mapping.role,
        mustChangePassword: user.mustChangePassword,
      },
    }
  })
  if (!result)
    throw new NpiError(
      'LOGIN_FAILED',
      '邮箱或密码不正确；连续10次失败会锁定15分钟',
      401,
    )
  return result
}
