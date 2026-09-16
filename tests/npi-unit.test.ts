// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ExcelJS from 'exceljs'
import { suggestBomTracking } from '../src/lib/npi/bom-tracking'
import { normalizeBomQuantity } from '../src/lib/npi/bom-quantity'
import {
  confirmMother,
  restoreConfirmedMother,
} from '../src/lib/npi/mother-confirmation'
import {
  dateValue,
  itemStatus,
  kitStatus,
  promiseChange,
  today,
} from '../src/lib/npi/domain'
import {
  businessDayRange,
  promiseChangeCounts,
  todayActivity,
} from '../src/lib/npi/activity'
import {
  bomDiff,
  defaultTemplate,
  parseBom,
} from '../src/lib/npi/bom'
import {
  previewExcel,
  validateWorkbookArchive,
} from '../src/lib/npi/excel'
import {
  dashboardMetrics,
  projectMatchesFilter,
  scopeDashboardProjects,
  selectDashboardProjects,
} from '../src/lib/npi/project-dashboard'
import {
  prepareProjectProfile,
  readProjectProfile,
} from '../src/lib/npi/project-profile'
import type { DatedItem } from '../src/lib/npi/domain'

const item = (extra: Partial<DatedItem> = {}): DatedItem => ({
  id: 'item',
  name: '机壳',
  ownerId: 'mfg',
  requiredDate: '2026-10-15',
  firstCommittedDate: null,
  currentCommittedDate: null,
  actualCompleteDate: null,
  version: 1,
  affectsKit: true,
  trackingEnabled: true,
  trackingType: 'material',
  sourceType: 'ERP_BOM',
  ...extra,
})
const template = {
  ...defaultTemplate,
  headerRow: 1,
  dataStartRow: 2,
  motherInfoMapping: { code: 'A1', name: 'B1', spec: 'C1' },
}
const headers = ['级别', '子件行号', '子件编码', '子件名称', '基本用量']
test('date boundaries use Beijing and reject invalid calendar dates', () => {
  assert.equal(today(new Date('2026-09-13T16:00:00Z')), '2026-09-14')
  assert.equal(dateValue('2026-10-15T00:00:00+08:00'), '2026-10-15')
  assert.throws(() => dateValue('2026-02-30'))
  assert.throws(() => dateValue('2026-10-15T00:00:00'))
})
test('completed > overdue > pending > risk; commitment day is not overdue', () => {
  assert.equal(itemStatus(item(), '2026-10-16'), 'pending_reply')
  assert.equal(
    itemStatus(item({ currentCommittedDate: '2026-10-17' }), '2026-10-17'),
    'risk',
  )
  assert.equal(
    itemStatus(item({ currentCommittedDate: '2026-10-17' }), '2026-10-18'),
    'overdue',
  )
  assert.equal(
    itemStatus(
      item({
        currentCommittedDate: '2026-10-17',
        actualCompleteDate: '2026-10-18',
      }),
      '2026-10-20',
    ),
    'completed',
  )
})
test('promise preserves first commitment and requires reason plus version', () => {
  const a = item()
  assert.equal(
    promiseChange(a, { committedDate: '2026-10-15', expectedVersion: 1 })
      ?.firstCommittedDate,
    '2026-10-15',
  )
  const b = item({
    firstCommittedDate: '2026-10-15',
    currentCommittedDate: '2026-10-15',
  })
  assert.throws(
    () => promiseChange(b, { committedDate: '2026-10-16', expectedVersion: 1 }),
    { code: 'PROMISE_REASON_REQUIRED' },
  )
  assert.throws(
    () =>
      promiseChange(b, {
        committedDate: '2026-10-16',
        reason: '供应延期',
        expectedVersion: 0,
      }),
    { code: 'VERSION_CONFLICT' },
  )
  assert.equal(
    promiseChange(b, {
      committedDate: '2026-10-16',
      reason: '供应延期',
      expectedVersion: 1,
    })?.firstCommittedDate,
    '2026-10-15',
  )
})
test('kit predicts independently, tracks missing replies, excludes completed and assembly', () => {
  const result = kitStatus(
    [
      item({ id: 'pending' }),
      item({ id: 'bottleneck', currentCommittedDate: '2026-10-18' }),
      item({
        id: 'assembly',
        trackingType: 'assembly',
        currentCommittedDate: '2026-11-01',
      }),
      item({
        id: 'done',
        actualCompleteDate: '2026-10-14',
        currentCommittedDate: '2026-12-01',
      }),
      item({
        id: 'kit',
        trackingType: 'kit',
        currentCommittedDate: '2026-10-17',
      }),
    ],
    '2026-10-15',
    '2026-10-17',
    '2026-10-14',
  )
  assert.equal(result.predictionComplete, false)
  assert.equal(result.predictedKitDate, '2026-10-18')
  assert.equal(result.bottleneck?.id, 'bottleneck')
  assert.ok(result.alerts.some((a) => a.code === 'DETAIL_VS_COMMIT_CONFLICT'))
})
test('BOM builds arbitrary depth, trims NBSP and preserves engineering codes and leading zeroes', () => {
  const p = parseBom(
    [
      headers,
      ...Array.from({ length: 7 }, (_, i) => [
        '\u00a0' + '+'.repeat(i + 1),
        10,
        i === 0 ? '00123' : i === 1 ? '87830900057E-48' : `M${i}`,
        '物料',
        1,
      ]),
    ],
    'test',
    template,
  )
  assert.equal(p.summary.errors, 0)
  assert.equal(p.summary.maxLevel, 7)
  assert.equal(p.previewRows[0]?.materialCode, '00123')
  assert.equal(p.previewRows[1]?.materialCode, '87830900057E-48')
  assert.equal(p.previewRows[6]?.parentId, p.previewRows[5]?.id)
})
test('hierarchy jumps and invalid quantity stop import', () => {
  const p = parseBom(
    [headers, ['+', 10, 'A', '物料', 1], ['+++', 20, 'B', '物料', 'bad']],
    'test',
    template,
  )
  assert.ok(p.validation.some((v) => v.code === 'INVALID_LEVEL_SEQUENCE'))
  const q = parseBom([headers, ['+', 10, 'A', '物料', -1]], 'test', template)
  assert.ok(q.summary.errors > 0)
})
test('BOM float noise normalizes, real rounding is warned, raw data retained', () => {
  const p = parseBom(
    [
      headers,
      ['+', 10, 'A', '物料', 6.3750999999999998],
      ['+', 20, 'B', '物料', 0.1234567],
    ],
    'test',
    template,
  )
  assert.equal(p.previewRows[0]?.qty, '6.3751')
  assert.equal(p.previewRows[1]?.qty, '0.123457')
  assert.ok(p.validation.some((v) => v.code === 'QTY_ROUNDED'))
  assert.equal(p.previewRows[1].rawData['5:基本用量'], 0.1234567)
})
test('BOM diff respects position and reports added/removed/quantity', () => {
  const a = parseBom(
    [headers, ['+', 10, 'A', 'A', 1], ['+', 20, 'B', 'B', 1]],
    'test',
    template,
  )
  const b = parseBom(
    [headers, ['+', 10, 'A', 'A', 2], ['+', 20, 'C', 'C', 1]],
    'test',
    template,
  )
  assert.deepEqual(
    bomDiff(a.previewRows, b.previewRows)
      .map((r) => r.type)
      .sort(),
    ['ADDED', 'QTY_CHANGED', 'REMOVED'],
  )
})
export async function fixtureWorkbook() {
  const w = new ExcelJS.Workbook()
  const s = w.addWorksheet(defaultTemplate.sheetName)
  s.getCell('A4').value = 'SYNTHETIC-MOTOR'
  s.getCell('B4').value = '测试电机'
  s.getCell('C4').value = 'NPI测试'
  s.getRow(5).values = [
    '级别',
    '子件行号',
    '工序行号',
    '工序名称',
    '子件编码',
    '子件名称',
    '子件规格',
    '子件计量单位',
    '基本用量',
    '供应类型',
    '仓库名称',
    '领料部门名称',
  ]
  s.getRow(6).values = [
    '+',
    10,
    '0000',
    null,
    '00123',
    '机壳',
    '测试规格',
    '只',
    1,
    '领用',
    '半成品库',
    '金工',
  ]
  s.getRow(7).values = [
    '++',
    10,
    '0000',
    null,
    'M00123',
    '毛坯',
    '测试规格',
    '只',
    1,
    '领用',
    '原材料库',
    '金工',
  ]
  return Buffer.from(await w.xlsx.writeBuffer())
}
test('real XLSX parser identifies template and preserves source codes', async () => {
  const p = await previewExcel(await fixtureWorkbook(), [defaultTemplate])
  assert.equal(p.summary.errors, 0)
  assert.equal(p.summary.rows, 2)
  assert.equal(p.previewRows[0]?.materialCode, '00123')
  assert.throws(() => validateWorkbookArchive(new Uint8Array(30)), {
    code: 'INVALID_BOM_FORMAT',
  })
})
for (const [name, rows, roots] of [
  ['161F1246BM0001.xlsx', 47, 16],
  ['161H1866BM0001-M12x30.xlsx', 56, 23],
] as const)
  test(
    `ERP sample: ${name}`,
    { skip: !process.env.NPI_SAMPLE_DIR },
    async () => {
      const result = await previewExcel(
        fs.readFileSync(`${process.env.NPI_SAMPLE_DIR}/${name}`),
        [defaultTemplate],
      )
      assert.equal(result.summary.errors, 0)
      assert.equal(result.summary.rows, rows)
      assert.equal(result.summary.level1Count, roots)
      assert.equal(result.summary.maxLevel, 4)
      const map = new Map(result.previewRows.map((r) => [r.id, r]))
      for (const r of result.previewRows) {
        if (r.level === 1) assert.equal(r.parentId, null)
        else assert.equal(map.get(r.parentId!)?.level, r.level - 1)
      }
    },
  )
