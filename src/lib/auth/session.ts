import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import { db } from '../db'
import type { TransactionClient } from '../db'
import { sessions, users } from '../db/schema/users'

export const SESSION_SECONDS = 8 * 60 * 60
export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex')
export async function createSession(
  userId: string,
  run: TransactionClient | typeof db = db,
) {
  const sessionToken = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000)
  await run
    .insert(sessions)
    .values({ id: tokenHash(sessionToken), userId, expiresAt })
  await run.delete(sessions).where(lt(sessions.expiresAt, new Date()))
  return { sessionToken, expiresAt }
}
export async function validateSession(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, tokenHash(token)),
        gt(sessions.expiresAt, new Date()),
        eq(users.active, true),
      ),
    )
  if (!row) return null
  let renewed = false
  if (row.session.expiresAt.getTime() - Date.now() < SESSION_SECONDS * 500) {
    row.session.expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000)
    const updated = await db
      .update(sessions)
      .set({ expiresAt: row.session.expiresAt })
      .where(eq(sessions.id, row.session.id))
      .returning({ id: sessions.id })
    if (!updated.length) return null
    renewed = true
  }
  const {
    passwordHash: _password,
    failedAttempts: _failures,
    ...user
  } = row.user
  return { session: row.session, user, renewed }
}
export async function invalidateSession(token: string) {
  await db.delete(sessions).where(eq(sessions.id, tokenHash(token)))
}
export const SessionManager = { createSession }
