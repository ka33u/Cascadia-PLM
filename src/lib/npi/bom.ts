import { NpiError, dateValue } from './domain'
import { normalizeBomQuantity } from './bom-quantity'
import { suggestBomTracking } from './bom-tracking'
import type { TrackingSuggestion } from './bom-tracking'

export type Cell = string | number | boolean | Date | null
export interface ImportTemplate {
  id: string
  name: string
  sheetName: string
  headerRow: number
  dataStartRow: number
  levelParser: 'plus' | 'number'
  fieldMapping: Record<string, string>
  motherInfoMapping: { code: string; name: string; spec: string }
}
export const defaultTemplate: ImportTemplate = {
  id: 'erp-multilevel-v1',
  name: 'ERP 母件结构表（多阶）',
  sheetName: '母件结构表-多阶',
  headerRow: 5,
  dataStartRow: 6,
  levelParser: 'plus',
  motherInfoMapping: { code: 'A4', name: 'B4', spec: 'C4' },
  fieldMapping: {
    level: '级别',
    lineNo: '子件行号',
    materialCode: '子件编码',
    materialName: '子件名称',
    specification: '子件规格',
    unit: '子件计量单位',
    qty: '基本用量',
    supplyType: '供应类型',
    warehouse: '仓库名称',
    issueDepartment: '领料部门名称',
    effectiveDate: '子件生效日',
    remark: '备注',
  },
}
export interface BomRow {
  id: string
  parentId: string | null
  rowNo: number
  level: number
  lineNo: string
  materialCode: string
  materialName: string
  specification: string
  qty: string
  unit: string
  supplyType: string
  warehouse: string
  issueDepartment: string
  effectiveDate: string | null
  remark: string
  rawData: Record<string, unknown>
  suggestedTracking: boolean
  trackingSuggestion?: TrackingSuggestion
}
export interface MotherConfirmation {
  original: { code: string; name: string; spec: string }
  confirmed: { code: string; name: string; spec: string }
  reason: string
  confirmedBy: string
  confirmedByName: string
  confirmedAt: string
}
export interface BomPreview {
  templateMatched: boolean
  templateId: string
  sheetName: string
  templateSnapshot?: ImportTemplate
  mother: { code: string; name: string; spec: string }
  motherConfirmation?: MotherConfirmation
  summary: {
    rows: number
    maxLevel: number
    level1Count: number
    errors: number
    warnings: number
  }
  previewRows: Array<BomRow>
  validation: Array<{
    rowNo: number
    severity: 'ERROR' | 'WARNING' | 'INFO'
    code: string
    message: string
  }>
}
const clean = (v: Cell | undefined) =>
  v == null ? '' : v instanceof Date ? v.toISOString() : String(v).trim()
