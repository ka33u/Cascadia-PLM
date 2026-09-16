// SPDX-License-Identifier: AGPL-3.0-or-later
import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import ExcelJS from 'exceljs'

// Create and drop only this invocation's generated database. Never migrate the
// connection supplied by the operator or import application DB code before this.
const configured = process.env.TEST_DATABASE_URL
if (!configured) throw new Error('Explicit TEST_DATABASE_URL required')
const connection = new URL(configured)
if (
  !connection.pathname.endsWith('_test') ||
  !['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname)
)
  throw new Error('Use a local _test connection for the isolated upgrade test')
const name = `cascadia_npi_upgrade_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`
const urlFor = (database: string) => {
  const value = new URL(configured)
  value.pathname = '/' + database
  return value.toString()
}
const root = await fs.mkdtemp('/tmp/npi-upgrade-test-')
const vaultRoot = path.join(root, 'vault')
await fs.mkdir(path.join(vaultRoot, 'legacy'), { recursive: true })
const migrations = path.resolve('apps/cascadia/drizzle')
type Entry = { idx: number; tag: string; when: number }
const journal = JSON.parse(
  await fs.readFile(path.join(migrations, 'meta/_journal.json'), 'utf8'),
) as { entries: Array<Entry> }
const baselineEntries = journal.entries.filter((entry) => entry.idx <= 5)
assert.equal(baselineEntries.length, 6)
assert.equal(baselineEntries.at(-1)!.tag, '0005_cad_model_node_links')
const prepareMigrations = async (folder: string, entries: Array<Entry>) => {
  await fs.mkdir(path.join(folder, 'meta'), { recursive: true })
  await fs.writeFile(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }),
  )
  for (const entry of entries)
    await fs.copyFile(
      path.join(migrations, entry.tag + '.sql'),
      path.join(folder, entry.tag + '.sql'),
    )
}
const baselineFolder = path.join(root, 'baseline-migrations')
const faultFolder = path.join(root, 'fault-migrations')
await prepareMigrations(baselineFolder, baselineEntries)
await prepareMigrations(faultFolder, journal.entries)
await fs.appendFile(
  path.join(faultFolder, journal.entries.at(-1)!.tag + '.sql'),
  "\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION 'NPI_UPGRADE_ROLLBACK_PROBE'; END $$;\n",
)
const admin = postgres(urlFor('postgres'), { max: 1, onnotice: () => {} })
let created = false
let source: postgres.Sql | undefined
let closeApplication: (() => Promise<void>) | undefined
const report: Record<string, unknown> = {
  scope:
    'Synthetic native Cascadia data at migration 0005, upgraded with unchanged repository migrations; not a customer database clone.',
  baselineMigration: baselineEntries.at(-1)!.tag,
  targetMigration: journal.entries.at(-1)!.tag,
  results: {},
}
const results = report.results as Record<string, boolean>
try {
  await admin`create database ${admin(name)} template template0`
  created = true
  process.env.DATABASE_URL = urlFor(name)
  process.env.VAULT_ROOT = vaultRoot
  process.env.VAULT_TYPE = 'local'
  const sql = postgres(urlFor(name), { max: 3, onnotice: () => {} })
  source = sql
  await migrate(drizzle(sql), { migrationsFolder: baselineFolder })
  const tableNames = async () =>
    (
      await sql`select tablename from pg_tables where schemaname='public' order by tablename`
    ).map((row) => row.tablename as string)
  const legacyTables = await tableNames()
  assert.ok(!legacyTables.some((table) => table.startsWith('npi_')))
  const technical = randomUUID(),
    manufacturing = randomUUID(),
    buyer = randomUUID()
  for (const [id, label] of [
    [technical, '旧技术'],
    [manufacturing, '旧制造'],
    [buyer, '旧采购'],
  ])
    await sql`insert into users(id,email,name,active) values(${id!},${id! + '@upgrade.test.invalid'},${label!},true)`
  const program = randomUUID(),
    completed = randomUUID()
  await sql`insert into programs(id,name,code,status,customer,created_by,settings,attributes)
    values(${program},'旧在研项目','LEGACY-A','Active','原客户',${technical},
      ${JSON.stringify({ changeOrderNumberFormat: 'LEGACY-{NNN}', custom: '保留设置' })}::jsonb,
      ${JSON.stringify({ motor: '旧型号', nested: { keep: [0, false, '中文'] } })}::jsonb),
    (${completed},'旧已完项目','LEGACY-B','Completed','原客户2',${technical},'{}'::jsonb,'{}'::jsonb)`
  await sql`insert into program_members(program_id,user_id,role,can_create_eco,can_approve_eco,can_manage_designs)
    values(${program},${technical},'lead',true,true,true),(${program},${buyer},'viewer',false,false,false)`
  const parent = randomUUID(),
    child = randomUUID(),
    issue = randomUUID(),
    document = randomUUID()
  for (const [id, type, label] of [
    [parent, 'Task', '父任务'],
    [child, 'Task', '子任务'],
    [issue, 'Issue', '旧问题'],
    [document, 'Document', '旧资料'],
  ])
    await sql`insert into items(id,master_id,item_number,revision,item_type,name,state,created_by,modified_by,attributes)
      values(${id!},${randomUUID()},${'LEGACY-' + id!},'A',${type!},${label!},'Draft',${technical},${technical},'{}'::jsonb)`
  await sql`insert into tasks(item_id,program_id,parent_task_id,assignee,priority,due_date,estimated_hours,tags)
    values(${parent},${program},null,${manufacturing},'High','2026-10-01T08:00:00+08:00',12.50,'["旧任务"]'::jsonb),
    (${child},${program},${parent},${buyer},'Normal','2026-10-02T08:00:00+08:00',3.25,'[]'::jsonb)`
  await sql`insert into issues(item_id,program_id,description,severity,reported_by,assigned_to)
    values(${issue},${program},'旧问题说明','High',${technical},${buyer})`
  const legacyBytes = Buffer.from(
    '原项目技术资料\n保留原始字节与权限关系。\n',
    'utf8',
  )
  const legacyHash = createHash('sha256').update(legacyBytes).digest('hex')
  const fileId = randomUUID()
  await fs.writeFile(path.join(vaultRoot, 'legacy/spec.txt'), legacyBytes)
  await sql`insert into vault_files(id,item_id,file_name,original_file_name,file_size,mime_type,file_hash,storage_path,uploaded_by)
    values(${fileId},${document},'spec.txt','原技术资料.txt',${legacyBytes.length},'text/plain',${legacyHash},'legacy/spec.txt',${technical})`
  await sql`insert into documents(item_id,description,file_id,file_name,file_size,mime_type,storage_path)
    values(${document},'原有资料关联',${fileId},'原技术资料.txt',${legacyBytes.length},'text/plain','legacy/spec.txt')`
  await sql`insert into issue_affected_items(issue_item_id,affected_item_id) values(${issue},${document})`
  await sql`insert into settings(key,value,modified_by) values('vault_root',${vaultRoot},${technical})`
  const readRows = async (tables: Array<string>) => {
    const data: Record<string, Array<string>> = {}
    for (const table of tables) {
      const rows =
        await sql`select to_jsonb(t)::text as row from ${sql('public.' + table)} t order by to_jsonb(t)::text`
      data[table] = rows.map((row) => row.row as string)
    }
    return data
  }
  const shape =
    () => sql`select c.relname as table_name, a.attname as column_name,
      format_type(a.atttypid,a.atttypmod) as type, a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid) as default_value
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname='public' and c.relname in ${sql(legacyTables)}
    order by c.relname,a.attnum`
  const constraints =
    () => sql`select c.relname as table_name, p.conname, pg_get_constraintdef(p.oid) as definition
    from pg_constraint p join pg_class c on c.oid=p.conrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ${sql(legacyTables)} order by c.relname,p.conname`
  const journalRows = () =>
    sql`select * from drizzle.__drizzle_migrations order by id`
  const before = await readRows(legacyTables)
  const beforeShape = await shape(),
    beforeConstraints = await constraints(),
    beforeJournal = await journalRows()
  assert.equal(beforeJournal.length, 6)
  report.legacyTables = Object.fromEntries(
    Object.entries(before).map(([table, rows]) => [
      table,
      {
        rows: rows.length,
        sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      },
    ]),
  )
  report.postgresqlVersion = (await sql`show server_version`)[0]!.server_version
  report.sourceMigrationHashes = Object.fromEntries(
    await Promise.all(
      journal.entries.map(async (entry) => [
        entry.tag,
        createHash('sha256')
          .update(await fs.readFile(path.join(migrations, entry.tag + '.sql')))
          .digest('hex'),
      ]),
    ),
  )

  await test('Failed NPI upgrade rolls back every new table and journal entry while preserving populated legacy tables', async () => {
    await assert.rejects(
      migrate(drizzle(sql), { migrationsFolder: faultFolder }),
      /NPI_UPGRADE_ROLLBACK_PROBE/,
    )
    assert.deepEqual(await tableNames(), legacyTables)
    assert.deepEqual(await readRows(legacyTables), before)
    assert.deepEqual(await journalRows(), beforeJournal)
    assert.deepEqual(await shape(), beforeShape)
    assert.deepEqual(await constraints(), beforeConstraints)
    results.rollback = true
  })
  await test('Unchanged NPI migrations preserve all existing rows, native columns, constraints, memberships and file bytes', async () => {
    await migrate(drizzle(sql), { migrationsFolder: migrations })
    assert.equal((await journalRows()).length, journal.entries.length)
    assert.ok((await tableNames()).includes('npi_bom_previews'))
    assert.deepEqual(await readRows(legacyTables), before)
    assert.deepEqual(await shape(), beforeShape)
    assert.deepEqual(await constraints(), beforeConstraints)
    assert.deepEqual(
      await fs.readFile(path.join(vaultRoot, 'legacy/spec.txt')),
      legacyBytes,
    )
    const linked =
      await sql`select d.item_id,v.file_hash,t.parent_task_id,m.can_create_eco,m.can_approve_eco
      from documents d join vault_files v on v.id=d.file_id
      join issue_affected_items a on a.affected_item_id=d.item_id
      join issues i on i.item_id=a.issue_item_id
      join tasks t on t.program_id=i.program_id and t.item_id=${child}
      join program_members m on m.program_id=i.program_id and m.user_id=${buyer}
      where d.item_id=${document}`
    assert.equal(linked.length, 1)
    assert.equal(linked[0]!.parent_task_id, parent)
    assert.equal(linked[0]!.file_hash, legacyHash)
    assert.equal(linked[0]!.can_create_eco, false)
    assert.equal(linked[0]!.can_approve_eco, false)
    results.upgradePreservedLegacy = true
  })
  await test('Rerunning the complete migration set is a no-op', async () => {
    const tables = await tableNames(),
      rows = await readRows(tables),
      versions = await journalRows()
    await migrate(drizzle(sql), { migrationsFolder: migrations })
    assert.deepEqual(await readRows(tables), rows)
    assert.deepEqual(await journalRows(), versions)
    results.repeatMigration = true
  })
  await test('New NPI project, BOM, promises and prediction work after upgrade without changing legacy rows', async () => {
    const service = await import('../packages/core/src/lib/npi/service')
    const database = await import('../packages/core/src/lib/db')
    closeApplication = async () => {
      await (database.db as unknown as { $client: postgres.Sql }).$client.end({
        timeout: 5,
      })
      await database.migrationClient.end({ timeout: 5 })
    }
    for (const [id, role] of [
      [technical, 'technical'],
      [manufacturing, 'manufacturing'],
      [buyer, 'procurement'],
    ])
      await sql`insert into npi_user_roles(user_id,role) values(${id!},${role!})`
    await service.seedNpiConfig()
    const project = await service.createProject(technical, {
      name: '升级后新品',
      motorModel: 'UPGRADE-NPI',
      technicalOwnerId: technical,
      manufacturingOwnerId: manufacturing,
      requiredKitDate: '2026-10-15',
      prototypeRequiredDate: '2026-10-20',
    })
    const book = new ExcelJS.Workbook(),
      tab = book.addWorksheet('母件结构表-多阶')
    tab.getCell('A4').value = 'UPGRADE-NPI'
    tab.getCell('B4').value = '升级后电机'
    tab.getCell('C4').value = 'UPGRADE'
    tab.getRow(5).values = [
      '级别',
      '子件行号',
      '子件编码',
      '子件名称',
      '基本用量',
      '子件计量单位',
    ]
    tab.getRow(6).values = ['+', 10, '0001', '升级测试关键件', 1, '只']
    const bytes = new Uint8Array(await book.xlsx.writeBuffer())
    const preview = await service.createPreview(
      technical,
      project.id,
      new File([bytes], 'upgrade.xlsx'),
    )
    assert.equal(preview.summary.errors, 0)
    await service.confirmImport(technical, project.id, {
      previewToken: preview.previewToken,
      activate: true,
    })
    const tree = await service.getBom(technical, project.id)
    assert.equal(tree.rows[0]!.materialCode, '0001')
    const tracking = await service.setTracking(technical, tree.rows[0]!.id, {
      expectedVersion: 0,
      ownerId: buyer,
      requiredDate: '2026-10-15',
      trackingEnabled: true,
      affectsKit: true,
    })
    const external = await service.addExternal(technical, project.id, {
      name: '升级后外购物料',
      qty: '1',
      ownerId: buyer,
      requiredDate: '2026-10-15',
      affectsKit: true,
    })
    await service.updatePromise(buyer, tracking.id, {
      expectedVersion: 1,
      committedDate: '2026-10-17',
    })
    await service.updatePromise(buyer, external.id, {
      expectedVersion: 1,
      committedDate: '2026-10-14',
    })
    await service.manufacturingPlan(manufacturing, project.id, {
      expectedVersion: 1,
      processCommitted: '2026-10-10',
      toolingCommitted: '2026-10-12',
      kitCommitted: '2026-10-15',
      assemblyCommitted: '2026-10-20',
    })
    const detail = await service.projectDetail(technical, project.id)
    assert.equal(detail.kit.predictedKitDate, '2026-10-17')
    assert.equal(detail.kit.predictionComplete, true)
    assert.equal(detail.kit.bottleneck?.id, tracking.id)
    assert.ok(
      detail.kit.alerts.some(
        (alert) => alert.code === 'DETAIL_VS_COMMIT_CONFLICT',
      ),
    )
    assert.equal(detail.history.length, 6)
    const after = await readRows(legacyTables)
    for (const table of legacyTables) {
      const current = new Set(after[table])
      for (const row of before[table]!)
        assert.ok(current.has(row), `Legacy row changed in ${table}`)
    }
    assert.deepEqual(
      await fs.readFile(path.join(vaultRoot, 'legacy/spec.txt')),
      legacyBytes,
    )
    results.postUpgradeNpiFlow = true
  })
} finally {
  if (closeApplication) await closeApplication()
  if (source) await source.end({ timeout: 5 })
  if (created) {
    assert.match(name, /^cascadia_npi_upgrade_[a-f0-9]{12}_test$/)
    await admin`drop database ${admin(name)}`
    report.isolatedDatabaseRemoved = true
  }
  await admin.end({ timeout: 5 })
  report.completedAt = new Date().toISOString()
  await fs.writeFile(
    path.join(root, 'verification.json'),
    JSON.stringify(report, null, 2),
  )
  console.log('Upgrade verification artifacts:', root)
}
