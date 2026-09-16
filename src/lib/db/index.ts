import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

if (!process.env.DATABASE_URL)
  throw new Error('请配置 DATABASE_URL；系统不会选择默认数据库')
export const client = postgres(process.env.DATABASE_URL, { max: 10 })
export const db = drizzle(client, { schema })
export type TransactionClient = Parameters<
  Parameters<typeof db.transaction>[0]
>[0]
export const closeDatabase = () => client.end({ timeout: 5 })