function cellAt(rows: Array<Array<Cell>>, ref: string) {
  const m = /^([A-Z]{1,3})([1-9]\d{0,4})$/.exec(ref)
  if (!m) throw new NpiError('VALIDATION_ERROR', `无效模板单元格：${ref}`)
  let col = 0
  for (const c of m[1]!) col = col * 26 + c.charCodeAt(0) - 64
  return rows[Number(m[2]) - 1]?.[col - 1]
}
export function validateTemplate(
  value: unknown,
): asserts value is ImportTemplate {
  if (!value || typeof value !== 'object')
    throw new NpiError('VALIDATION_ERROR', '模板必须为对象')
  const t = value as Partial<ImportTemplate>
  if (
    typeof t.id !== 'string' ||
    !t.id ||
    typeof t.name !== 'string' ||
    !t.name.trim() ||
    typeof t.sheetName !== 'string' ||
    !t.sheetName.trim()
  )
    throw new NpiError('VALIDATION_ERROR', '模板名称、编号、工作表必填')
  if (
    !Number.isInteger(t.headerRow) ||
    !Number.isInteger(t.dataStartRow) ||
    t.headerRow! < 1 ||
    t.headerRow! > 100 ||
    t.dataStartRow! <= t.headerRow! ||
    t.dataStartRow! > 200
  )
    throw new NpiError('VALIDATION_ERROR', '模板表头行和数据起始行无效')
  if (!['plus', 'number'].includes(t.levelParser || ''))
    throw new NpiError('VALIDATION_ERROR', '层级解析器无效')
  for (const key of ['level', 'materialCode', 'materialName', 'qty'])
    if (typeof t.fieldMapping?.[key] !== 'string' || !t.fieldMapping[key])
      throw new NpiError('VALIDATION_ERROR', `缺少字段映射：${key}`)
  for (const key of ['code', 'name', 'spec'] as const)
    cellAt([], t.motherInfoMapping?.[key] || '')
}
export function parseBom(
  rows: Array<Array<Cell>>,
  sheetName: string,
  template: ImportTemplate,
): BomPreview {
  validateTemplate(template)
  if (rows.length > 5005 || rows.some((r) => r.length > 150))
    throw new NpiError('INVALID_BOM_FORMAT', '单次BOM最多5000行、150列', 400)
  const header = rows[template.headerRow - 1]?.map(clean) ?? []
  const validation: BomPreview['validation'] = []
  const add = (
    rowNo: number,
    severity: 'ERROR' | 'WARNING' | 'INFO',
    code: string,
    message: string,
  ) => validation.push({ rowNo, severity, code, message })
  const columns: Record<string, number> = {}
  for (const [key, label] of Object.entries(template.fieldMapping)) {
    columns[key] = header.indexOf(label)
    if (
      key === 'trackingProperties' &&
      (columns[key] < 0 || header.indexOf(label, columns[key] + 1) >= 0)
    ) {
      columns[key] = -1
      add(
        template.headerRow,
        'WARNING',
        'TRACKING_PROPERTIES_UNAVAILABLE',
        `跟踪属性列缺失或重复：${label}；本次不据此生成建议，请人工确认`,
      )
    }
    if (
      ['level', 'materialCode', 'materialName', 'qty'].includes(key) &&
      (columns[key] < 0 || header.indexOf(label, columns[key] + 1) >= 0)
    )
      add(
        template.headerRow,
        'ERROR',
        'INVALID_BOM_FORMAT',
        `缺少或重复的必填列：${label}`,
      )
  }
  const mother = {
    code: clean(cellAt(rows, template.motherInfoMapping.code)),
    name: clean(cellAt(rows, template.motherInfoMapping.name)),
    spec: clean(cellAt(rows, template.motherInfoMapping.spec)),
  }
  if (!mother.code)
    add(
      0,
      'ERROR',
      'MOTHER_REQUIRED',
      '未识别母件编码，请确认本次母件信息或调整模板映射',
    )
  const parsed: Array<BomRow> = []
  const stack: Array<string> = []
  const codes = new Set<string>()
  let previous = 0
  if (!validation.some((v) => v.code === 'INVALID_BOM_FORMAT'))
    for (let i = template.dataStartRow - 1; i < rows.length; i++) {
      const raw = rows[i]!
      if (raw.every((c) => !clean(c))) continue
      const get = (key: string) => clean(raw[columns[key] ?? -1])
      // Footer text is only ignored if no code, level, name or quantity is present.
      if (
        !get('level') &&
        !get('materialCode') &&
        !get('materialName') &&
        !get('qty')
      )
        continue
      const rowNo = i + 1
      const levelText = get('level').replace(/\s/g, '')
      const level =
        template.levelParser === 'plus'
          ? /^\++$/.test(levelText)
            ? levelText.length
            : 0
          : /^[1-9]\d*$/.test(levelText)
            ? Number(levelText)
            : 0
      if (!level || !Number.isSafeInteger(level)) {
        add(
          rowNo,
          'ERROR',
          'INVALID_LEVEL_SEQUENCE',
          '级别必须为 + 符号或模板指定的正整数',
        )
        continue
      }
      if (level > previous + 1 || (level > 1 && !stack[level - 2])) {
        add(
          rowNo,
          'ERROR',
          'INVALID_LEVEL_SEQUENCE',
          `层级从${previous}跳至${level}`,
        )
        continue
      }
      const materialCode = get('materialCode')
      const materialName = get('materialName')
      if (!materialCode || !materialName)
        add(rowNo, 'ERROR', 'INVALID_BOM_FORMAT', '物料编码和名称必填')
      let qty = ''
      try {
        const rawQty = get('qty')
        const normalized = normalizeBomQuantity(
          rawQty,
          typeof raw[columns.qty!] === 'number',
        )
        qty = normalized.value
        if (normalized.rounded)
          add(
            rowNo,
            'WARNING',
            'QTY_ROUNDED',
            `数量按6位小数舍入为${qty}，原值保存在原始行`,
          )
      } catch {
        add(
          rowNo,
          'ERROR',
          'INVALID_BOM_FORMAT',
          '数量无效，须为正数，最多12位整数和6位小数',
        )
      }
      let effectiveDate: string | null = null
      const d = raw[columns.effectiveDate ?? -1]
      if (d != null && d !== '')
        try {
          // Excel's 1900 date system; reject the fictitious leap day explicitly.
          if (typeof d === 'number') {
            if (d < 1 || d === 60 || d > 2958465) throw new Error()
            effectiveDate = new Date(
              Date.UTC(1899, 11, 30) +
                Math.floor(d + (d < 60 ? 1 : 0)) * 86400000,
            )
              .toISOString()
              .slice(0, 10)
          } else
            effectiveDate = dateValue(
              d instanceof Date
                ? d.toISOString().slice(0, 10)
                : String(d).trim().replaceAll('/', '-'),
              '生效日期',
            )
        } catch {
          add(rowNo, 'ERROR', 'INVALID_BOM_FORMAT', '生效日期无效')
        }
      const id = crypto.randomUUID()
      const parentId = level === 1 ? null : stack[level - 2]!
      const rawData = Object.fromEntries(
        raw.map((v, j) => [
          `${j + 1}:${header[j] || '未命名'}`,
          v instanceof Date ? v.toISOString() : v,
        ]),
      )
      const trackingSuggestion = suggestBomTracking(
        level,
        get('trackingProperties'),
      )
      if (trackingSuggestion.unknown.length)
        add(
          rowNo,
          'WARNING',
          'UNKNOWN_TRACKING_PROPERTY',
          `未识别的跟踪属性：${trackingSuggestion.unknown.join('、').slice(0, 200)}；未识别内容不参与建议，请人工核对`,
        )
      parsed.push({
        id,
        parentId,
        rowNo,
        level,
        lineNo: get('lineNo'),
        materialCode,
        materialName,
        specification: get('specification'),
        qty,
        unit: get('unit'),
        supplyType: get('supplyType'),
        warehouse: get('warehouse'),
        issueDepartment: get('issueDepartment'),
        effectiveDate,
        remark: get('remark'),
        rawData,
        // Suggestion only; no tracking rows or obligations are created here.
        suggestedTracking: trackingSuggestion.reasons.length > 0,
        trackingSuggestion,
      })
      stack[level - 1] = id
      stack.length = level
      previous = level
      const missing = ['specification', 'warehouse', 'issueDepartment'].filter(
        (k) => !get(k),
      )
      if (missing.length)
        add(
          rowNo,
          'WARNING',
          'OPTIONAL_FIELDS_EMPTY',
          '规格、仓库或领料部门存在空值',
        )
      if (codes.has(materialCode))
        add(
          rowNo,
          'INFO',
          'REPEATED_MATERIAL',
          `编码${materialCode}重复出现，允许保留不同BOM位置`,
        )
      codes.add(materialCode)
    }
  if (!parsed.length) add(0, 'ERROR', 'INVALID_BOM_FORMAT', '未找到有效BOM明细')
  return {
    templateMatched: true,
    templateId: template.id,
    templateSnapshot: structuredClone(template),
    sheetName,
    mother,
    previewRows: parsed,
    validation,
    summary: {
      rows: parsed.length,
      maxLevel: parsed.reduce((m, r) => Math.max(m, r.level), 0),
      level1Count: parsed.filter((r) => r.level === 1).length,
      errors: validation.filter((v) => v.severity === 'ERROR').length,
      warnings: validation.filter((v) => v.severity === 'WARNING').length,
    },
  }
}
export function bomTree<T extends BomRow>(rows: Array<T>) {
  type TreeNode = T & { children: Array<TreeNode> }
  const map = new Map<string, TreeNode>(
    rows.map((r) => [r.id, { ...r, children: [] }]),
  )
  const roots: Array<TreeNode> = []
  for (const row of rows) {
    const n = map.get(row.id)!
    if (row.parentId && map.has(row.parentId))
      map.get(row.parentId)!.children.push(n)
    else roots.push(n)
  }
  return roots
}
export interface BomDifference {
  type: 'ADDED' | 'REMOVED' | 'QTY_CHANGED' | 'MOVED' | 'UNCHANGED'
  before: BomRow | null
  after: BomRow | null
  beforePath: string | null
  afterPath: string | null
  quantityChanged: boolean
}
// Include the entire ancestor chain: identical subassemblies can occur under
// different roots. JSON tuples avoid collisions with punctuation in ERP codes.
export function bomLocations(rows: Array<BomRow>) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const result = new Map<string, { key: string; label: string }>()
  for (const row of rows) {
    const chain: Array<BomRow> = []
    const visited = new Set<string>()
    let current: BomRow | undefined = row
    while (current) {
      if (visited.has(current.id))
        throw new NpiError('INVALID_BOM_FORMAT', 'BOM父子结构存在循环', 400)
      visited.add(current.id)
      chain.push(current)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    chain.reverse()
    result.set(row.id, {
      key: JSON.stringify(chain.map((r) => [r.materialCode, r.lineNo])),
      label: chain
        .map((r) => `${r.materialCode} [${r.lineNo || '无行号'}]`)
        .join(' / '),
    })
  }
  return result
}
export function bomDiff(
  before: Array<BomRow>,
  after: Array<BomRow>,
): Array<BomDifference> {
  const oldLocations = bomLocations(before),
    nextLocations = bomLocations(after)
  const remainingOld = new Map(before.map((r) => [r.id, r]))
  const remainingNext = new Map(after.map((r) => [r.id, r]))
  const matches = new Map<string, BomRow>()
  const pairUnique = (keyOf: (r: BomRow, side: 'old' | 'next') => string) => {
    const groups = (rows: Map<string, BomRow>, side: 'old' | 'next') => {
      const grouped = new Map<string, Array<BomRow>>()
      for (const r of rows.values()) {
        const key = keyOf(r, side)
        grouped.set(key, [...(grouped.get(key) || []), r])
      }
      return grouped
    }
    const oldGroups = groups(remainingOld, 'old'),
      nextGroups = groups(remainingNext, 'next')
    for (const [key, oldRows] of oldGroups) {
      const newRows = nextGroups.get(key)
      // Repeated ambiguous positions must be resolved by a person, never by
      // whichever row happens to arrive first from the database.
      if (oldRows.length !== 1 || newRows?.length !== 1) continue
      matches.set(newRows[0]!.id, oldRows[0]!)
      remainingOld.delete(oldRows[0]!.id)
      remainingNext.delete(newRows[0]!.id)
    }
  }
  pairUnique(
    (r, side) => (side === 'old' ? oldLocations : nextLocations).get(r.id)!.key,
  )
  pairUnique((r) => r.materialCode)
  const result: Array<BomDifference> = after.map((row) => {
    const old = matches.get(row.id) ?? null
    const moved =
      !!old && oldLocations.get(old.id)!.key !== nextLocations.get(row.id)!.key
    const quantityChanged =
      !!old &&
      normalizeBomQuantity(old.qty).value !==
        normalizeBomQuantity(row.qty).value
    return {
      type: !old
        ? 'ADDED'
        : moved
          ? 'MOVED'
          : quantityChanged
            ? 'QTY_CHANGED'
            : 'UNCHANGED',
      before: old,
      after: row,
      beforePath: old ? oldLocations.get(old.id)!.label : null,
      afterPath: nextLocations.get(row.id)!.label,
      quantityChanged,
    }
  })
  for (const row of remainingOld.values())
    result.push({
      type: 'REMOVED',
      before: row,
      after: null,
      beforePath: oldLocations.get(row.id)!.label,
      afterPath: null,
      quantityChanged: false,
    })
  return result
}
