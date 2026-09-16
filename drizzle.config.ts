import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/db/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL || '' },
})