test('BOM moves retain one identity and expose quantity changes as well', () => {
  const a = parseBom(
    [
      headers,
      ['+', 10, 'A', 'A', 1],
      ['++', 10, 'X', 'X', 1],
      ['+', 20, 'B', 'B', 1],
    ],
    'test',
    template,
  )
  const b = parseBom(
    [
      headers,
      ['+', 10, 'A', 'A', 1],
      ['+', 20, 'B', 'B', 1],
      ['++', 30, 'X', 'X', 2],
    ],
    'test',
    template,
  )
  const diff = bomDiff(a.previewRows, b.previewRows)
  assert.equal(diff.length, 3)
  const moved = diff.find((r) => r.type === 'MOVED')!
  assert.equal(moved.before?.materialCode, 'X')
  assert.equal(moved.after?.materialCode, 'X')
  assert.equal(moved.quantityChanged, true)
  assert.equal(moved.beforePath, 'A [10] / X [10]')
  assert.equal(moved.afterPath, 'B [20] / X [30]')
})
test('BOM matching uses whole ancestry even when repeated subassemblies reorder', () => {
  const a = parseBom(
    [
      headers,
      ['+', 10, 'ROOT-A', 'A', 1],
      ['++', 10, 'SUB', 'S', 1],
      ['+++', 10, 'X', 'X', 2],
      ['+', 20, 'ROOT-B', 'B', 1],
      ['++', 10, 'SUB', 'S', 1],
      ['+++', 10, 'X', 'X', 3],
    ],
    'test',
    template,
  )
  const b = parseBom(
    [
      headers,
      ['+', 20, 'ROOT-B', 'B', 1],
      ['++', 10, 'SUB', 'S', 1],
      ['+++', 10, 'X', 'X', 3],
      ['+', 10, 'ROOT-A', 'A', 1],
      ['++', 10, 'SUB', 'S', 1],
      ['+++', 10, 'X', 'X', 2],
    ],
    'test',
    template,
  )
  assert.ok(
    bomDiff(a.previewRows, b.previewRows).every((d) => d.type === 'UNCHANGED'),
  )
})
test('Ambiguous duplicate BOM positions are never paired by row order', () => {
  const a = parseBom(
    [headers, ['+', 10, 'A', 'A', 1], ['+', 10, 'A', 'A', 2]],
    'test',
    template,
  )
  const b = parseBom(
    [headers, ['+', 10, 'A', 'A', 2], ['+', 10, 'A', 'A', 1]],
    'test',
    template,
  )
  assert.deepEqual(
    bomDiff(a.previewRows, b.previewRows)
      .map((r) => r.type)
      .sort(),
    ['ADDED', 'ADDED', 'REMOVED', 'REMOVED'],
  )
})
test('Stopped tracking no longer creates pending or risk counts', () => {
  const result = kitStatus(
    [
      item({ trackingEnabled: false, affectsKit: false }),
      item({ id: 'live', currentCommittedDate: '2026-10-14' }),
    ],
    '2026-10-15',
    null,
    '2026-10-13',
  )
  assert.equal(result.pendingReplyCount, 0)
  assert.equal(result.predictedKitDate, '2026-10-14')
  assert.equal(result.counts.normal, 1)
})

