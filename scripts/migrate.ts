import 'dotenv/config'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { db, closeDatabase } from '../src/lib/db'
try {
  await migrate(db, { migrationsFolder: './migrations' })
  console.log('数据库迁移完成')
} finally {
  await closeDatabase()
}
