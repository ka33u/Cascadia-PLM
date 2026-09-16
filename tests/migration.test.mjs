import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { migrateLegacy } from '../scripts/migrate-legacy.mjs'
if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw new Error('Explicit _test database required')
const base = new URL(process.env.TEST_DATABASE_URL),
  suffix = Date.now()
const sourceUrl = new URL(base),
  targetUrl = new URL(base)
sourceUrl.pathname = `/npi_migration_source_${suffix}_test`
targetUrl.pathname = `/npi_migration_target_${suffix}_test`
base.pathname = '/postgres'
const admin = postgres(base.href, { max: 1 })
for (const name of [sourceUrl.pathname.slice(1), targetUrl.pathname.slice(1)])
  await admin.unsafe('create database ' + name)
await admin.end()
const source = postgres(sourceUrl.href, { max: 1 }),
  target = postgres(targetUrl.href, { max: 1 })
const sourceFiles = await mkdtemp(join(tmpdir(), 'npi-migration-source-')),
  targetFiles = await mkdtemp(join(tmpdir(), 'npi-migration-target-'))
try {
  for (const db of [source, target])
    await migrate(drizzle(db), { migrationsFolder: 'migrations' })
  // Minimal SQL fixture describes the input format; no old application code is run.
  await source.unsafe(`alter table projects rename to programs;
alter table users add column failed_login_attempts integer not null default 0;
create table roles(id uuid primary key,name text);
create table user_roles(user_id uuid,role_id uuid);
create table items(id uuid primary key,item_number text,name text,is_deleted boolean default false,created_by uuid,created_at timestamptz default now(),modified_at timestamptz default now(),state text);
create table issues(item_id uuid primary key,program_id uuid,description text,severity text,assigned_to uuid);
create table npi_issue_links(item_id uuid primary key,program_id uuid,target_date date,tracking_item_id uuid,bom_item_id uuid,version integer);
create table workflow_instances(id uuid primary key,item_id uuid);
create table workflow_history(id uuid primary key,instance_id uuid,from_state text,to_state text,comments text,actor_id uuid,timestamp timestamptz default now());
create table documents(item_id uuid primary key,file_id uuid);
create table vault_files(id uuid primary key,item_id uuid,original_file_name text,file_size integer,mime_type text,file_hash text,storage_path text,deleted_at timestamptz);
create table npi_file_links(id uuid primary key,program_id uuid,document_id uuid,file_id uuid,tracking_item_id uuid,issue_id uuid,category text,request_id uuid,request_hash text,uploaded_by uuid,created_at timestamptz default now(),archived_at timestamptz,archived_by uuid,archive_reason text);
create table auth_events(id uuid primary key,user_id uuid,event_type text,metadata jsonb,timestamp timestamptz default now());`)
  const user = randomUUID(),
    project = randomUUID(),
    bom = randomUUID(),
    row = randomUUID(),
    tracking = randomUUID(),
    issue = randomUUID(),
    document = randomUUID(),
    file = randomUUID(),
    link = randomUUID(),
    workflow = randomUUID(),
    role = randomUUID()
  await source`insert into users(id,email,name,password_hash) values(${user},'migration@test.invalid','迁移验收','preserved-hash')`
  await source`insert into roles(id,name) values(${role},'Administrator')`
  await source`insert into user_roles(user_id,role_id) values(${user},${role})`
  await source`insert into sessions(id,user_id,expires_at) values('never-migrate-this-session',${user},now()+interval '8 hours')`
  await source`insert into programs(id,code,name,created_by,updated_by,attributes) values(${project},'MIGRATION','迁移项目',${user},${user},'{}')`
  await source`insert into npi_projects(program_id,motor_model,technical_owner_id,manufacturing_owner_id,required_kit_date,prototype_required_date) values(${project},'M-160',${user},${user},'2026-10-15','2026-10-20')`
  await source`insert into npi_bom_imports(id,program_id,version_no,template_id,mother,sheet_name,row_count,max_level,source_name,source_base64,source_hash,template_snapshot,imported_by) values(${bom},${project},1,'ERP','{}','BOM',1,1,'bom.xlsx','c291cmNl','test-hash','{}',${user})`
  await source`insert into npi_bom_items(id,import_id,level,material_code,row) values(${row},${bom},1,'00123','{"materialCode":"00123","qty":"1.234567"}')`
  await source`update npi_projects set active_bom_import_id=${bom} where program_id=${project}`
  await source`insert into npi_tracking_items(id,program_id,bom_item_id,source_type,tracking_type,name,owner_id,required_date,first_committed_date,current_committed_date) values(${tracking},${project},${row},'ERP_BOM','material','保留承诺',${user},'2026-10-15','2026-10-10','2026-10-12')`
  await source`insert into npi_promise_history(program_id,object_id,object_type,old_committed_date,new_committed_date,reason,changed_by) values(${project},${tracking},'material','2026-10-10','2026-10-12','迁移保留原因',${user})`
  await source`insert into items(id,item_number,name,created_by,state) values(${issue},'ISS-001','迁移问题',${user},'InProgress'),(${document},'DOC-001','迁移资料',${user},'Draft')`
  await source`insert into issues(item_id,program_id,description,severity,assigned_to) values(${issue},${project},'问题说明','High',${user})`
  await source`insert into npi_issue_links(item_id,program_id,target_date,tracking_item_id,version) values(${issue},${project},'2026-10-15',${tracking},2)`
  await source`insert into workflow_instances(id,item_id) values(${workflow},${issue})`
  await source`insert into workflow_history(id,instance_id,from_state,to_state,comments,actor_id) values(${randomUUID()},${workflow},'Open','InProgress','开始处理',${user})`
  await source`insert into documents(item_id,file_id) values(${document},${file})`
  const bytes = Buffer.from('%PDF-1.4\n%%EOF\n'),
    hash = createHash('sha256').update(bytes).digest('hex')
  await source`insert into vault_files(id,item_id,original_file_name,file_size,mime_type,file_hash,storage_path) values(${file},${document},'规格.pdf',${bytes.length},'application/pdf',${hash},'spec.pdf')`
  await source`insert into npi_file_links(id,program_id,document_id,file_id,issue_id,category,request_id,request_hash,uploaded_by) values(${link},${project},${document},${file},${issue},'issue',${randomUUID()},'request-hash',${user})`
  await source`insert into auth_events(id,user_id,event_type,metadata) values(${randomUUID()},${user},'login_success','{}')`
  const options = {
    sourceUrl: sourceUrl.href,
    targetUrl: targetUrl.href,
    sourceFiles,
    targetFiles,
  }
  await test('Migration rejects corrupted attachments and atomically rolls back all target records', async () => {
    await writeFile(join(sourceFiles, 'spec.pdf'), 'bad bytes')
    await assert.rejects(() => migrateLegacy(options), /校验和不匹配/)
    assert.equal((await target`select count(*)::int as n from users`)[0].n, 0)
    assert.equal(
      (await target`select count(*)::int as n from projects`)[0].n,
      0,
    )
  })
  await test('Migration preserves identities, passwords, BOM bytes/quantities, promises, issue state/history and exact attachment bytes', async () => {
    await writeFile(join(sourceFiles, 'spec.pdf'), bytes)
    const result = await migrateLegacy(options)
    assert.equal(result.committed, true)
    assert.equal(
      (await target`select password_hash from users where id=${user}`)[0]
        .password_hash,
      'preserved-hash',
    )
    assert.equal(
      (await target`select must_change_password from users where id=${user}`)[0]
        .must_change_password,
      true,
    )
    assert.equal(
      (await target`select role from npi_user_roles where user_id=${user}`)[0]
        .role,
      'admin',
    )
    assert.equal(
      (await target`select count(*)::int as n from sessions`)[0].n,
      0,
    )
    assert.equal(
      (
        await target`select source_base64 from npi_bom_imports where id=${bom}`
      )[0].source_base64,
      'c291cmNl',
    )
    assert.equal(
      (await target`select row from npi_bom_items where id=${row}`)[0].row.qty,
      '1.234567',
    )
    assert.equal(
      (
        await target`select first_committed_date from npi_tracking_items where id=${tracking}`
      )[0].first_committed_date,
      '2026-10-10',
    )
    assert.equal(
      (await target`select reason from npi_promise_history`)[0].reason,
      '迁移保留原因',
    )
    assert.equal(
      (await target`select state from npi_issues where id=${issue}`)[0].state,
      'InProgress',
    )
    assert.equal(
      (await target`select comments from npi_issue_history`)[0].comments,
      '开始处理',
    )
    assert.deepEqual(await readFile(join(targetFiles, link + '.pdf')), bytes)
    assert.equal(
      (await source`select count(*)::int as n from sessions`)[0].n,
      1,
    )
    await assert.rejects(() => migrateLegacy(options), /目标数据库已有数据/)
    assert.equal((await target`select count(*)::int as n from users`)[0].n, 1)
  })
} finally {
  await source.end()
  await target.end()
}
