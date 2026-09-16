import ExcelJS from 'exceljs'
import { NpiError } from './domain'
import { parseBom } from './bom'
import { validateOfficeArchive } from './office-archive'
import type { Cell, ImportTemplate } from './bom'

export function validateWorkbookArchive(buffer: Uint8Array) {
  validateOfficeArchive(buffer, {
    mainPart: 'xl/workbook.xml',
    maxEntries: 400,
    maxExpandedBytes: 20 * 1024 * 1024,
  })
}
export async function previewExcel(
  buffer: Buffer,
  templates: Array<ImportTemplate>,
  templateId?: string,
) {
  validateWorkbookArchive(buffer)
  // parseNumber preserves identifiers and decimal precision before normalization.
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  )
  const sheets = workbook.worksheets.map((sheet) => {
    if (sheet.rowCount > 5005 || sheet.columnCount > 150)
      throw new NpiError('INVALID_BOM_FORMAT', '工作表超过5000行或150列', 400)
    const data: Array<Array<Cell>> = []
    for (let i = 1; i <= sheet.rowCount; i++) {
      const row: Array<Cell> = []
      for (let j = 1; j <= sheet.columnCount; j++) {
        const cell = sheet.getCell(i, j)
        const value = cell.value
        if (value == null) row.push(null)
        else if (value instanceof Date || typeof value !== 'object')
          row.push(value)
        else if ('richText' in value)
          row.push(value.richText.map((v) => v.text).join(''))
        else if ('formula' in value || 'sharedFormula' in value)
          throw new NpiError(
            'INVALID_BOM_FORMAT',
            '请导出数值版BOM，暂不接受公式单元格',
            400,
          )
        else row.push(cell.text)
      }
      data.push(row)
    }
    return { sheet: sheet.name, data }
  })
  const matches = templates.filter(
    (t) =>
      (!templateId || t.id === templateId) &&
      sheets.some(
        (s) =>
          s.sheet === t.sheetName &&
          ['level', 'materialCode', 'materialName', 'qty'].every((k) =>
            s.data[t.headerRow - 1]?.some(
              (c) => String(c ?? '').trim() === t.fieldMapping[k],
            ),
          ),
      ),
  )
  if (matches.length !== 1)
    throw new NpiError(
      'INVALID_BOM_FORMAT',
      matches.length
        ? '匹配到多个模板，请指定导入模板'
        : '未匹配模板，请由管理员配置字段映射与工作表',
      400,
    )
  const template = matches[0]!
  const sheet = sheets.find((s) => s.sheet === template.sheetName)!
  return parseBom(sheet.data, sheet.sheet, template)
}
