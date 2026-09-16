// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import dotenv from 'dotenv'
import { restoreBackup, verifyBackup } from './npi-backup-lib.mjs'
const appRoot = fileURLToPath(new URL('../', import.meta.url))
dotenv.config({ path: path.join(appRoot, '.env'), quiet: true })
try {
  const [mode, backup, ...args] = process.argv.slice(2)
  if (mode === 'verify' && backup && !args.length) {
    const m = await verifyBackup(path.resolve(backup))
    console.log(
      `备份完整性校验通过：${m.tables.length}张表，${m.files.length}份附件。此检查不替代恢复演练。`,
    )
  } else if (
    mode === 'restore' &&
    backup &&
    args.length === 6 &&
    args[0] === '--database' &&
    args[2] === '--directory' &&
    args[4] === '--operator-email' &&
    process.env.DATABASE_URL
  ) {
    const r = await restoreBackup({
      backupDirectory: path.resolve(backup),
      administrativeUrl: process.env.DATABASE_URL,
      databaseName: args[1],
      outputDirectory: path.resolve(args[3]),
      operatorEmail: args[5],
    })
    console.log(
      `恢复校验通过：${r.databaseName}\n独立附件目录：${r.vaultRoot}\n尚未切换运行连接。恢复报告位于新目录RESTORE_VERIFIED.json。`,
    )
  } else
    throw new Error(
      '用法：node scripts/npi-restore.mjs verify <备份目录>\n或：node scripts/npi-restore.mjs restore <备份目录> --database cascadia_npi_restore_<唯一编号> --directory <尚不存在的新目录> --operator-email <恢复库中已有的启用账号邮箱>',
    )
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
