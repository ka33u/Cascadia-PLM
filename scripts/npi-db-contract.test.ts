// SPDX-License-Identifier: AGPL-3.0-or-later
// Only SRS DB-01/DB-02: all fixture writes roll back in one transaction.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import postgres from 'postgres'

const url = process.env.TEST_DATABASE_URL
if (!url) throw Error('Explicit TEST_DATABASE_URL required')
const target = new URL(url)
if (
  !target.pathname.endsWith('_test') ||
  !['localhost', '127.0.0.1', '[::1]', '::1'].includes(target.hostname)
)
  throw Error('Only a local, explicit _test database is allowed')
const sql = postgres(url, { max: 1 })
const ids = Object.fromEntries(
  [
    'user',
    'program',
    'import',
    'import2',
    'duplicate',
    'parent',
    'child',
    'tracking',
    'history',
  ].map((key) => [key, crypto.randomUUID()]),
)
const rollback = new Error('EXPECTED_TEST_ROLLBACK')
const checks: Array<string> = []
let rolledBack = false
try {
  try {
    await sql.begin(async (tx) => {
      await tx`set local lock_timeout = '3s'`
      await tx`set local statement_timeout = '10s'`
      await tx`insert into users(id,email,name,active) values(${ids.user!},${ids.user! + '@db-contract.test.invalid'},'DB contract fixture',true)`
      await tx`insert into programs(id,name,code,created_by) values(${ids.program!},'DB contract fixture',${'DB-' + ids.program!},${ids.user!})`
      await tx`insert into npi_projects(program_id,motor_model,technical_owner_id,manufacturing_owner_id,required_kit_date,prototype_required_date) values(${ids.program!},'DB-fixture',${ids.user!},${ids.user!},'2026-10-10','2026-10-20')`
      await tx`insert into npi_manufacturing_plan(program_id) values(${ids.program!})`
      await tx`insert into npi_bom_imports(id,program_id,version_no,template_id,mother,sheet_name,row_count,max_level,source_name,source_base64,source_hash,template_snapshot,imported_by) values(${ids.import!},${ids.program!},1,'db-fixture','{}'::jsonb,'db-fixture',2,2,'constraint-fixture','ZGI=',${'0'.repeat(64)},'{}'::jsonb,${ids.user!})`
      await tx`insert into npi_bom_items(id,import_id,parent_id,level,material_code,row) values(${ids.parent!},${ids.import!},null,1,'PARENT','{}'::jsonb),(${ids.child!},${ids.import!},${ids.parent!},2,'CHILD','{}'::jsonb)`
      await tx`insert into npi_tracking_items(id,program_id,bom_item_id,source_type,tracking_type,name,owner_id,required_date) values(${ids.tracking!},${ids.program!},${ids.child!},'ERP_BOM','material','DB fixture',${ids.user!},'2026-10-10')`
      await tx`insert into npi_promise_history(id,program_id,object_id,object_type,new_committed_date,reason,changed_by) values(${ids.history!},${ids.program!},${ids.tracking!},'TRACKING_ITEM','2026-10-12','DB fixture',${ids.user!})`
      const rejectsForeignKey = async (statement: string, id: string) =>
        assert.rejects(
          tx.savepoint((sp) => sp.unsafe(statement, [id])),
          { code: '23503' },
        )
      await rejectsForeignKey('delete from programs where id=$1', ids.program!)
      await rejectsForeignKey(
        'delete from npi_tracking_items where id=$1',
        ids.tracking!,
      )
      await rejectsForeignKey(
        'delete from npi_bom_items where id=$1',
        ids.child!,
      )
      await rejectsForeignKey(
        'delete from npi_bom_items where id=$1',
        ids.parent!,
      )
      assert.equal(
        (
          await tx`select count(*)::int as n from npi_promise_history where id=${ids.history!}`
        )[0]!.n,
        1,
      )
      assert.equal(
        (
          await tx`select count(*)::int as n from npi_bom_items where import_id=${ids.import!}`
        )[0]!.n,
        2,
      )
      checks.push(
        'DB-01: NPI project, referenced tracking and BOM deletion rejected; records retained',
      )
      await assert.rejects(
        tx.savepoint(
          (sp) =>
            sp`insert into npi_bom_items(id,import_id,level,material_code,row) values(${crypto.randomUUID()},${crypto.randomUUID()},1,'ORPHAN','{}'::jsonb)`,
        ),
        { code: '23503' },
      )
      checks.push('DB-01: orphan BOM row insert rejected')
      await assert.rejects(
        tx.savepoint(
          (sp) =>
            sp`insert into npi_bom_imports(id,program_id,version_no,template_id,mother,sheet_name,row_count,max_level,source_name,source_base64,source_hash,template_snapshot,imported_by) select ${ids.duplicate!},program_id,version_no,template_id,mother,sheet_name,row_count,max_level,source_name,source_base64,source_hash,template_snapshot,imported_by from npi_bom_imports where id=${ids.import!}`,
        ),
        { code: '23505', constraint_name: 'npi_bom_program_version' },
      )
      await tx`insert into npi_bom_imports(id,program_id,version_no,template_id,mother,sheet_name,row_count,max_level,source_name,source_base64,source_hash,template_snapshot,imported_by) select ${ids.import2!},program_id,2,template_id,mother,sheet_name,row_count,max_level,source_name,source_base64,source_hash,template_snapshot,imported_by from npi_bom_imports where id=${ids.import!}`
      assert.equal(
        (
          await tx`select count(*)::int as n from npi_bom_imports where program_id=${ids.program!}`
        )[0]!.n,
        2,
      )
      checks.push(
        'DB-02: duplicate project/version rejected; distinct version accepted',
      )
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
    rolledBack = true
  }
  assert.equal(rolledBack, true)
  assert.equal(checks.length, 3)
  const residuals = {
    users: (
      await sql`select count(*)::int as n from users where id=${ids.user!}`
    )[0]!.n,
    programs: (
      await sql`select count(*)::int as n from programs where id=${ids.program!}`
    )[0]!.n,
    imports: (
      await sql`select count(*)::int as n from npi_bom_imports where program_id=${ids.program!}`
    )[0]!.n,
    tracking: (
      await sql`select count(*)::int as n from npi_tracking_items where program_id=${ids.program!}`
    )[0]!.n,
    history: (
      await sql`select count(*)::int as n from npi_promise_history where program_id=${ids.program!}`
    )[0]!.n,
  }
  assert.ok(Object.values(residuals).every((n) => n === 0))
  fs.writeFileSync(
    '/tmp/npi-db-contract-result.json',
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        passed: true,
        scope: ['DB-01', 'DB-02'],
        checks,
        rolledBack,
        residuals,
        fixtureIds: ids,
        note: 'Database constraints only; no HTTP or browser flow, no retained fixtures and no complete SRS acceptance claim.',
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: DB-01/DB-02 constraints; all fixture writes rolled back and zero residual rows verified.',
  )
} finally {
  await sql.end({ timeout: 5 })
}
