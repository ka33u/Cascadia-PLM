// SPDX-License-Identifier: AGPL-3.0-or-later
// Explicit ERP attributes only. Names, warehouses and departments do not prove
// a new specification, long lead time or customer requirement.
const aliases: Record<string, string> = {
  核心自制加工件: '核心自制加工件',
  核心自制件: '核心自制加工件',
  核心加工件: '核心自制加工件',
  新规格外购件: '新规格外购件',
  长周期采购件: '长周期采购件',
  采购长周期件: '长周期采购件',
  客户指定件: '客户指定件',
  原材料: '原材料',
  普通倒冲件: '普通倒冲件',
  普通标准件: '普通标准件',
  标准件: '普通标准件',
  常备库存件: '常备库存件',
  关键件: '关键件',
  人工关键件: '关键件',
}
export interface TrackingSuggestion {
  version: 1
  properties: Array<string>
  reasons: Array<string>
  notes: Array<string>
  unknown: Array<string>
}
export const trackingPropertyHelp =
  '可填写核心自制加工件、新规格外购件、长周期采购件、客户指定件、原材料、普通倒冲件、普通标准件、常备库存件、关键件；多项用逗号、顿号、分号或换行分隔。'

export function suggestBomTracking(
  level: number,
  raw: string,
): TrackingSuggestion {
  const tokens = [
    ...new Set(
      raw
        .split(/[,，、;；\n\r|]+/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ]
  const properties = [
    ...new Set(
      tokens.flatMap((v) => (Object.hasOwn(aliases, v) ? [aliases[v]!] : [])),
    ),
  ]
  const unknown = tokens.filter((v) => !Object.hasOwn(aliases, v))
  const reasons: Array<string> = []
  const notes: Array<string> = []
  const has = (value: string) => properties.includes(value)
  const defaults = properties.filter((v) =>
    ['原材料', '普通倒冲件', '普通标准件', '常备库存件'].includes(v),
  )
  // Explicit critical/long-lead/customer requirements override default exclusions.
  if (has('关键件')) reasons.push('人工关键件：优先建议重点跟踪')
  if (has('长周期采购件')) reasons.push('长周期采购件：不限BOM层级')
  if (has('客户指定件')) reasons.push('客户指定件：不限BOM层级')
  if (!defaults.length) {
    if (level === 1 && has('核心自制加工件'))
      reasons.push('一级核心自制／加工件')
    if (level === 1 && has('新规格外购件')) reasons.push('一级新规格外购件')
  }
  if (defaults.length)
    notes.push(
      `${defaults.join('、')}：默认不跟踪；明确关键、长周期或客户指定要求优先`,
    )
  if (level > 1 && (has('核心自制加工件') || has('新规格外购件')))
    notes.push('非一级物料，请结合实际需要人工确认')
  if (!properties.length) notes.push('缺少可识别的跟踪属性，由负责人判断')
  return { version: 1, properties, reasons, notes, unknown }
}
