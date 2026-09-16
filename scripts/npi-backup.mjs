// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import dotenv from 'dotenv'
import { createBackup } from './npi-backup-lib.mjs'
const appRoot = fileURLToPath(new URL('../', import.meta.url))
dotenv.config({ path: path.join(appRoot, '.env'), quiet: true })
try {
  if (!process.env.DATABASE_URL) throw new Error('未配置DATABASE_URL')
  const result = await createBackup({
    databaseUrl: process.env.DATABASE_URL,
    outputRoot: path.resolve(appRoot, '../runtime/backups'),
    baseDirectory: appRoot,
    vaultRoot: process.env.VAULT_ROOT,
    vaultType: process.env.VAULT_TYPE,
  })
  console.log(
    `完整备份完成：${result.directory}\n数据表${result.tables}张，记录${result.rows}条，附件${result.files}份。环境配置请另行受控保管。`,
  )
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
