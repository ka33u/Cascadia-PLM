// SPDX-License-Identifier: AGPL-3.0-or-later
import { NpiError, textValue } from './domain'
import type { BomPreview, MotherConfirmation } from './bom'

function apply(
  preview: BomPreview,
  confirmation: MotherConfirmation,
): BomPreview {
  const validation = preview.validation.filter(
    (v) => v.code !== 'MOTHER_REQUIRED' && v.code !== 'MOTHER_CONFIRMED',
  )
  validation.push({
    rowNo: 0,
    severity: 'INFO',
    code: 'MOTHER_CONFIRMED',
    message: '母件信息已人工确认，原始Excel保持不变',
  })
  return {
    ...preview,
    mother: { ...confirmation.confirmed },
    motherConfirmation: confirmation,
    validation,
    summary: {
      ...preview.summary,
      errors: validation.filter((v) => v.severity === 'ERROR').length,
    },
  }
}
export function confirmMother(
  preview: BomPreview,
  input: unknown,
  actor: { id: string; name: string },
): BomPreview {
  if (input === undefined) return preview
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new NpiError('VALIDATION_ERROR', '母件确认内容无效')
  const values = input as Record<string, unknown>
  const confirmed = {
    code: textValue(values.code, '母件编码', 120),
    name: textValue(values.name, '母件名称', 255),
    spec: textValue(values.spec, '母件规格', 1000, true),
  }
  return apply(preview, {
    original: { ...preview.mother },
    confirmed,
    reason: textValue(values.reason, '母件确认原因', 2000),
    confirmedBy: actor.id,
    confirmedByName: actor.name,
    confirmedAt: new Date().toISOString(),
  })
}
export function restoreConfirmedMother(
  preview: BomPreview,
  saved: BomPreview,
): BomPreview {
  const confirmation = saved.motherConfirmation
  // A changed mapping or newly recognized mother must be reviewed again.
  if (
    !confirmation ||
    JSON.stringify(preview.templateSnapshot) !==
      JSON.stringify(saved.templateSnapshot) ||
    JSON.stringify(preview.mother) !== JSON.stringify(confirmation.original)
  )
    return preview
  return apply(preview, confirmation)
}