test('Today activity uses Shanghai midnight, counts changes rather than first replies, and includes late completion confirmations', () => {
  const day = '2026-09-14',
    { start, end, previous } = businessDayRange(day)
  assert.equal(start.toISOString(), '2026-09-13T16:00:00.000Z')
  assert.equal(end.toISOString(), '2026-09-14T16:00:00.000Z')
  assert.equal(previous, '2026-09-13')
  const history = [
    {
      id: 'first',
      objectId: 'item',
      oldCommittedDate: null,
      newCommittedDate: '2026-09-18',
      changedAt: '2026-09-13T16:00:00Z',
      actorName: '采购A',
      reason: '首次',
    },
    {
      id: 'changed',
      objectId: 'item',
      oldCommittedDate: '2026-09-18',
      newCommittedDate: '2026-09-19',
      changedAt: '2026-09-14T15:59:59Z',
      actorName: '采购A',
      reason: '运输变更',
    },
    {
      id: 'tomorrow',
      objectId: 'item',
      oldCommittedDate: '2026-09-19',
      newCommittedDate: '2026-09-20',
      changedAt: '2026-09-14T16:00:00Z',
      actorName: '采购A',
      reason: '次日变更',
    },
  ]
  const project = {
    id: 'p',
    name: '新品',
    code: 'P1',
    currentNpiStage: 'manufacturing',
    history,
    items: [
      {
        ...item({
          actualCompleteDate: '2026-09-01',
          currentCommittedDate: '2026-09-19',
        }),
        createdAt: '2026-09-01T00:00:00Z',
      },
    ],
  }
  const result = todayActivity(
    [project],
    [
      {
        id: 'completion',
        programId: 'p',
        objectId: 'item',
        action: 'COMPLETED',
        detail: { actualCompleteDate: '2026-09-01' },
        createdAt: start,
        actorName: '制造A',
      },
      {
        id: 'correction',
        programId: 'p',
        objectId: 'item',
        action: 'COMPLETION_CORRECTED',
        detail: { after: { actualCompleteDate: day } },
        createdAt: start,
        actorName: '技术A',
      },
      {
        id: 'hidden',
        programId: 'other',
        objectId: 'item',
        action: 'COMPLETED',
        detail: { actualCompleteDate: day },
        createdAt: start,
        actorName: '其他人',
      },
    ],
    day,
  )
  assert.deepEqual(
    result.promiseChanges.map((r) => r.id),
    ['changed'],
  )
  assert.equal(result.completions.length, 1)
  assert.equal(result.completions[0]!.actualDate, '2026-09-01')
  assert.deepEqual(result.newOverdue, [])
  assert.equal(
    promiseChangeCounts([
      ...history,
      { objectId: 'item', oldCommittedDate: day, newCommittedDate: day },
    ]).get('item'),
    2,
  )
})
test('Newly overdue compares with yesterday and reconstructs the opening commitment through same-day changes', () => {
  const create = (
    id: string,
    date: string,
    overrides: Partial<DatedItem> = {},
  ) => ({
    ...item({ id, currentCommittedDate: date, ...overrides }),
    createdAt: '2026-09-01T00:00:00Z',
  })
  const history = [
    {
      id: 'a',
      objectId: 'new-past',
      oldCommittedDate: '2026-09-20',
      newCommittedDate: '2026-09-10',
      changedAt: '2026-09-14T00:00:00Z',
      actorName: '采购',
      reason: '核实日期',
    },
    {
      id: 'b',
      objectId: 'new-past',
      oldCommittedDate: '2026-09-10',
      newCommittedDate: '2026-09-11',
      changedAt: '2026-09-14T01:00:00Z',
      actorName: '采购',
      reason: '再次核实',
    },
    {
      id: 'c',
      objectId: 'still-past',
      oldCommittedDate: '2026-09-10',
      newCommittedDate: '2026-09-13',
      changedAt: '2026-09-14T00:00:00Z',
      actorName: '采购',
      reason: '顺延但仍逾期',
    },
    {
      id: 'd',
      objectId: 'late-first',
      oldCommittedDate: null,
      newCommittedDate: '2026-09-09',
      changedAt: '2026-09-14T00:00:00Z',
      actorName: '采购',
      reason: '首次迟到回复',
    },
  ]
  const p = {
    id: 'p',
    name: '新品',
    code: 'P1',
    currentNpiStage: 'manufacturing',
    history,
    items: [
      create('clock', '2026-09-13'),
      create('old', '2026-09-12'),
      create('new-past', '2026-09-11'),
      create('still-past', '2026-09-13'),
      create('late-first', '2026-09-09'),
      create('complete', '2026-09-13', { actualCompleteDate: '2026-09-14' }),
      create('stopped', '2026-09-13', {
        trackingEnabled: false,
        affectsKit: false,
      }),
      create('re-enabled', '2026-09-01'),
    ],
  }
  const events = [
    {
      id: 'reactivate',
      programId: 'p',
      objectId: 're-enabled',
      action: 'TRACKING_CHANGED',
      createdAt: '2026-09-14T00:00:00Z',
      actorName: '技术',
      detail: {
        before: { trackingEnabled: false, affectsKit: false },
        after: { trackingEnabled: true, affectsKit: true },
      },
    },
  ]
  const result = todayActivity([p], events, '2026-09-14')
  assert.deepEqual(result.newOverdue.map((r) => r.itemId).sort(), [
    'clock',
    'late-first',
    'new-past',
    're-enabled',
  ])
  assert.equal(result.promiseChanges.length, 3)
  assert.deepEqual(
    todayActivity(
      [{ ...p, currentNpiStage: 'completed' }],
      events,
      '2026-09-14',
    ).newOverdue,
    [],
  )
})

