import 'dotenv/config'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { db, closeDatabase } from '../src/lib/db'
import { users, accountEvents } from '../src/lib/db/schema/users'
import { npiUserRoles } from '../src/lib/db/schema/npi'
import {
  emailValue,
  hashPassword,
  passwordValue,
} from '../src/lib/auth/accounts'
import { seedNpiConfig } from '../src/lib/npi/service'
try {
  await migrate(db, { migrationsFolder: './migrations' })
  await seedNpiConfig()
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(73421001)`)
    if ((await tx.select({ id: users.id }).from(users).limit(1)).length) {
      console.log('已有账号，保留现有密码和岗位')
      return
    }
    const email = emailValue(process.env.ADMIN_EMAIL),
      password = passwordValue(process.env.ADMIN_PASSWORD)
    if (password.includes('REPLACE_') || password.includes('CHANGE_ME'))
      throw new Error('请设置独立的管理员初始密码')
    const [user] = await tx
      .insert(users)
      .values({
        email,
        name: process.env.ADMIN_NAME?.trim() || '管理员',
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
      })
      .returning({ id: users.id })
    await tx.insert(npiUserRoles).values({ userId: user!.id, role: 'admin' })
    await tx.insert(accountEvents).values({
      actorId: user!.id,
      targetId: user!.id,
      action: 'ADMIN_INITIALIZED',
    })
    console.log('管理员已创建；首次登录必须修改初始密码')
  })
} finally {
  await closeDatabase()
}
