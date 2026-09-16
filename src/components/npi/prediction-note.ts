// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ProjectDetail } from '../../lib/npi/service'

export function predictionNote(
  kit: Pick<ProjectDetail['kit'], 'predictionComplete'> & {
    alerts?: ReadonlyArray<{ code: string }>
  },
) {
  if (kit.predictionComplete) return undefined
  const reasons = []
  if (kit.alerts?.some((alert) => alert.code === 'PENDING_REPLY'))
    reasons.push('仍有关键项待回复')
  if (kit.alerts?.some((alert) => alert.code === 'BOM_REVIEW_PENDING'))
    reasons.push('BOM换版待复核')
  return ['预测不完整', ...reasons].join(' · ')
}
