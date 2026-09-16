// SPDX-License-Identifier: AGPL-3.0-or-later
import 'dotenv/config'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../packages/core/src/lib/db'
import {
  users,
  roles,
  userRoles,
} from '../packages/core/src/lib/db/schema/users'
import { npiUserRoles } from '../packages/core/src/lib/db/schema/npi'
import { hashPassword } from '../packages/core/src/lib/auth/password'
import {
  ROLE_DEFINITIONS,
  roleToDbFormat,
} from '../packages/core/src/lib/auth/permissions'
import { seedNpiConfig } from '../packages/core/src/lib/npi/service'
if (new URL(process.env.DATABASE_URL!).pathname !== '/cascadia_npi')
  throw new Error('Bootstrap targets only independent cascadia_npi database')
const email = 'admin@npi.local'
const [existing] = await db.select().from(users).where(eq(users.email, email))
if (!existing) {
  const password = `Npi-${randomBytes(12).toString('base64url')}9a`
  const id = crypto.randomUUID()
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({
        id,
        email,
        name: 'NPI 管理员',
        passwordHash: await hashPassword(password),
        active: true,
        provider: 'local',
      })
    const def = ROLE_DEFINITIONS.Administrator!
    const [role] = await tx
      .insert(roles)
      .values({
        name: def.name,
        description: def.description,
        permissions: roleToDbFormat(def),
      })
      .onConflictDoUpdate({
        target: roles.name,
        set: { permissions: roleToDbFormat(def) },
      })
      .returning()
    await tx.insert(userRoles).values({ userId: id, roleId: role!.id })
    await tx.insert(npiUserRoles).values({ userId: id, role: 'admin' })
  })
  fs.mkdirSync('.npi-local', { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    '.npi-local/首次登录.txt',
    `独立 Cascadia NPI\n地址：http://localhost:3410/npi\n账号：${email}\n初始密码：${password}\n首次登录后请修改密码。此文件只保存在本机，不进入源码仓库。\n`,
    { mode: 0o600 },
  )
  console.log(
    'Initial administrator created; credentials saved privately in .npi-local/首次登录.txt',
  )
} else console.log('Existing administrator preserved.')
await seedNpiConfig()
process.exit(0)
