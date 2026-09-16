// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { buildKitWorkbook } from '../packages/core/src/components/npi/kit-export.ts'

const project = {
  code: 'P-001',
  name: '样机导出验证',
  requiredKitDate: '2026-10-15',
  kit: {
    manufacturingCommittedKitDate: '2026-10-17',
    predictedKitDate: '2026-10-18',
    pendingReplyCount: 1,
    predictionComplete: false,
    alerts: [{ code: 'PENDING_REPLY', message: '仍有关键项待回复' }],
    bottleneck: { id: 'material' },
  },
}
const item = {
  id: 'material',
  sourceType: 'ERP_BOM',
  trackingType: 'material',
  name: '=HYPERLINK("https://example.invalid","text")',
  specification: '特殊规格',
  qty: '9007199254740993.123456789012345678',
  unit: '件',
  ownerName: '制造负责人',
  requiredDate: '2026-10-15',
  firstCommittedDate: '2026-10-16',
  currentCommittedDate: '2026-10-18',
  actualCompleteDate: null,
  status: 'risk',
  trackingEnabled: true,
  affectsKit: true,
  changeCount: 2,
  supplier: '供应商',
  remark: '+原样备注',
  bomReference: {
    materialCode: '001234',
    versionNo: 2,
    rowNo: 9,
    current: true,
  },
}
await test('Workbook roundtrip preserves exact identifiers/quantities and literal user text, with traceable scope and dates', async () => {
  const source = await buildKitWorkbook({
    project,
    items: [item],
    scope: '异常物料 / ERP BOM / 风险',
    exportedAt: new Date('2026-09-15T04:00:00Z'),
  })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await source.xlsx.writeBuffer())
  const sheet = workbook.getWorksheet('齐套物料')
  assert.equal(sheet.rowCount, 6)
  assert.match(sheet.getCell('A1').value, /P-001.*样机导出验证/)
  assert.match(sheet.getCell('A2').value, /异常物料.*ERP BOM.*风险.*1项/)
  assert.match(
    sheet.getCell('A3').value,
    /2026-10-15.*2026-10-17.*2026-10-18.*预测不完整.*关键项待回复/,
  )
  assert.equal(sheet.getCell('B6').value, '001234')
  assert.equal(sheet.getCell('B6').type, ExcelJS.ValueType.String)
  assert.equal(sheet.getCell('J6').value, item.qty)
  assert.equal(sheet.getCell('J6').type, ExcelJS.ValueType.String)
  assert.equal(sheet.getCell('C6').value, item.name)
  assert.equal(sheet.getCell('C6').type, ExcelJS.ValueType.String)
  assert.equal(sheet.getCell('V6').value, item.remark)
  assert.equal(sheet.getCell('N6').value, '2026-10-16')
  assert.equal(sheet.getCell('O6').value, '2026-10-18')
  assert.ok(!sheet.getCell('P6').value)
  assert.equal(sheet.getCell('Q6').value, '风险')
  assert.equal(sheet.getCell('G6').value, 'V2')
  assert.equal(sheet.getCell('H6').value, 9)
  assert.equal(sheet.getCell('T6').value, 2)
  assert.equal(sheet.views[0].ySplit, 5)
  assert.equal(sheet.autoFilter, 'A5:W6')
  assert.equal(sheet.getCell('W6').value, '已知瓶颈（预测不完整）')
})
await test('All supplied filtered rows export in order, with external category and completed state retained', async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({
    ...item,
    id: String(i),
    name: '物料' + i,
    sourceType: 'EXTERNAL',
    trackingType: 'other',
    bomReference: null,
    status: 'completed',
    actualCompleteDate: '2026-09-15',
  }))
  const workbook = await buildKitWorkbook({
    project,
    items: rows,
    scope: '其他BOM外物料',
  })
  const sheet = workbook.getWorksheet('齐套物料')
  assert.equal(sheet.rowCount, 56)
  assert.equal(sheet.getCell('C56').value, '物料50')
  assert.equal(sheet.getCell('E6').value, 'BOM外物料')
  assert.equal(sheet.getCell('F6').value, '其他物料')
  assert.equal(sheet.getCell('P6').value, '2026-09-15')
  assert.equal(sheet.getCell('Q6').value, '已完成')
})

await test('BOM review-only incompleteness is explained without falsely requesting replies', async () => {
  const workbook = await buildKitWorkbook({
    project: {
      ...project,
      kit: {
        ...project.kit,
        pendingReplyCount: 0,
        alerts: [{ code: 'BOM_REVIEW_PENDING', message: '旧跟踪待复核' }],
      },
    },
    items: [item],
    scope: '全部跟踪',
  })
  const summary = workbook.getWorksheet('齐套物料').getCell('A3').value
  assert.match(summary, /预测不完整.*BOM换版待复核/)
  assert.doesNotMatch(summary, /关键项待回复|回复未完整/)
})
