// SPDX-License-Identifier: AGPL-3.0-or-later
// Focused planning permission checks only. No HTTP suite, fixtures retained or schema changes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { eq, inArray, sql } from 'drizzle-orm'
import type postgres from 'postgres'

const url = process.env.TEST_DATABASE_URL
if (!url) throw Error('Explicit TEST_DATABASE_URL required')
const target = new URL(url)
if (
  !['localhost', '127.0.0.1', '[::1]', '::1'].includes(target.hostname) ||
  !target.pathname.endsWith('_test') ||
  target.searchParams.has('host')
)
  throw Error('Only a local _test database is allowed')
process.env.DATABASE_URL = url
const database = await import('../packages/core/src/lib/db')
const service = await import('../packages/core/src/lib/npi/service')
const changes =
  await import('../packages/core/src/lib/npi/project-change-service')
const { users } = await import('../packages/core/src/lib/db/schema/users')
const { programs } = await import('../packages/core/src/lib/db/schema/programs')
const s = await import('../packages/core/src/lib/db/schema/npi')
const actor = Object.fromEntries(
  [
    'technical',
    'manufacturing',
    'procurement',
    'supervisor',
    'nextTech',
    'nextBuyer',
  ].map((role) => [role, crypto.randomUUID()]),
)
const code = 'SUP-PLAN-' + crypto.randomUUID()
const rollback = new Error('EXPECTED_SUPERVISOR_PLAN_ROLLBACK')
const checks: Array<string> = []
const resultPath = '/tmp/npi-supervisor-plan-service-result.json'
fs.rmSync(resultPath, { force: true })
const rejects = (run: () => Promise<unknown>, errorCode: string) =>
  assert.rejects(run, { code: errorCode })
