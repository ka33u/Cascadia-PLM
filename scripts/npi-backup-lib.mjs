// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'

const FORMAT = 'cascadia-npi-backup-v1'
const hashPattern = /^[a-f0-9]{64}$/
const testSource = /^cascadia_npi_backup_[a-f0-9]{8}_test$/
const restoreName = /^cascadia_npi_restore_[a-z0-9_]{8,32}$/
const fail = (message) => {
  throw new Error(message)
}
export function databaseUrlFor(raw, name) {
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    fail('需要PostgreSQL连接')
  url.pathname = `/${name}`
  return url.toString()
}
function connect(raw) {
  return postgres(raw, { max: 1, onnotice: () => {}, connect_timeout: 10 })
}
export function connectionEnv(raw) {
  const u = new URL(raw)
  // Credentials stay in the child environment, never command arguments or manifests.
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGSSLMODE: u.searchParams.get('sslmode') || 'prefer',
  }
}
async function command(name, args, raw) {
  await new Promise((resolve, reject) => {
    const child = spawn(name, args, {
      env: connectionEnv(raw),
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let errors = ''
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk.toString()).slice(-12000)
    })
    child.once('error', () =>
      reject(new Error(`${name}无法启动，请确认已安装兼容版本PostgreSQL工具`)),
    )
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${name}失败：${errors || `退出码${code}`}`)),
    )
  })
}
export function safeRelative(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    value.split('/').some((p) => !p || p === '.' || p === '..') ||
    /^[A-Za-z]:/.test(value)
  )
    fail('文件相对路径无效')
  return value
}
async function safeFile(root, relative) {
  const parts = safeRelative(relative).split('/')
  let current = root
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part)
    const st = await fs.lstat(current)
    if (
      st.isSymbolicLink() ||
      (i === parts.length - 1 ? !st.isFile() : !st.isDirectory())
    )
      fail('备份/附件路径不能包含符号链接或特殊文件')
  }
  return current
}
async function fileDigest(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = await handle.stat()
    if (!st.isFile()) fail('只支持普通文件')
    const digest = createHash('sha256')
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk)
      size += chunk.length
    }
    return { size, sha256: digest.digest('hex') }
  } finally {
    await handle.close()
  }
}
async function copyChecked(root, relative, target, expected) {
  const source = await safeFile(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const from = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  const to = await fs.open(target, 'wx', 0o600)
  const digest = createHash('sha256')
  let size = 0
  try {
    for await (const chunk of from.createReadStream({ autoClose: false })) {
      digest.update(chunk)
      size += chunk.length
      let offset = 0
      while (offset < chunk.length)
        offset += (await to.write(chunk, offset)).bytesWritten
    }
    if (size !== expected.size || digest.digest('hex') !== expected.sha256)
      fail('附件内容与数据库快照校验值不一致，备份/恢复已停止')
    await to.sync()
  } finally {
    await from.close()
    await to.close()
  }
}
async function tables(sql) {
  return sql`select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname not like 'pg_%' and n.nspname <> 'information_schema' order by n.nspname,c.relname`
}
async function tableDigests(sql, list) {
  const result = []
  await sql`set local timezone = 'UTC'`
  await sql`set local datestyle = 'ISO, YMD'`
  await sql`set local extra_float_digits = 3`
  for (const table of list) {
    const digest = createHash('sha256')
    let rows = 0
    // Stream one sorted row at a time: ERP rows can embed multi-MB base64 files. Includes duplicate rows.
    const query = sql`select row_to_json(t)::text as value from only ${sql(table.schema)}.${sql(table.name)} t order by (row_to_json(t)::text) collate "C"`
    for await (const batch of query.cursor(1))
      for (const row of batch) {
        digest.update(row.value)
        digest.update('\n')
        rows++
      }
    result.push({ ...table, rows, sha256: digest.digest('hex') })
  }
  return result
}
async function vaultRows(sql) {
  return (
    await sql`select id, storage_path as path, file_size as size, file_hash as sha256, storage_type as "storageType" from vault_files order by id`
  ).map((r) => ({ ...r, size: Number(r.size) }))
}
function uniqueFiles(rows) {
  const result = new Map()
  for (const r of rows) {
    safeRelative(r.path)
    if (
      r.storageType !== 'local' ||
      !hashPattern.test(r.sha256) ||
      !Number.isSafeInteger(r.size) ||
      r.size < 0
    )
      fail('只支持具有有效SHA-256的本地Vault文件')
    const existing = result.get(r.path)
    if (existing && (existing.sha256 !== r.sha256 || existing.size !== r.size))
      fail('同一Vault路径存在相互冲突的文件元数据')
    result.set(r.path, { path: r.path, size: r.size, sha256: r.sha256 })
  }
  return [...result.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
}
/** @param {{databaseUrl:string, outputRoot:string, baseDirectory:string, vaultRoot?:string, vaultType?:string, allowTestDatabase?:boolean, onSnapshot?:()=>Promise<void>}} options */
export async function createBackup(options) {
  const name = decodeURIComponent(
    new URL(options.databaseUrl).pathname.slice(1),
  )
  if (
    name !== 'cascadia_npi' &&
    !(options.allowTestDatabase && testSource.test(name))
  )
    fail('备份脚本只允许独立cascadia_npi数据库')
  if ((options.vaultType || 'local') !== 'local')
    fail('此备份工具暂不支持S3，请勿将本地备份当作S3备份')
  await fs.mkdir(options.outputRoot, { recursive: true, mode: 0o700 })
  const outputRoot = await fs.realpath(options.outputRoot)
  const id = `npi-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`
  const pending = path.join(outputRoot, `.pending-${id}`),
    completed = path.join(outputRoot, id)
  await fs.mkdir(pending, { mode: 0o700 })
  const sql = connect(options.databaseUrl)
  try {
    const manifest = await sql.begin(
      'isolation level repeatable read read only',
      async (tx) => {
        const list = await tables(tx)
        // Prevent a concurrent DROP/ALTER from invalidating this backup's relation set.
        for (const t of list)
          await tx`lock table ${tx(t.schema)}.${tx(t.name)} in access share mode`
        const [snapshot] =
          await tx`select pg_export_snapshot() as id, current_setting('server_version') as version, transaction_timestamp() as started_at`
        await options.onSnapshot?.()
        const [setting] =
          await tx`select value from settings where key='vault_root'`
        const root = path.resolve(
          options.baseDirectory,
          setting?.value || options.vaultRoot || './vault',
        )
        const records = await vaultRows(tx),
          files = uniqueFiles(records)
        const effectiveRoot = files.length ? await fs.realpath(root) : root
        const relativeOutput = path.relative(effectiveRoot, outputRoot)
        if (
          !relativeOutput ||
          (!relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput))
        )
          fail('备份目录不能位于Vault内部')
        await fs.mkdir(path.join(pending, 'vault'), { mode: 0o700 })
        const content = await tableDigests(tx, list)
        // pg_dump sees exactly the same exported MVCC snapshot as the manifest.
        await command(
          'pg_dump',
          [
            '--format=custom',
            '--no-owner',
            '--no-acl',
            `--snapshot=${snapshot.id}`,
            '--file',
            path.join(pending, 'database.dump'),
          ],
          options.databaseUrl,
        )
        await fs.chmod(path.join(pending, 'database.dump'), 0o600)
        for (const f of files)
          await copyChecked(
            effectiveRoot,
            f.path,
            path.join(pending, 'vault', f.path),
            f,
          )
        return {
          format: FORMAT,
          id,
          createdAt: new Date().toISOString(),
          sourceDatabase: name,
          postgresVersion: snapshot.version,
          snapshotStartedAt: snapshot.started_at,
          database: {
            file: 'database.dump',
            ...(await fileDigest(path.join(pending, 'database.dump'))),
          },
          tables: content,
          vaultRecords: records,
          files,
        }
      },
    )
    await fs.writeFile(
      path.join(pending, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    )
    await verifyBackup(pending)
    await fs.rename(pending, completed)
    return {
      directory: completed,
      tables: manifest.tables.length,
      rows: manifest.tables.reduce((n, t) => n + t.rows, 0),
      files: manifest.files.length,
      bytes: manifest.files.reduce((n, f) => n + f.size, 0),
    }
  } catch (error) {
    await fs.rm(pending, { recursive: true, force: true })
    throw error
  } finally {
    await sql.end({ timeout: 5 })
  }
}
export async function verifyBackup(directory) {
  const root = await fs.realpath(directory)
  const manifestPath = await safeFile(root, 'manifest.json')
  if ((await fs.stat(manifestPath)).size > 64 * 1024 * 1024)
    fail('备份清单超过允许大小')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  if (
    manifest.format !== FORMAT ||
    manifest.database?.file !== 'database.dump' ||
    !Array.isArray(manifest.tables) ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.vaultRecords)
  )
    fail('备份格式无效或不完整')
  const keys = new Set()
  for (const t of manifest.tables) {
    if (
      typeof t.schema !== 'string' ||
      typeof t.name !== 'string' ||
      !hashPattern.test(t.sha256) ||
      !Number.isSafeInteger(t.rows) ||
      t.rows < 0 ||
      keys.has(`${t.schema}\0${t.name}`)
    )
      fail('数据表校验清单无效')
    keys.add(`${t.schema}\0${t.name}`)
  }
  if (
    JSON.stringify(uniqueFiles(manifest.vaultRecords)) !==
    JSON.stringify(manifest.files)
  )
    fail('Vault清单不一致')
  for (const f of [
    manifest.database,
    ...manifest.files.map((f) => ({
      ...f,
      file: `vault/${safeRelative(f.path)}`,
    })),
  ]) {
    if (
      !Number.isSafeInteger(f.size) ||
      f.size < 0 ||
      !hashPattern.test(f.sha256)
    )
      fail('文件校验清单无效')
    const actual = await fileDigest(await safeFile(root, f.file))
    if (actual.size !== f.size || actual.sha256 !== f.sha256)
      fail('备份文件损坏或不完整，拒绝恢复')
  }
  return manifest
}
/** @param {{backupDirectory:string, administrativeUrl:string, databaseName:string, outputDirectory:string, operatorEmail:string}} options */
export async function restoreBackup(options) {
  if (!restoreName.test(options.databaseName))
    fail(
      '恢复库名称必须为cascadia_npi_restore_加8至32位小写字母/数字/下划线；不允许覆盖运行库',
    )
  if (
    typeof options.operatorEmail !== 'string' ||
    !options.operatorEmail.trim()
  )
    fail('需要指定恢复审计账号邮箱')
  const manifest = await verifyBackup(options.backupDirectory)
  const adminUrl = databaseUrlFor(options.administrativeUrl, 'postgres')
  const admin = connect(adminUrl)
  const output = path.resolve(options.outputDirectory)
  let created = false,
    sql
  try {
    const existing =
      await admin`select datname from pg_database where datname=${options.databaseName}`
    if (existing.length) fail('恢复目标数据库已存在，拒绝覆盖')
    try {
      await fs.lstat(output)
      fail('恢复目标目录已存在，拒绝覆盖')
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    // No --clean, DROP or in-place restore. A partial failed restore is retained.
    await fs.mkdir(output, { mode: 0o700 })
    await fs.mkdir(path.join(output, 'vault'), { mode: 0o700 })
    await admin`create database ${admin(options.databaseName)} template template0`
    created = true
    const targetUrl = databaseUrlFor(
      options.administrativeUrl,
      options.databaseName,
    )
    await command(
      'pg_restore',
      [
        '--exit-on-error',
        '--single-transaction',
        '--no-owner',
        '--no-acl',
        '--dbname',
        options.databaseName,
        path.join(await fs.realpath(options.backupDirectory), 'database.dump'),
      ],
      targetUrl,
    )
    sql = connect(targetUrl)
    const [operator] =
      await sql`select id from users where email=${options.operatorEmail} and active=true`
    if (!operator) fail('恢复库中不存在该启用审计账号')
    await sql.begin('isolation level repeatable read read only', async (tx) => {
      const actual = await tableDigests(tx, await tables(tx))
      if (JSON.stringify(actual) !== JSON.stringify(manifest.tables))
        fail('恢复后数据表逐行摘要不一致，禁止切换运行连接')
      const records = await vaultRows(tx)
      if (JSON.stringify(records) !== JSON.stringify(manifest.vaultRecords))
        fail('恢复后Vault元数据不一致')
    })
    const backupRoot = await fs.realpath(options.backupDirectory)
    for (const f of manifest.files)
      await copyChecked(
        path.join(backupRoot, 'vault'),
        f.path,
        path.join(output, 'vault', f.path),
        f,
      )
    // Only after verifying the exact restored content, redirect this *new* DB
    // to its isolated copied bytes. Never leave it pointing at the live Vault.
    await sql`insert into settings(key,value,modified_by) values('vault_root',${path.join(output, 'vault')},${operator.id}) on conflict(key) do update set value=excluded.value,modified_by=excluded.modified_by,modified_at=now()`
    const result = {
      format: FORMAT,
      verifiedAt: new Date().toISOString(),
      databaseName: options.databaseName,
      vaultRoot: path.join(output, 'vault'),
      sourceBackup: manifest.id,
      tables: manifest.tables.length,
      files: manifest.files.length,
      rows: manifest.tables.reduce((n, t) => n + t.rows, 0),
      adjustedSettings: ['vault_root'],
      environmentCopied: false,
      operatorEmail: options.operatorEmail,
    }
    await fs.writeFile(
      path.join(output, 'RESTORE_VERIFIED.json'),
      JSON.stringify(result, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    )
    return result
  } catch (error) {
    if (sql)
      await sql`update settings set value=${path.join(output, 'vault')} where key='vault_root'`.catch(
        () => {},
      )
    if (created)
      await fs
        .writeFile(
          path.join(output, 'RESTORE_FAILED.txt'),
          '恢复未通过校验，禁止切换运行连接。保留此新库与目录用于排查；运行库未改动。\n',
          { mode: 0o600 },
        )
        .catch(() => {})
    throw error
  } finally {
    if (sql) await sql.end({ timeout: 5 })
    await admin.end({ timeout: 5 })
  }
}
