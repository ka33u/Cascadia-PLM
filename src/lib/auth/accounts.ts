import { hash, verify, Algorithm } from '@node-rs/argon2'
import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { db } from '../db'
import { accountEvents, sessions, users } from '../db/schema/users'
import { npiUserRoles } from '../db/schema/npi'
import { NpiError, textValue } from '../npi/domain'
import { getActor, versionCheck } from '../npi/service'
import type { TransactionClient } from '../db'

export const roleNames = {
  admin: '管理员',
  technical: '技术负责人',
  manufacturing: '制造负责人',
  procurement: '采购责任人',
  supervisor: '主管',
} as const
export type AccountRole = keyof typeof roleNames
export function roleValue(value: unknown): AccountRole {
  if (typeof value !== 'string' || !Object.hasOwn(roleNames, value))
    throw new NpiError('VALIDATION_ERROR', '请选择有效岗位')
  return value as AccountRole
}
export function emailValue(value: unknown) {
  const email = textValue(value, '邮箱', 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new NpiError('VALIDATION_ERROR', '邮箱格式不正确')
  return email
}
export function passwordValue(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length < 10 ||
    value.length > 128 ||
    !value.trim()
  )
    throw new NpiError('VALIDATION_ERROR', '密码须为10至128个字符')
  return value
}
export const hashPassword = (password: string) =>
  hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  })
export const checkPassword = async (
  encoded: string | null,
  password: string,
) => {
  try {
    return encoded ? await verify(encoded, password) : false
  } catch {
    return false
  }
}
const accountLock = (tx: TransactionClient) =>
  tx.execute(sql`select pg_advisory_xact_lock(73421001)`)