test('Dashboard KPI drilldowns share scope and membership, including overlapping risk and pending states', () => {
  const base = {
    id: 'normal',
    name: '正常',
    code: 'A',
    motorModel: 'X160',
    manufacturingOwnerId: 'm1',
    currentNpiStage: 'design',
    riskStatus: 'normal',
    prototypeRequiredDate: '2026-09-20',
    kit: {
      pendingReplyCount: 0,
      riskCount: 0,
      alerts: [] as Array<{ code: string }>,
    },
    items: [] as Array<{
      trackingType: string
      actualCompleteDate: string | null
    }>,
  }
  const projects = [
    base,
    {
      ...base,
      id: 'pending',
      riskStatus: 'pending_reply',
      kit: {
        ...base.kit,
        pendingReplyCount: 1,
        alerts: [{ code: 'PENDING_REPLY' }],
      },
    },
    {
      ...base,
      id: 'overdue',
      riskStatus: 'overdue',
      kit: { pendingReplyCount: 1, riskCount: 1, alerts: [] },
    },
    {
      ...base,
      id: 'conflict',
      riskStatus: 'risk',
      kit: { ...base.kit, alerts: [{ code: 'DETAIL_VS_COMMIT_CONFLICT' }] },
    },
    {
      ...base,
      id: 'on-time',
      currentNpiStage: 'completed',
      riskStatus: 'completed',
      items: [{ trackingType: 'assembly', actualCompleteDate: '2026-09-20' }],
    },
    {
      ...base,
      id: 'late',
      currentNpiStage: 'completed',
      riskStatus: 'completed',
      items: [{ trackingType: 'assembly', actualCompleteDate: '2026-09-21' }],
    },
    {
      ...base,
      id: 'unknown',
      currentNpiStage: 'completed',
      riskStatus: 'completed',
      items: [{ trackingType: 'assembly', actualCompleteDate: null }],
    },
    {
      ...base,
      id: 'other-month',
      manufacturingOwnerId: 'm2',
      prototypeRequiredDate: '2026-10-01',
    },
  ]
  assert.deepEqual(dashboardMetrics(projects, '2026-09-14'), {
    active: 5,
    pending: 2,
    risk: 2,
    overdue: 1,
    month: 7,
    completed: 3,
    onTime: 1,
    onTimeRate: 33,
  })
  assert.deepEqual(
    projects
      .filter((p) => projectMatchesFilter(p, 'pending_reply', '2026-09-14'))
      .map((p) => p.id),
    ['pending', 'overdue'],
  )
  assert.deepEqual(
    projects
      .filter((p) => projectMatchesFilter(p, 'risk', '2026-09-14'))
      .map((p) => p.id),
    ['overdue', 'conflict'],
  )
  const own = scopeDashboardProjects(projects, 'manufacturing', {
    id: 'm1',
    role: 'manufacturing',
  })
  assert.equal(dashboardMetrics(own, '2026-09-14').active, 4)
  assert.ok(!own.some((p) => p.id === 'other-month'))
  assert.equal(
    scopeDashboardProjects(projects, 'manufacturing', {
      id: 'admin',
      role: 'admin',
    }).length,
    8,
  )
  assert.equal(
    scopeDashboardProjects(projects, 'review', {
      id: 'm1',
      role: 'manufacturing',
    }).length,
    8,
  )
  assert.equal(dashboardMetrics([], '2026-09-14').onTimeRate, null)
})
test('Dashboard exception selection sorts severity, supports trimmed model/code search and completed/month drilldowns', () => {
  const base = {
    id: 'n',
    name: '正常机型',
    code: 'NPI-A',
    motorModel: 'X160',
    manufacturingOwnerId: 'm',
    currentNpiStage: 'design',
    riskStatus: 'normal',
    prototypeRequiredDate: '2026-09-20',
    kit: { pendingReplyCount: 0, riskCount: 0, alerts: [] },
    items: [],
  }
  const projects = [
    base,
    {
      ...base,
      id: 'p',
      riskStatus: 'pending_reply',
      kit: { ...base.kit, pendingReplyCount: 1 },
    },
    { ...base, id: 'r', riskStatus: 'risk' },
    { ...base, id: 'o', riskStatus: 'overdue' },
    { ...base, id: 'c', riskStatus: 'completed', currentNpiStage: 'completed' },
  ]
  const options = {
    filter: 'all' as const,
    day: '2026-09-14',
    search: '',
    exceptionsOnly: true,
  }
  assert.deepEqual(
    selectDashboardProjects(projects, options).map((p) => p.id),
    ['o', 'r', 'p'],
  )
  assert.deepEqual(
    selectDashboardProjects(projects, {
      ...options,
      search: '  x160 ',
      exceptionsOnly: false,
    }).map((p) => p.id),
    ['o', 'r', 'p', 'n'],
  )
  assert.equal(
    selectDashboardProjects(projects, { ...options, search: 'npi-a' }).length,
    3,
  )
  assert.equal(
    selectDashboardProjects(projects, { ...options, search: '不存在' }).length,
    0,
  )
  assert.deepEqual(
    selectDashboardProjects(projects, {
      ...options,
      filter: 'completed',
      exceptionsOnly: false,
    }).map((p) => p.id),
    ['c'],
  )
  assert.equal(
    selectDashboardProjects(projects, {
      ...options,
      filter: 'month',
      exceptionsOnly: false,
    }).length,
    5,
  )
  assert.equal(
    projects[0]!.id,
    'n',
    'Selection must not reorder the source snapshot',
  )
})

