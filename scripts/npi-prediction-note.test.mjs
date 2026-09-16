// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import test from 'node:test'
import { predictionNote } from '../packages/core/src/components/npi/prediction-note.ts'
const kit = (codes, predictionComplete = false) => ({
  predictionComplete,
  alerts: codes.map((code) => ({ code, message: code })),
})
await test('Incomplete prediction distinguishes missing commitments, BOM review, and concurrent causes', () => {
  assert.equal(
    predictionNote(kit(['PENDING_REPLY'])),
    '预测不完整 · 仍有关键项待回复',
  )
  assert.equal(
    predictionNote(kit(['BOM_REVIEW_PENDING'])),
    '预测不完整 · BOM换版待复核',
  )
  assert.equal(
    predictionNote(kit(['BOM_REVIEW_PENDING', 'PENDING_REPLY'])),
    '预测不完整 · 仍有关键项待回复 · BOM换版待复核',
  )
})
await test('A complete prediction is not labelled incomplete merely because a noncritical BOM review alert exists', () => {
  assert.equal(predictionNote(kit(['BOM_REVIEW_PENDING'], true)), undefined)
  assert.equal(predictionNote(kit([])), '预测不完整')
  assert.equal(predictionNote(kit(['DETAIL_VS_COMMIT_CONFLICT'])), '预测不完整')
})