export async function requireAdmin(
  userId: string,
  tx: TransactionClient | typeof db = db,
) {
  const actor = await getActor(userId, tx)
  if (actor.role !== 'admin')
    throw new NpiError('NPI_PERMISSION_DENIED', '仅管理员可管理账号', 403)
  return actor
}
const fields = {
  id: users.id,
  email: users.email,
  name: users.name,
  active: users.active,
  version: users.version,
  mustChangePassword: users.mustChangePassword,
  lockedUntil: users.lockedUntil,
  createdAt: users.createdAt,
  role: npiUserRoles.role,
}
export async function listAccounts(actorId: string) {
  await requireAdmin(actorId)
  return db
    .select(fields)
    .from(users)
    .leftJoin(npiUserRoles, eq(npiUserRoles.userId, users.id))
    .orderBy(users.name, users.email)
}
export async function createAccount(
  actorId: string,
  input: Record<string, unknown>,
) {
  await requireAdmin(actorId)
  const passwordHash = await hashPassword(passwordValue(input.password))
  const email = emailValue(input.email),
    name = textValue(input.name, '姓名', 100),
    role = roleValue(input.role)
  return db.transaction(async (tx) => {
    await accountLock(tx)
    await requireAdmin(actorId, tx)
    const [user] = await tx
      .insert(users)
      .values({ email, name, passwordHash, mustChangePassword: true })
      .returning({ id: users.id })
    await tx.insert(npiUserRoles).values({ userId: user!.id, role })
    await tx.insert(accountEvents).values({
      actorId,
      targetId: user!.id,
      action: 'ACCOUNT_CREATED',
      detail: { email, name, role },
    })
    return user!
  })
}
export async function updateAccount(
  actorId: string,
  targetId: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    await accountLock(tx)
    await requireAdmin(actorId, tx)
    const [target] = await tx
      .select(fields)
      .from(users)
      .leftJoin(npiUserRoles, eq(npiUserRoles.userId, users.id))
      .where(eq(users.id, targetId))
      .for('update', { of: users })
    if (!target) throw new NpiError('USER_NOT_FOUND', '账号不存在', 404)
    versionCheck(target.version, input.expectedVersion)
    const role = roleValue(input.role === undefined ? target.role : input.role)
    const active = input.active === undefined ? target.active : input.active
    if (typeof active !== 'boolean')
      throw new NpiError('VALIDATION_ERROR', '启用状态无效')
    if (actorId === targetId && (!active || role !== 'admin'))
      throw new NpiError(
        'SELF_PROTECTION',
        '不能停用自己或移除自己的管理员岗位',
        409,
      )
    const name =
      input.name === undefined
        ? target.name
        : textValue(input.name, '姓名', 100)
    const email =
      input.email === undefined ? target.email : emailValue(input.email)
    const reason = textValue(input.reason, '调整原因', 2000)
    await tx
      .update(users)
      .set({
        name,
        email,
        active,
        version: target.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(users.id, targetId))
    await tx
      .insert(npiUserRoles)
      .values({ userId: targetId, role })
      .onConflictDoUpdate({ target: npiUserRoles.userId, set: { role } })
    if (!active || role !== target.role || email !== target.email)
      await tx.delete(sessions).where(eq(sessions.userId, targetId))
    await tx.insert(accountEvents).values({
      actorId,
      targetId,
      action: 'ACCOUNT_UPDATED',
      detail: {
        reason,
        before: {
          name: target.name,
          email: target.email,
          active: target.active,
          role: target.role,
        },
        after: { name, email, active, role },
      },
    })
    return {
      id: targetId,
      userId: targetId,
      role,
      version: target.version + 1,
    }
  })
}
export async function resetPassword(
  actorId: string,
  targetId: string,
  input: Record<string, unknown>,
) {
  await requireAdmin(actorId)
  const passwordHash = await hashPassword(passwordValue(input.password))
  const reason = textValue(input.reason, '重置原因', 2000)
  return db.transaction(async (tx) => {
    await accountLock(tx)
    await requireAdmin(actorId, tx)
    const [target] = await tx
      .select()
      .from(users)
      .where(eq(users.id, targetId))
      .for('update')
    if (!target) throw new NpiError('USER_NOT_FOUND', '账号不存在', 404)
    versionCheck(target.version, input.expectedVersion)
    await tx
      .update(users)
      .set({
        passwordHash,
        mustChangePassword: true,
        failedAttempts: 0,
        lockedUntil: null,
        version: target.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(users.id, targetId))
    await tx.delete(sessions).where(eq(sessions.userId, targetId))
    await tx.insert(accountEvents).values({
      actorId,
      targetId,
      action: 'PASSWORD_RESET',
      detail: { reason },
    })
    return { ok: true }
  })
}
export async function changePassword(
  userId: string,
  sessionId: string,
  input: Record<string, unknown>,
) {
  const password = passwordValue(input.password)
  if (password === input.oldPassword)
    throw new NpiError('VALIDATION_ERROR', '新密码须与原密码不同')
  const passwordHash = await hashPassword(password)
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for('update')
    const [session] = await tx
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.userId, userId),
          sql`${sessions.expiresAt} > now()`,
        ),
      )
    if (
      !user?.active ||
      !session ||
      typeof input.oldPassword !== 'string' ||
      input.oldPassword.length > 128 ||
      !(await checkPassword(user.passwordHash, input.oldPassword))
    )
      throw new NpiError('INVALID_PASSWORD', '原密码不正确或登录已失效', 403)
    await tx
      .update(users)
      .set({
        passwordHash,
        mustChangePassword: false,
        version: user.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
    await tx
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, sessionId)))
    await tx.insert(accountEvents).values({
      actorId: userId,
      targetId: userId,
      action: 'PASSWORD_CHANGED',
    })
    return { ok: true }
  })
}
export async function accountHistory(actorId: string) {
  await requireAdmin(actorId)
  return db
    .select({
      id: accountEvents.id,
      action: accountEvents.action,
      detail: accountEvents.detail,
      createdAt: accountEvents.createdAt,
      actorId: accountEvents.actorId,
      targetId: accountEvents.targetId,
    })
    .from(accountEvents)
    .orderBy(desc(accountEvents.createdAt))
    .limit(200)
}