test('Optional project profile normalizes numeric values, distinguishes clear/omit, and preserves unrelated native attributes', () => {
  const program = {
    customer: '原客户',
    description: '项目说明',
    attributes: {
      npi: true,
      external: { keep: 1 },
      npiMotorSpec: {
        application: '风机',
        ratedPowerKw: '7.5',
        ratedVoltageV: '380',
        poles: '8',
        insulationClass: 'F',
      },
    },
  }
  const original = JSON.stringify(program)
  const result = prepareProjectProfile(program, {
    ratedPowerKw: '0011.000000',
    customer: null,
    application: '  压缩机  ',
    description: '',
  })
  assert.equal(result.next.ratedPowerKw, '11')
  assert.equal(result.next.customer, '')
  assert.equal(result.next.poles, '8')
  assert.deepEqual(result.patch.attributes, {
    npi: true,
    external: { keep: 1 },
    npiMotorSpec: {
      application: '压缩机',
      ratedPowerKw: '11',
      ratedVoltageV: '380',
      poles: '8',
      insulationClass: 'F',
    },
  })
  assert.equal(result.patch.customer, null)
  assert.equal(result.patch.description, null)
  assert.equal(JSON.stringify(program), original)
  assert.deepEqual(prepareProjectProfile(program, { name: '仅改名' }).patch, {})
  assert.equal(
    prepareProjectProfile(program, { ratedPowerKw: '7.500' }).changes.length,
    0,
  )
  assert.deepEqual(readProjectProfile(), {
    customer: '',
    description: '',
    application: '',
    ratedPowerKw: '',
    ratedVoltageV: '',
    poles: '',
  })
  assert.deepEqual(
    prepareProjectProfile(program, { ratedVoltageV: null }).patch.attributes,
    {
      ...program.attributes,
      npiMotorSpec: { ...program.attributes.npiMotorSpec, ratedVoltageV: null },
    },
  )
})
test('Project profile rejects invalid engineering input and malformed namespaces without erasing data', () => {
  const empty = { customer: null, description: null, attributes: {} }
  for (const value of [
    '0',
    '-2',
    '1e3',
    '3 kW',
    'NaN',
    'Infinity',
    '1.0000001',
    true,
    {},
    [],
  ])
    assert.throws(() => prepareProjectProfile(empty, { ratedPowerKw: value }))
  for (const value of ['0', '-1', '8.2', '1000000', false])
    assert.throws(() => prepareProjectProfile(empty, { poles: value }))
  assert.equal(
    prepareProjectProfile(empty, { ratedVoltageV: 380, poles: 8 }).next.poles,
    '8',
  )
  assert.equal(
    prepareProjectProfile(empty, { ratedPowerKw: '0.000001' }).next
      .ratedPowerKw,
    '0.000001',
  )
  assert.throws(() =>
    prepareProjectProfile(empty, { customer: 'x'.repeat(201) }),
  )
  assert.throws(() =>
    prepareProjectProfile(empty, { description: 'x'.repeat(4001) }),
  )
  assert.throws(() =>
    prepareProjectProfile(
      { ...empty, attributes: { npiMotorSpec: 'conflicting external value' } },
      { application: '风机' },
    ),
  )
  assert.deepEqual(
    prepareProjectProfile(
      { ...empty, attributes: { npiMotorSpec: 'conflicting external value' } },
      { customer: '客户' },
    ).patch,
    { customer: '客户' },
  )
})

