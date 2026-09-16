// SPDX-License-Identifier: AGPL-3.0-or-later
import { NpiError, textValue } from './domain'

export const profileFields = [
  { key: 'customer', label: '客户', max: 200, kind: 'text' },
  { key: 'application', label: '用途 / 应用场景', max: 500, kind: 'text' },
  { key: 'ratedPowerKw', label: '额定功率（kW）', max: 19, kind: 'decimal' },
  { key: 'ratedVoltageV', label: '额定电压（V）', max: 19, kind: 'decimal' },
  { key: 'poles', label: '极数', max: 6, kind: 'integer' },
  { key: 'description', label: '项目说明', max: 4000, kind: 'textarea' },
] as const
export type ProfileKey = (typeof profileFields)[number]['key']
export type ProjectProfile = Record<ProfileKey, string>
type StoredProfile = {
  customer: string | null
  description: string | null
  attributes: Record<string, unknown>
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const display = (value: unknown) =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : ''
export function readProjectProfile(program?: StoredProfile): ProjectProfile {
  const motor = record(record(program?.attributes).npiMotorSpec)
  return {
    customer: program?.customer || '',
    description: program?.description || '',
    application: display(motor.application),
    ratedPowerKw: display(motor.ratedPowerKw),
    ratedVoltageV: display(motor.ratedVoltageV),
    poles: display(motor.poles),
  }
}
function parse(value: unknown, field: (typeof profileFields)[number]) {
  if (value == null || (typeof value === 'string' && !value.trim())) return ''
  if (field.kind === 'decimal' || field.kind === 'integer') {
    if (!['string', 'number'].includes(typeof value))
      throw new NpiError('VALIDATION_ERROR', `${field.label}须为正数或留空`)
    const s = String(value).trim()
    const valid =
      field.kind === 'integer'
        ? /^\d{1,6}$/.test(s)
        : /^\d{1,12}(?:\.\d{1,6})?$/.test(s)
    if (!valid || Number(s) <= 0)
      throw new NpiError(
        'VALIDATION_ERROR',
        `${field.label}${field.kind === 'integer' ? '须为正整数，最多6位' : '须为正数，最多12位整数及6位小数'}；单位已固定，无需输入单位文字`,
      )
    const [integer, fraction] = s.split('.')
    return (
      integer!.replace(/^0+(?=\d)/, '') +
      (fraction?.replace(/0+$/, '') ? '.' + fraction.replace(/0+$/, '') : '')
    )
  }
  return textValue(value, field.label, field.max)
}
export function prepareProjectProfile(
  program: StoredProfile,
  input: Record<string, unknown>,
) {
  const before = readProjectProfile(program),
    next = { ...before }
  const changes: Array<{
    key: ProfileKey
    label: string
    before: string
    after: string
  }> = []
  const patch: Partial<StoredProfile> = {}
  for (const field of profileFields) {
    if (input[field.key] === undefined) continue
    const value = parse(input[field.key], field)
    next[field.key] = value
    if (value === before[field.key]) continue
    changes.push({
      key: field.key,
      label: field.label,
      before: before[field.key],
      after: value,
    })
    if (field.key === 'customer' || field.key === 'description')
      patch[field.key] = value || null
  }
  const motorChanges = changes.filter(
    (c) => c.key !== 'customer' && c.key !== 'description',
  )
  if (motorChanges.length) {
    const attrs = program.attributes
    if (attrs != null && (typeof attrs !== 'object' || Array.isArray(attrs)))
      throw new NpiError(
        'VALIDATION_ERROR',
        '原生项目扩展属性格式异常，请先核对',
      )
    const motor = attrs?.npiMotorSpec
    if (motor != null && (typeof motor !== 'object' || Array.isArray(motor)))
      throw new NpiError('VALIDATION_ERROR', '电机扩展属性格式异常，请先核对')
    patch.attributes = {
      ...attrs,
      npiMotorSpec: {
        ...record(motor),
        ...Object.fromEntries(
          motorChanges.map((c) => [c.key, c.after || null]),
        ),
      },
    }
  }
  return { before, next, changes, patch }
}
