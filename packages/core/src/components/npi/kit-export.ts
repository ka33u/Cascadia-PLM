// SPDX-License-Identifier: AGPL-3.0-or-later
import { bottleneckLabel } from './NpiBottleneck'
import { predictionNote } from './prediction-note'
import type { NpiTracking, ProjectDetail } from '../../lib/npi/service'

const statusNames: Record<string, string> = {
  pending_reply: '待回复',
  normal: '正常',
  risk: '风险',
  overdue: '逾期',
  completed: '已完成',
}
const typeNames: Record<string, string> = {
  purchase: '采购件',
  material: '物料 / 临时样机件',
  other: '其他物料',
}
const headers = [
  '序号',
  '物料编码',
  '物料名称',
  '规格',
  '来源',
  '类型',
  'BOM版本',
  'BOM行号',
  '当前BOM',
  '数量',
  '单位',
  '回复责任人',
  '要求日期',
  '首次承诺',
  '当前承诺',
  '实际完成',
  '状态',
  '重点跟踪',
  '影响齐套',
  '承诺修改次数',
  '供应商',
  '备注',
  '齐套瓶颈',
]
export type KitExportInput = {
  project: ProjectDetail
  items: Array<NpiTracking>
  scope: string
  exportedAt?: Date
}
export async function buildKitWorkbook({
  project,
  items,
  scope,
  exportedAt = new Date(),
}: KitExportInput) {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Cascadia NPI'
  workbook.created = exportedAt
  const sheet = workbook.addWorksheet('齐套物料', {
    views: [{ state: 'frozen', ySplit: 5 }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '1:5',
    },
  })
  const summary = [
    `${project.code || ''} ${project.name} · 样机齐套物料`,
    `范围：${scope} · ${items.length}项 · 导出时间：${exportedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）`,
    `要求齐套：${project.requiredKitDate} · 制造承诺：${project.kit.manufacturingCommittedKitDate || '待回复'} · 系统预测：${project.kit.predictedKitDate || (project.kit.allRelevantCompleted ? '已齐备' : '暂无')}${predictionNote(project.kit) ? `（${predictionNote(project.kit)}）` : ''}`,
    '清单为当前筛选的物料跟踪记录；已满足／缺料按实际完成记录计项，不代表库存数量。',
  ]
  summary.forEach((text, i) => {
    sheet.addRow([text])
    sheet.mergeCells(i + 1, 1, i + 1, headers.length)
  })
  sheet.addRow(headers)
  const widths = [
    8, 20, 26, 30, 15, 22, 12, 12, 12, 24, 10, 16, 14, 14, 14, 14, 12, 12, 12,
    16, 24, 36, 24,
  ]
  sheet.columns.forEach((col, i) => {
    col.width = widths[i] || 16
  })
  sheet.getRow(1).font = {
    name: '等线',
    size: 16,
    bold: true,
    color: { argb: 'FF17365D' },
  }
  sheet.getRow(1).height = 32
  for (let row = 2; row <= 4; row++) {
    sheet.getRow(row).height = 26
    sheet.getRow(row).alignment = { wrapText: true, vertical: 'middle' }
  }
  const heading = sheet.getRow(5)
  heading.height = 30
  heading.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF17365D' },
    }
    cell.font = { name: '等线', bold: true, color: { argb: 'FFFFFFFF' } }
    cell.alignment = { vertical: 'middle', wrapText: true }
  })
  items.forEach((item, i) => {
    const ref = item.bomReference
    // Codes, quantities and user text remain literal strings: no numeric rounding or formulas.
    const row = sheet.addRow([
      i + 1,
      ref?.materialCode || '',
      item.name,
      item.specification,
      item.sourceType === 'ERP_BOM' ? 'ERP BOM' : 'BOM外物料',
      typeNames[item.trackingType] || item.trackingType,
      ref ? `V${ref.versionNo}` : '',
      ref?.rowNo ?? '',
      ref ? (ref.current ? '是' : '历史版本') : '',
      item.qty,
      item.unit,
      item.ownerName || '',
      item.requiredDate,
      item.firstCommittedDate || '',
      item.currentCommittedDate || '',
      item.actualCompleteDate || '',
      statusNames[item.status] || item.status,
      item.trackingEnabled ? '是' : '否',
      item.affectsKit ? '是' : '否',
      item.changeCount || 0,
      item.supplier,
      item.remark,
      bottleneckLabel(project.kit, item.id) || '否',
    ])
    row.height = 34
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: '等线', size: 11 }
      cell.alignment = { vertical: 'middle', wrapText: true }
      if (i % 2 === 1)
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF3F6FA' },
        }
    })
    row.getCell(2).numFmt = '@'
    row.getCell(10).numFmt = '@'
    const color =
      item.status === 'overdue'
        ? 'FFFFD9D9'
        : item.status === 'risk'
          ? 'FFFFEDBF'
          : ['normal', 'completed'].includes(item.status)
            ? 'FFDDF1E2'
            : 'FFE5E7EB'
    row.getCell(17).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: color },
    }
  })
  sheet.autoFilter = {
    from: { row: 5, column: 1 },
    to: { row: 5 + items.length, column: headers.length },
  }
  return workbook
}
export async function downloadKitMaterials(input: KitExportInput) {
  const workbook = await buildKitWorkbook(input)
  const bytes = await workbook.xlsx.writeBuffer()
  const blob = new Blob([new Uint8Array(bytes)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const name = (input.project.code || input.project.name)
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
    .slice(0, 80)
  link.href = url
  link.download = `${name || '新品'}-齐套物料.xlsx`
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