test('Mother confirmation preserves source rows, keeps other errors, and restores only for unchanged mapping and raw mother', () => {
  const raw = parseBom([headers, ['+', 10, 'A', '物料', 1]], 'test', template)
  raw.mother = { code: '', name: '', spec: '' }
  raw.validation.push({
    rowNo: 0,
    severity: 'ERROR',
    code: 'MOTHER_REQUIRED',
    message: 'missing',
  })
  raw.summary.errors++
  assert.ok(raw.templateSnapshot)
  const before = structuredClone(raw)
  const input = {
    code: ' NEW ',
    name: '电机',
    spec: '',
    reason: '原表未提供',
    confirmedBy: 'forged',
  }
  const actor = { id: 'server-actor', name: '技术负责人' }
  const fixed = confirmMother(raw, input, actor)
  assert.deepEqual(raw, before)
  assert.deepEqual(fixed.previewRows, raw.previewRows)
  assert.equal(fixed.mother.code, 'NEW')
  assert.equal(fixed.summary.errors, 0)
  assert.ok(fixed.motherConfirmation)
  assert.equal(fixed.motherConfirmation.confirmedBy, actor.id)
  assert.deepEqual(fixed.motherConfirmation.original, raw.mother)
  assert.deepEqual(restoreConfirmedMother(raw, fixed), fixed)
  assert.equal(
    restoreConfirmedMother(
      { ...raw, mother: { ...raw.mother, code: 'ERP' } },
      fixed,
    ).motherConfirmation,
    undefined,
  )
  assert.equal(
    restoreConfirmedMother(
      {
        ...raw,
        templateSnapshot: { ...raw.templateSnapshot, name: 'changed' },
      },
      fixed,
    ).motherConfirmation,
    undefined,
  )
  for (const invalid of [
    null,
    [],
    'bad',
    { ...input, code: '' },
    { ...input, name: '' },
    { ...input, reason: '' },
  ])
    assert.throws(() => confirmMother(raw, invalid, actor), { status: 422 })
  raw.validation.push({
    rowNo: 2,
    severity: 'ERROR',
    code: 'INVALID_QTY',
    message: 'bad quantity',
  })
  assert.equal(confirmMother(raw, input, actor).summary.errors, 1)
})

