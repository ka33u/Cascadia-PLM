/** NPI SRS 1.4: calendar dates are Asia/Shanghai business dates. */
export class NpiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
  ) {
    super(message)
  }
}
export const stages = [
  'design',
  'manufacturing',
  'prototype',
  'test',
  'completed',
] as const
export type NpiStage = (typeof stages)[number]
export type Status =
  'pending_reply' | 'normal' | 'risk' | 'overdue' | 'completed'
export type NodeType = 'process' | 'tooling' | 'kit' | 'assembly'
export const nodeNames: Record<NodeType, string> = {
  process: '工艺准备',
  tooling: '工装准备',
  kit: '零部件齐套',
  assembly: '样机装配',
}
export interface DatedItem {
  id: string
  name: string
  ownerId: string
  ownerName?: string
  requiredDate: string | null
  firstCommittedDate: string | null
  currentCommittedDate: string | null
  actualCompleteDate: string | null
  affectsKit: boolean
  trackingEnabled: boolean
  version: number
  trackingType: string
  sourceType: string
}
export function today(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}
export function dateValue(
  value: unknown,
  label = '日期',
  optional = false,
): string | null {
  if ((value === null || value === undefined || value === '') && optional)
    return null
  if (typeof value !== 'string')
    throw new NpiError('VALIDATION_ERROR', `${label}必须是日期`)
  const s = value.trim()
  const day = s.slice(0, 10)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  )
    throw new NpiError('VALIDATION_ERROR', `${label}无效`)
  if (s.length === 10) return day
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      s,
    ) ||
    !Number.isFinite(Date.parse(s))
  )
    throw new NpiError('VALIDATION_ERROR', `${label}必须包含时区`)
  return today(new Date(s))
}
export function textValue(
  value: unknown,
  label: string,
  max = 255,
  optional = false,
): string {
  if ((value == null || value === '') && optional) return ''
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new NpiError('VALIDATION_ERROR', `${label}必填且不能超过${max}字`)
  return value.trim()
}
export function quantity(value: unknown): string {
  const s = String(value ?? '').trim()
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(s) || Number(s) <= 0)
    throw new NpiError(
      'VALIDATION_ERROR',
      '数量须为正数，最多12位整数及6位小数',
    )
  return s
}
export function itemStatus(
  item: Pick<
    DatedItem,
    'requiredDate' | 'currentCommittedDate' | 'actualCompleteDate'
  >,
  day = today(),
): Status {
  if (item.actualCompleteDate) return 'completed'
  if (item.currentCommittedDate && item.currentCommittedDate < day)
    return 'overdue'
  if (!item.currentCommittedDate && item.requiredDate) return 'pending_reply'
  if (
    item.currentCommittedDate &&
    item.requiredDate &&
    item.currentCommittedDate > item.requiredDate
  )
    return 'risk'
  return 'normal'
}
export function promiseChange(
  item: DatedItem,
  input: { committedDate: unknown; reason?: unknown; expectedVersion: unknown },
) {
  if (input.expectedVersion !== item.version)
    throw new NpiError(
      'VERSION_CONFLICT',
      '记录已更新，请重新打开最新记录后提交',
      409,
    )
  const next = dateValue(input.committedDate, '承诺日期')!
  if (next === item.currentCommittedDate) return null
  if (item.actualCompleteDate)
    throw new NpiError('INVALID_STATE_TRANSITION', '已完成项不能修改承诺', 400)
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (item.currentCommittedDate && !reason)
    throw new NpiError(
      'PROMISE_REASON_REQUIRED',
      '修改承诺必须填写变更原因',
      400,
    )
  if (reason.length > 2000)
    throw new NpiError('VALIDATION_ERROR', '变更原因不能超过2000字')
  return {
    firstCommittedDate: item.firstCommittedDate ?? next,
    currentCommittedDate: next,
    oldCommittedDate: item.currentCommittedDate,
    reason: reason || '首次回复',
  }
}
export function kitStatus(
  items: Array<DatedItem>,
  requiredKitDate: string,
  manufacturingCommittedKitDate: string | null,
  day = today(),
) {
  const counts: Record<Status, number> = {
    pending_reply: 0,
    normal: 0,
    risk: 0,
    overdue: 0,
    completed: 0,
  }
  for (const item of items)
    if (item.trackingEnabled || item.affectsKit) counts[itemStatus(item, day)]++
  // The management kit commitment and downstream assembly must not substitute
  // for (or circularly participate in) the independently calculated prediction.
  const relevant = items.filter(
    (i) =>
      i.affectsKit &&
      !i.actualCompleteDate &&
      i.trackingType !== 'kit' &&
      i.trackingType !== 'assembly',
  )
  const pending = relevant.filter((i) => !i.currentCommittedDate)
  const candidates = relevant
    .filter((i) => i.currentCommittedDate)
    .sort(
      (a, b) =>
        b.currentCommittedDate!.localeCompare(a.currentCommittedDate!) ||
        a.id.localeCompare(b.id),
    )
  const latest = candidates[0]
  const predictedKitDate = latest?.currentCommittedDate ?? null
  const alerts: Array<{ code: string; message: string }> = []
  if (pending.length)
    alerts.push({
      code: 'PENDING_REPLY',
      message: `仍有${pending.length}项影响齐套的物料或节点未回复，预测不完整`,
    })
  if (
    predictedKitDate &&
    manufacturingCommittedKitDate &&
    predictedKitDate > manufacturingCommittedKitDate
  )
    alerts.push({
      code: 'DETAIL_VS_COMMIT_CONFLICT',
      message: '明细预测晚于制造承诺齐套日期',
    })
  if (
    manufacturingCommittedKitDate &&
    manufacturingCommittedKitDate > requiredKitDate
  )
    alerts.push({
      code: 'KIT_COMMIT_RISK',
      message: '制造承诺晚于要求齐套日期',
    })
  return {
    requiredKitDate,
    manufacturingCommittedKitDate,
    predictedKitDate,
    predictionComplete: pending.length === 0,
    pendingReplyCount: counts.pending_reply,
    riskCount: counts.risk,
    overdueCount: counts.overdue,
    completedCount: counts.completed,
    counts,
    allRelevantCompleted:
      items.some(
        (i) => i.affectsKit && !['kit', 'assembly'].includes(i.trackingType),
      ) && relevant.length === 0,
    bottleneck: latest
      ? {
          type:
            latest.sourceType === 'MANUFACTURING'
              ? 'manufacturing_node'
              : 'tracking_item',
          id: latest.id,
          name: latest.name,
          ownerId: latest.ownerId,
          ownerName: latest.ownerName,
          committedDate: latest.currentCommittedDate,
        }
      : null,
    alerts,
  }
}