let projectId = ''
let rolledBack = false
try {
  try {
    await database.db.transaction(async (tx) => {
      database.setTestDb(tx)
      try {
        await tx.execute(sql`set local statement_timeout='10s'`)
        for (const [role, id] of Object.entries(actor)) {
          await tx.insert(users).values({
            id,
            email: id + '@supervisor-plan.test.invalid',
            name: role,
            active: true,
          })
          await tx.insert(s.npiUserRoles).values({
            userId: id,
            role: (role === 'nextTech'
              ? 'technical'
              : role === 'nextBuyer'
                ? 'procurement'
                : role) as
              'technical' | 'manufacturing' | 'procurement' | 'supervisor',
          })
        }
        const p = await service.createProject(actor.technical!, {
          code,
          name: '主管计划权限专项',
          motorModel: 'SUP-PLAN',
          technicalOwnerId: actor.technical,
          manufacturingOwnerId: actor.manufacturing,
          requiredKitDate: '2026-10-15',
          prototypeRequiredDate: '2026-10-20',
        })
        projectId = p.id
        const detail = () => service.projectDetail(actor.supervisor!, p.id)
        const item = await service.addExternal(actor.technical!, p.id, {
          name: '主管协调采购件',
          qty: '1',
          ownerId: actor.procurement,
          requiredDate: '2026-10-15',
          affectsKit: true,
        })
        const reply = await service.updatePromise(actor.procurement!, item.id, {
          expectedVersion: item.version,
          committedDate: '2026-10-18',
        })
        const plan = {
          expectedVersion: reply.version,
          ownerId: actor.nextBuyer,
          requiredDate: '2026-10-17',
          reason: '主管协调要求与采购责任',
        }
        await rejects(
          () =>
            service.adjustTrackingPlan(actor.supervisor!, item.id, {
              ...plan,
              reason: '',
            }),
          'ADJUSTMENT_REASON_REQUIRED',
        )
        await rejects(
          () =>
            service.adjustTrackingPlan(actor.supervisor!, item.id, {
              ...plan,
              expectedVersion: reply.version - 1,
            }),
          'VERSION_CONFLICT',
        )
        await rejects(
          () =>
            service.adjustTrackingPlan(actor.supervisor!, item.id, {
              ...plan,
              ownerId: actor.manufacturing,
            }),
          'VALIDATION_ERROR',
        )
        const adjusted = await service.adjustTrackingPlan(
          actor.supervisor!,
          item.id,
          plan,
        )
        assert.equal(adjusted.ownerId, actor.nextBuyer)
        assert.equal(adjusted.requiredDate, '2026-10-17')
        assert.equal(adjusted.firstCommittedDate, reply.firstCommittedDate)
        assert.equal(adjusted.currentCommittedDate, reply.currentCommittedDate)
        checks.push(
          'Material plan: reason, version and owner-role checks; ownership/date changed; promises retained',
        )
        await rejects(
          () =>
            service.updatePromise(actor.procurement!, item.id, {
              expectedVersion: adjusted.version,
              committedDate: '2026-10-19',
              reason: '原责任人已交接',
            }),
          'NPI_PERMISSION_DENIED',
        )
        await rejects(
          () =>
            service.updatePromise(actor.supervisor!, item.id, {
              expectedVersion: adjusted.version,
              committedDate: '2026-10-19',
              reason: '不能代填承诺',
            }),
          'NPI_PERMISSION_DENIED',
        )
        await rejects(
          () =>
            service.completeItem(actor.supervisor!, item.id, {
              expectedVersion: adjusted.version,
              actualCompleteDate: '2026-09-15',
            }),
          'NPI_PERMISSION_DENIED',
        )
        await rejects(
          () =>
            service.correctCompletion(actor.supervisor!, item.id, {
              expectedVersion: adjusted.version,
              actualCompleteDate: '2026-09-15',
              reason: '不能更正实际日期',
            }),
          'NPI_PERMISSION_DENIED',
        )
        await rejects(
          () =>
            service.addExternal(actor.supervisor!, p.id, {
              name: '不可新增',
              qty: '1',
              ownerId: actor.procurement,
              requiredDate: '2026-10-15',
            }),
          'NPI_PERMISSION_DENIED',
        )
        await rejects(
          () =>
            service.setRole(actor.supervisor!, {
              userId: actor.nextTech,
              role: 'admin',
            }),
          'NPI_PERMISSION_DENIED',
        )
        checks.push(
          'No expansion to replies, completion, completion correction, material creation or role administration',
        )
        const initial = await detail()
        const process = initial.items.find((i) => i.trackingType === 'process')!
        await service.adjustTrackingPlan(actor.supervisor!, process.id, {
          expectedVersion: process.version,
          requiredDate: '2026-10-09',
          reason: '工艺单独安排',
        })
        const proposal = {
          expectedVersion: (await detail()).version,
          technicalOwnerId: actor.nextTech,
          requiredKitDate: '2026-10-17',
          prototypeRequiredDate: '2026-10-23',
          customer: '主管确认客户',
          reason: '主管协调项目目标和技术交接',
        }
        await rejects(
          () =>
            changes.previewProjectChange(actor.supervisor!, p.id, {
              ...proposal,
              reason: '',
            }),
          'VALIDATION_ERROR',
        )
        const stale = await changes.previewProjectChange(
          actor.supervisor!,
          p.id,
          proposal,
        )
        await service.adjustTrackingPlan(actor.supervisor!, item.id, {
          ...plan,
          expectedVersion: adjusted.version,
          requiredDate: '2026-10-16',
        })
        await rejects(
          () =>
            changes.applyProjectChange(actor.supervisor!, p.id, {
              ...proposal,
              expectedSnapshot: stale.expectedSnapshot,
            }),
          'VERSION_CONFLICT',
        )
        const preview = await changes.previewProjectChange(
          actor.supervisor!,
          p.id,
          proposal,
        )
        assert.equal(preview.canContinue, true)
        await tx
          .update(s.npiUserRoles)
          .set({ role: 'procurement' })
          .where(eq(s.npiUserRoles.userId, actor.supervisor!))
        await rejects(
          () =>
            changes.applyProjectChange(actor.supervisor!, p.id, {
              ...proposal,
              expectedSnapshot: preview.expectedSnapshot,
            }),
          'NPI_PERMISSION_DENIED',
        )
        await tx
          .update(s.npiUserRoles)
          .set({ role: 'supervisor' })
          .where(eq(s.npiUserRoles.userId, actor.supervisor!))
        const applied = await changes.applyProjectChange(
          actor.supervisor!,
          p.id,
          { ...proposal, expectedSnapshot: preview.expectedSnapshot },
        )
        assert.equal(applied.canContinue, true)
        const latest = await detail()
        assert.equal(latest.technicalOwnerId, actor.nextTech)
        assert.equal(latest.profile.customer, '主管确认客户')
        assert.equal(latest.requiredKitDate, '2026-10-17')
        assert.equal(latest.prototypeRequiredDate, '2026-10-23')
        assert.equal(
          latest.items.find((i) => i.id === process.id)!.requiredDate,
          '2026-10-09',
        )
        await rejects(
          () => service.projectDetail(actor.technical!, p.id),
          'NPI_PERMISSION_DENIED',
        )
        checks.push(
          'Project changes: preview invalidation, role recheck, owner handoff, dates/profile and continued supervisor access',
        )
        const events = await tx
          .select()
          .from(s.npiEvents)
          .where(eq(s.npiEvents.programId, p.id))
        const amendments = events.filter((e) =>
          ['PROJECT_CHANGED', 'TRACKING_PLAN_ADJUSTED'].includes(e.action),
        )
        assert.ok(amendments.length >= 3)
        assert.ok(
          amendments.every(
            (e) =>
              e.actorId === actor.supervisor &&
              (e.detail as { reason?: string }).reason,
          ),
        )
        const history = await tx
          .select()
          .from(s.npiPromiseHistory)
          .where(eq(s.npiPromiseHistory.objectId, item.id))
        assert.equal(history.length, 1)
        assert.equal(history[0]!.changedBy, actor.procurement)
        checks.push(
          'Audit records identify supervisor and reason; original promise/history/author retained',
        )
        const current = latest.items.find((i) => i.id === item.id)!
        await service.completeItem(actor.nextBuyer!, item.id, {
          expectedVersion: current.version,
          actualCompleteDate: '2026-09-15',
        })
        await rejects(
          () =>
            service.adjustTrackingPlan(actor.supervisor!, item.id, {
              ...plan,
              expectedVersion: current.version + 1,
            }),
          'INVALID_STATE_TRANSITION',
        )
        await tx
          .update(s.npiProjects)
          .set({ currentNpiStage: 'completed' })
          .where(eq(s.npiProjects.programId, p.id))
        await rejects(
          () =>
            changes.previewProjectChange(actor.supervisor!, p.id, {
              ...proposal,
              expectedVersion: latest.version,
            }),
          'INVALID_STATE_TRANSITION',
        )
        await rejects(
          () =>
            service.adjustTrackingPlan(actor.supervisor!, process.id, {
              expectedVersion: process.version + 1,
              requiredDate: '2026-10-10',
              reason: '已结项不再改计划',
            }),
          'INVALID_STATE_TRANSITION',
        )
        checks.push(
          'Completed item and closed-project plan adjustments rejected',
        )
        throw rollback
      } finally {
        database.resetDb()
      }
    })
  } catch (error) {
    if (error !== rollback) throw error
    rolledBack = true
  }
  assert.equal(rolledBack, true)
  assert.equal(checks.length, 5)
  assert.equal(
    (
      await database.db
        .select()
        .from(users)
        .where(inArray(users.id, Object.values(actor)))
    ).length,
    0,
  )
  assert.equal(
    (await database.db.select().from(programs).where(eq(programs.code, code)))
      .length,
    0,
  )
  assert.equal(
    (
      await database.db
        .select()
        .from(s.npiEvents)
        .where(eq(s.npiEvents.programId, projectId))
    ).length,
    0,
  )
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        passed: true,
        checks,
        rolledBack,
        fixtureRowsRemaining: 0,
        scope:
          'Service-level planning authorization only, single rollback transaction; no full HTTP suite, UI, schema migration or retained diagnostic fixture rows.',
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    'PASS: supervisor planning authorization; all fixture writes rolled back; zero users/projects/events remain.',
  )
} finally {
  database.resetDb()
  await (database.db as unknown as { $client: postgres.Sql }).$client.end({
    timeout: 5,
  })
  await database.migrationClient.end({ timeout: 5 })
}
