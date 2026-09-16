// SPDX-License-Identifier: AGPL-3.0-or-later
import { NpiError } from './domain'

/** Quantize decimal text without passing engineering quantities through binary floats. */
export function normalizeBomQuantity(raw: string, numericSource = false) {
  const match = /^\+?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw.trim())
  const invalid = () =>
    new NpiError(
      'INVALID_BOM_FORMAT',
      '数量须为正数，最多12位整数及6位小数',
      400,
    )
  if (!match) throw invalid()
  const fraction = match[2] || ''
  const digits = (match[1]! + fraction).replace(/^0+/, '')
  const exponent = Number(match[3] || 0)
  if (!digits || !Number.isSafeInteger(exponent)) throw invalid()
  // Work in millionths. Bounds are checked before padding or constructing a BigInt.
  const shift = 6 - fraction.length + exponent
  const length = digits.length + shift
  if (length > 18 || length < 0) throw invalid()
  let units: bigint
  let rounded = false
  if (shift >= 0) units = BigInt(digits + '0'.repeat(shift))
  else {
    const remainder = digits.slice(length)
    rounded = /[1-9]/.test(remainder)
    units = BigInt(digits.slice(0, length) || '0')
    if (remainder[0]! >= '5') units += 1n
  }
  if (units <= 0n || units > 999999999999999999n) throw invalid()
  const whole = String(units / 1000000n)
  const decimal = String(units % 1000000n)
    .padStart(6, '0')
    .replace(/0+$/, '')
  const value = decimal ? `${whole}.${decimal}` : whole
  // Only numeric Excel cells may carry binary arithmetic noise. Text cells are exact.
  if (
    rounded &&
    numericSource &&
    Math.abs(Number(raw) - Number(value)) <= 1e-12
  )
    rounded = false
  return { value, rounded }
}