test('BOM quantities keep 18-digit decimals exact, round half up, bound exponents and distinguish float noise from text', () => {
  for (const [raw, value, rounded] of [
    ['999999999999.123456', '999999999999.123456', false],
    ['+000000001.5000000', '1.5', false],
    ['999999999999.9999994', '999999999999.999999', true],
    ['1.2345675', '1.234568', true],
    ['0.0000005', '0.000001', true],
    ['1e-6', '0.000001', false],
    ['9.99999999999123456e11', '999999999999.123456', false],
    ['0.30000000000000004', '0.3', true],
  ] as const)
    assert.deepEqual(normalizeBomQuantity(raw), { value, rounded })
  assert.deepEqual(normalizeBomQuantity('0.30000000000000004', true), {
    value: '0.3',
    rounded: false,
  })
  for (const raw of [
    '0',
    '-1',
    'NaN',
    'Infinity',
    '1,000',
    '1e1000000000',
    '1e-1000000000',
    '999999999999.9999995',
    '1000000000000',
    '0.0000004',
    '',
  ])
    assert.throws(() => normalizeBomQuantity(raw), {
      code: 'INVALID_BOM_FORMAT',
    })
})
test('BOM comparison detects one-millionth changes in large decimal quantities and ignores equivalent notation', () => {
  const before = parseBom(
    [headers, ['+', 10, 'EXACT', '精密用量', '999999999999.123456']],
    'test',
    template,
  )
  const after = parseBom(
    [headers, ['+', 10, 'EXACT', '精密用量', '999999999999.123457']],
    'test',
    template,
  )
  assert.equal(before.summary.errors, 0)
  assert.equal(before.previewRows[0]?.qty, '999999999999.123456')
  assert.equal(after.previewRows[0]?.qty, '999999999999.123457')
  assert.equal(
    bomDiff(before.previewRows, after.previewRows)[0]?.type,
    'QTY_CHANGED',
  )
  const equal = before.previewRows.map((r) => ({
    ...r,
    qty: '0999999999999.1234560',
  }))
  assert.equal(bomDiff(before.previewRows, equal)[0]?.type, 'UNCHANGED')
})

