// SPDX-License-Identifier: AGPL-3.0-or-later
import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import ExcelJS from 'exceljs'
import {
  createBackup,
  databaseUrlFor,
  restoreBackup,
  safeRelative,
  verifyBackup,
} from './npi-backup-lib.mjs'

const baseUrl = process.env.DATABASE_URL
if (!baseUrl || new URL(baseUrl).pathname !== '/cascadia_npi')
  throw new Error(
    'Use independent NPI administrative connection; all test writes go to new isolated databases',
  )
const token = randomUUID().slice(0, 8)
const sourceName = `cascadia_npi_backup_${token}_test`
const sourceUrl = databaseUrlFor(baseUrl, sourceName)
const admin = postgres(databaseUrlFor(baseUrl, 'postgres'), {
  max: 1,
  onnotice: () => {},
})
const names: Array<string> = []
const restoreTargets: Array<{ name: string; directory: string }> = []
const root = await fs.mkdtemp('/tmp/npi-recovery-test-')
const vaultRoot = path.join(root, 'source-vault'),
  outputRoot = path.join(root, 'backups')
await fs.mkdir(vaultRoot, { mode: 0o700 })
await admin`create database ${admin(sourceName)} template template0`
names.push(sourceName)
process.env.DATABASE_URL = sourceUrl
process.env.VAULT_ROOT = path.join(root, 'unused-env-vault')
process.env.VAULT_TYPE = 'local'
const source = postgres(sourceUrl, { max: 3, onnotice: () => {} })
try {
  await migrate(drizzle(source), { migrationsFolder: 'apps/cascadia/drizzle' })
  const service = await import('../packages/core/src/lib/npi/service')
  const files = await import('../packages/core/src/lib/npi/file-service')
  const issue = await import('../packages/core/src/lib/npi/issue-service')
  const users: Record<string, string> = {}
  for (const role of ['technical', 'manufacturing', 'procurement']) {
    const id = randomUUID()
    users[role] = id
    await source`insert into users(id,email,name,active) values(${id},${`${id}@recovery.test.invalid`},${role},true)`
    await source`insert into npi_user_roles(user_id,role) values(${id},${role})`
  }
  await source`insert into settings(key,value,modified_by) values('vault_root',${vaultRoot},${users.technical!})`
  await service.seedNpiConfig()
  const project = await service.createProject(users.technical!, {
    name: '完整恢复演练',
    motorModel: 'RECOVERY-160',
    technicalOwnerId: users.technical,
    manufacturingOwnerId: users.manufacturing,
    requiredKitDate: '2026-10-15',
    prototypeRequiredDate: '2026-10-20',
  })
  const item = await service.addExternal(users.technical!, project.id, {
    name: '恢复测试编码器',
    qty: '2',
    ownerId: users.procurement,
    requiredDate: '2026-10-15',
    affectsKit: true,
  })
  await service.updatePromise(users.procurement!, item.id, {
    committedDate: '2026-10-13',
    expectedVersion: 1,
  })
  await issue.createIssue(users.technical!, project.id, {
    title: '恢复测试问题',
    description: '校验原生Issue及责任人',
    severity: 'High',
    ownerId: users.procurement,
    targetDate: '2026-10-15',
  })
  const wb = new ExcelJS.Workbook(),
    sheet = wb.addWorksheet('母件结构表-多阶')
  sheet.getCell('A4').value = 'RECOVERY-160'
  sheet.getCell('B4').value = '恢复测试电机'
  sheet.getCell('C4').value = 'TEST'
  sheet.getRow(5).values = [
    '级别',
    '子件行号',
    '子件编码',
    '子件名称',
    '基本用量',
    '子件计量单位',
    '供应类型',
    '仓库名称',
    '领料部门名称',
  ]
  sheet.getRow(6).values = [
    '+',
    10,
    '000123',
    '测试轴承',
    1,
    '只',
    '领用',
    '原料库',
    '金工',
  ]
  const workbook = Buffer.from(await wb.xlsx.writeBuffer())
  const preview = await service.createPreview(
    users.technical!,
    project.id,
    new File([new Uint8Array(workbook)], '恢复原件.xlsx'),
  )
  await service.confirmImport(users.technical!, project.id, {
    previewToken: preview.previewToken,
  })
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n',
  )
  const hash = createHash('sha256').update(pdf).digest('hex')
  const attachment = await files.uploadFile(
    users.technical!,
    { kind: 'tracking', id: item.id },
    new File([new Uint8Array(pdf)], '规格.pdf'),
    { category: 'technical', requestId: randomUUID() },
  )
  const [stored] =
    await source`select v.storage_path from npi_file_links l join vault_files v on v.id=l.file_id where l.id=${attachment.id}`
  const storedPath = path.join(vaultRoot, stored!.storage_path)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=',
    'base64',
  )
  const photo = await files.uploadFile(
    users.technical!,
    { kind: 'project', id: project.id },
    new File([new Uint8Array(png)], '恢复照片.png'),
    { category: 'technical', requestId: randomUUID() },
  )
  const [photoFile] =
    await source`select v.storage_path from npi_file_links l join vault_files v on v.id=l.file_id where l.id=${photo.id}`

  const backupOptions = {
    databaseUrl: sourceUrl,
    outputRoot,
    baseDirectory: process.cwd(),
    vaultRoot: process.env.VAULT_ROOT,
    allowTestDatabase: true,
  }
  const restoreOptions = (backupDirectory: string) => {
    const databaseName = `cascadia_npi_restore_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    restoreTargets.push({
      name: databaseName,
      directory: path.join(root, databaseName),
    })
    return {
      backupDirectory,
      administrativeUrl: baseUrl,
      operatorEmail: `${users.technical}@recovery.test.invalid`,
      databaseName,
      outputDirectory: path.join(root, databaseName),
    }
  }
  let backupDirectory = ''
  await test('Same MVCC snapshot covers full database, BOM original, commitments and Vault while live writes continue', async () => {
    const result = await createBackup({
      ...backupOptions,
      onSnapshot: async () => {
        await service.updatePromise(users.procurement!, item.id, {
          committedDate: '2026-10-14',
          expectedVersion: 2,
          reason: '快照建立后并发改期',
        })
        await files.uploadFile(
          users.procurement!,
          { kind: 'tracking', id: item.id },
          new File([new Uint8Array(pdf)], '新增到货资料.pdf'),
          { category: 'receipt', requestId: randomUUID() },
        )
      },
    })
    backupDirectory = result.directory
    const manifest = await verifyBackup(backupDirectory)
    assert.equal(manifest.files.length, 2)
    assert.equal(
      manifest.tables.find(
        (t: { name: string }) => t.name === 'npi_promise_history',
      ).rows,
      1,
    )
    assert.equal((await source`select * from npi_promise_history`).length, 2)
    assert.equal((await source`select * from npi_file_links`).length, 3)
    assert.equal((await fs.stat(backupDirectory)).mode & 0o777, 0o700)
    assert.equal(
      (await fs.stat(path.join(backupDirectory, 'database.dump'))).mode & 0o777,
      0o600,
    )
    const password = decodeURIComponent(new URL(baseUrl).password)
    if (password) assert.ok(!JSON.stringify(manifest).includes(password))
    assert.ok(
      !(await fs.readdir(outputRoot)).some((n) => n.startsWith('.pending-')),
    )
  })
  await test('Restore into a new database and Vault verifies every table; native application reads restored bytes independently', async () => {
    const opts = restoreOptions(backupDirectory),
      result = await restoreBackup(opts)
    const target = postgres(databaseUrlFor(baseUrl, opts.databaseName), {
      max: 1,
    })
    try {
      assert.deepEqual(
        await fs.readFile(path.join(result.vaultRoot, photoFile!.storage_path)),
        png,
      )
      const [t] =
        await target`select first_committed_date::text as first_committed_date, current_committed_date::text as current_committed_date from npi_tracking_items where id=${item.id}`
      assert.equal(t!.first_committed_date, '2026-10-13')
      assert.equal(t!.current_committed_date, '2026-10-13')
      const [original] =
        await target`select source_base64 from npi_bom_imports where program_id=${project.id}`
      assert.deepEqual(Buffer.from(original!.source_base64, 'base64'), workbook)
      assert.equal(
        (await target`select value from settings where key='vault_root'`)[0]!
          .value,
        result.vaultRoot,
      )
      await fs.writeFile(storedPath, 'Source changed after backup')
      try {
        const proof = execFileSync(
          process.execPath,
          [
            '--import',
            'tsx',
            'scripts/npi-recovery-probe.ts',
            users.technical!,
            project.id,
            attachment.id,
            hash,
          ],
          {
            env: {
              ...process.env,
              DATABASE_URL: databaseUrlFor(baseUrl, opts.databaseName),
            },
            encoding: 'utf8',
            timeout: 60000,
          },
        )
        assert.match(proof, /PASS: restored project/)
      } finally {
        await fs.writeFile(storedPath, pdf)
      }
      assert.ok(
        await fs.stat(path.join(opts.outputDirectory, 'RESTORE_VERIFIED.json')),
      )
      await assert.rejects(restoreBackup(opts), /已存在/)
      assert.equal(
        (await target`select count(*)::int as n from npi_projects`)[0]!.n,
        1,
      )
    } finally {
      await target.end()
    }
  })
  await test('Dump or attachment corruption is refused before creating a destination database', async () => {
    for (const file of ['database.dump', `vault/${stored!.storage_path}`]) {
      const damaged = path.join(root, randomUUID())
      await fs.cp(backupDirectory, damaged, { recursive: true })
      await fs.appendFile(path.join(damaged, file), 'damage')
      const opts = restoreOptions(damaged)
      await assert.rejects(restoreBackup(opts), /损坏|不完整/)
      assert.equal(
        (
          await admin`select * from pg_database where datname=${opts.databaseName}`
        ).length,
        0,
      )
      await assert.rejects(fs.stat(opts.outputDirectory), { code: 'ENOENT' })
    }
  })
  await test('Traversal, duplicate metadata and symlink paths are rejected; live database names cannot be restore targets', async () => {
    for (const value of [
      '../escape',
      '/etc/passwd',
      'a/../escape',
      'C:/escape',
      'a\\b',
      'a//b',
    ])
      assert.throws(() => safeRelative(value))
    const damaged = path.join(root, randomUUID())
    await fs.cp(backupDirectory, damaged, { recursive: true })
    const p = path.join(damaged, 'manifest.json'),
      m = JSON.parse(await fs.readFile(p, 'utf8'))
    m.vaultRecords[0].path = '../escape'
    m.files[0].path = '../escape'
    await fs.writeFile(p, JSON.stringify(m))
    await assert.rejects(verifyBackup(damaged), /路径/)
    await assert.rejects(
      restoreBackup({
        ...restoreOptions(backupDirectory),
        databaseName: 'cascadia_npi',
      }),
      /不允许覆盖/,
    )
    const symlinked = path.join(root, randomUUID())
    await fs.cp(backupDirectory, symlinked, { recursive: true })
    const file = path.join(symlinked, 'vault', stored!.storage_path)
    await fs.rm(file)
    await fs.symlink(storedPath, file)
    await assert.rejects(verifyBackup(symlinked), /符号链接/)
    const conflict = path.join(root, randomUUID())
    await fs.cp(backupDirectory, conflict, { recursive: true })
    const manifestPath = path.join(conflict, 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    manifest.vaultRecords.push({
      ...manifest.vaultRecords[0],
      id: randomUUID(),
      sha256: 'f'.repeat(64),
    })
    await fs.writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(verifyBackup(conflict), /冲突/)
  })
  await test('Missing or corrupted source bytes do not publish a partial backup; existing good backups remain valid', async () => {
    const before = await fs.readdir(outputRoot)
    await fs.writeFile(storedPath, 'Broken source')
    try {
      await assert.rejects(createBackup(backupOptions), /不一致/)
    } finally {
      await fs.writeFile(storedPath, pdf)
    }
    assert.deepEqual(await fs.readdir(outputRoot), before)
    await verifyBackup(backupDirectory)
    await fs.rename(storedPath, storedPath + '.held')
    try {
      await assert.rejects(createBackup(backupOptions), { code: 'ENOENT' })
    } finally {
      await fs.rename(storedPath + '.held', storedPath)
    }
    assert.deepEqual(await fs.readdir(outputRoot), before)
  })
  await test('Restore content mismatch leaves explicit failed evidence and isolates the copied database Vault setting', async () => {
    const damaged = path.join(root, randomUUID())
    await fs.cp(backupDirectory, damaged, { recursive: true })
    const p = path.join(damaged, 'manifest.json'),
      m = JSON.parse(await fs.readFile(p, 'utf8'))
    m.tables.find((t: { name: string }) => t.name === 'npi_projects').sha256 =
      '0'.repeat(64)
    await fs.writeFile(p, JSON.stringify(m))
    const opts = restoreOptions(damaged)
    await assert.rejects(restoreBackup(opts), /逐行摘要不一致/)
    await fs.stat(path.join(opts.outputDirectory, 'RESTORE_FAILED.txt'))
    await assert.rejects(
      fs.stat(path.join(opts.outputDirectory, 'RESTORE_VERIFIED.json')),
      { code: 'ENOENT' },
    )
    const target = postgres(databaseUrlFor(baseUrl, opts.databaseName), {
      max: 1,
    })
    try {
      assert.equal(
        (await target`select value from settings where key='vault_root'`)[0]!
          .value,
        path.join(opts.outputDirectory, 'vault'),
      )
    } finally {
      await target.end()
    }
  })
  await test('Absent Vault setting is recreated with explicit operator attribution and isolated recovery path', async () => {
    await source`delete from settings where key='vault_root'`
    try {
      const b = await createBackup({ ...backupOptions, vaultRoot })
      const opts = restoreOptions(b.directory),
        result = await restoreBackup(opts)
      const target = postgres(databaseUrlFor(baseUrl, opts.databaseName), {
        max: 1,
      })
      try {
        const [setting] =
          await target`select value,modified_by from settings where key='vault_root'`
        assert.equal(setting!.value, result.vaultRoot)
        assert.equal(setting!.modified_by, users.technical)
        assert.equal(result.files, 3)
      } finally {
        await target.end()
      }
    } finally {
      await source`insert into settings(key,value,modified_by) values('vault_root',${vaultRoot},${users.technical!})`
    }
  })
  console.log('Recovery test artifacts:', root)
} finally {
  const database = await import('../packages/core/src/lib/db')
  await (database.db as unknown as { $client: postgres.Sql }).$client.end({
    timeout: 5,
  })
  await database.migrationClient.end({ timeout: 5 })
  await source.end({ timeout: 5 })
  // Only unique databases created/named by this isolated test may be cleaned up.
  for (const target of restoreTargets) {
    const owned = await Promise.all(
      ['RESTORE_VERIFIED.json', 'RESTORE_FAILED.txt'].map((name) =>
        fs.stat(path.join(target.directory, name)).then(
          () => true,
          () => false,
        ),
      ),
    )
    if (owned.some(Boolean)) names.push(target.name)
  }
  for (const name of names) await admin`drop database if exists ${admin(name)}`
  await admin.end({ timeout: 5 })
}