test('SRS43 suggestions use explicit properties, precedence and levels without guessing from purchase or stock names', () => {
  const cases: Array<[number, string, boolean]> = [
    [1, '核心自制加工件', true],
    [2, '核心自制加工件', false],
    [1, '新规格外购件', true],
    [2, '新规格外购件', false],
    [4, '长周期采购件', true],
    [3, '客户指定件', true],
    [2, '原材料', false],
    [1, '普通标准件', false],
    [1, '常备库存件、新规格外购件', false],
    [1, '普通倒冲件、核心加工件', false],
    [3, '普通标准件、关键件', true],
    [2, '原材料；客户指定件', true],
    [2, '常备库存件,采购长周期件', true],
    [1, '', false],
    [1, '非关键件', false],
    [1, '__proto__', false],
  ]
  for (const [level, raw, expected] of cases)
    assert.equal(
      suggestBomTracking(level, raw).reasons.length > 0,
      expected,
      `${level}:${raw}`,
    )
  assert.deepEqual(suggestBomTracking(2, '客户指定件、客户指定件').properties, [
    '客户指定件',
  ])
  assert.deepEqual(suggestBomTracking(1, '普通件,待核对').unknown, [
    '普通件',
    '待核对',
  ])
})

test('BOM parser keeps raw tracking attributes and warns on unknown, missing or ambiguous mapped columns', () => {
  const config = {
    ...template,
    fieldMapping: { ...template.fieldMapping, trackingProperties: '跟踪属性' },
  }
  const rows = [
    [...headers, '跟踪属性', '供应类型', '仓库名称'],
    ['+', 10, 'A', '标准件', 1, '普通标准件', '采购', '采购库'],
    ['++', 20, 'B', '客户零件', 1, '客户指定件；待核对', '采购', '原材料库'],
    ['+', 30, 'C', '未知规格', 1, '', '采购', '采购库'],
  ]
  const before = structuredClone(rows)
  const preview = parseBom(rows, 'test', config)
  assert.equal(preview.summary.errors, 0)
  assert.deepEqual(
    preview.previewRows.map((row) => row.suggestedTracking),
    [false, true, false],
  )
  assert.deepEqual(preview.previewRows[1]!.trackingSuggestion?.properties, [
    '客户指定件',
  ])
  assert.equal(
    preview.previewRows[1]!.rawData['6:跟踪属性'],
    '客户指定件；待核对',
  )
  assert.ok(
    preview.validation.some(
      (v) => v.code === 'UNKNOWN_TRACKING_PROPERTY' && v.rowNo === 3,
    ),
  )
  assert.deepEqual(rows, before)
  const missing = parseBom(rows, 'test', {
    ...config,
    fieldMapping: { ...config.fieldMapping, trackingProperties: '无此列' },
  })
  assert.ok(
    missing.validation.some(
      (v) => v.code === 'TRACKING_PROPERTIES_UNAVAILABLE',
    ),
  )
  assert.ok(missing.previewRows.every((row) => !row.suggestedTracking))
  rows[0]!.push('跟踪属性')
  rows[1]!.push('关键件')
  const duplicate = parseBom(rows, 'test', config)
  assert.ok(
    duplicate.validation.some(
      (v) => v.code === 'TRACKING_PROPERTIES_UNAVAILABLE',
    ),
  )
  assert.ok(duplicate.previewRows.every((row) => !row.suggestedTracking))
})
