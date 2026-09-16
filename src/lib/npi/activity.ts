// SPDX-License-Identifier: AGPL-3.0-or-later
import { dateValue, itemStatus } from './domain'
import type { DatedItem } from './domain'

type Stamp = Date | string
type PromiseRecord = {
  id: string
  objectId: string
  oldCommittedDate: string | null
  newCommittedDate: string
  changedAt: Stamp
  reason: string
  actorName: string | null
}
type ActivityProject = {
  id: string
  name: string
  code: string
  currentNpiStage: string
  items: Array<DatedItem & { createdAt: Stamp }>
  history: Array<PromiseRecord>
}
export type ActivityEvent = {
  id: string
  programId: string | null
  objectId: string
  action: string
  detail: unknown
  createdAt: Stamp
  actorName: string | null
}
export function businessDayRange(day: string) {
  dateValue(day, '业务日期')
  const start = new Date(`${day}T00:00:00+08:00`)
  const end = new Date(start.getTime() + 86400000)
  const previous = new Date(new Date(day + 'T00:00:00Z').getTime() - 86400000)
    .toISOString()
    .slice(0, 10)
  return { start, end, previous }
}
export function promiseChangeCounts(
  history: Array<
    Pick<PromiseRecord, 'objectId' | 'oldCommittedDate' | 'newCommittedDate'>
  >,
) {
  const result = new Map<string, number>()
  for (const h of history)
    if (h.oldCommittedDate && h.oldCommittedDate !== h.newCommittedDate)
      result.set(h.objectId, (result.get(h.objectId) || 0) + 1)
  return result
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
export function todayActivity(
  projects: Array<ActivityProject>,
  events: Array<ActivityEvent>,
  day: string,
) {
  const { start, end, previous } = businessDayRange(day)
  const inDay = (stamp: Stamp) =>
    new Date(stamp) >= start && new Date(stamp) < end
  type Context = {
    projectId: string
    projectName: string
    projectCode: string
    itemId: string
    itemName: string
    ownerName: string
    requiredDate: string | null
  }
  const newOverdue: Array<Context & { committedDate: string }> = []
  const promiseChanges: Array<
    Context & {
      id: string
      oldDate: string
      newDate: string
      changedAt: Stamp
      actorName: string
      reason: string
    }
  > = []
  const completions: Array<
    Context & {
      id: string
      confirmedAt: Stamp
      actualDate: string
      actorName: string
    }
  > = []
  const orderedEvents = events
    .filter((e) => inDay(e.createdAt))
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
  for (const p of projects) {
    const projectEvents = orderedEvents.filter((e) => e.programId === p.id)
    const histories = p.history
      .filter((h) => inDay(h.changedAt))
      .sort(
        (a, b) =>
          new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime(),
      )
    for (const item of p.items) {
      const context: Context = {
        projectId: p.id,
        projectName: p.name,
        projectCode: p.code,
        itemId: item.id,
        itemName: item.name,
        ownerName: item.ownerName || '未命名',
        requiredDate: item.requiredDate,
      }
      const itemHistory = histories.filter((h) => h.objectId === item.id)
      const itemEvents = projectEvents.filter((e) => e.objectId === item.id)
      for (const h of itemHistory)
        if (h.oldCommittedDate && h.oldCommittedDate !== h.newCommittedDate)
          promiseChanges.push({
            ...context,
            id: h.id,
            oldDate: h.oldCommittedDate,
            newDate: h.newCommittedDate,
            changedAt: h.changedAt,
            actorName: h.actorName || '系统用户',
            reason: h.reason,
          })
      const confirmed = itemEvents.find((e) => e.action === 'COMPLETED')
      const actualDate = record(confirmed?.detail).actualCompleteDate
      if (confirmed && typeof actualDate === 'string')
        completions.push({
          ...context,
          id: confirmed.id,
          confirmedAt: confirmed.createdAt,
          actualDate,
          actorName: confirmed.actorName || '系统用户',
        })
      if (
        p.currentNpiStage === 'completed' ||
        !(item.trackingEnabled || item.affectsKit) ||
        itemStatus(item, day) !== 'overdue'
      )
        continue
      // Recover the opening commitment from the first audit row of this business day.
      const previousCommitment = itemHistory.length
        ? itemHistory[0]!.oldCommittedDate
        : item.currentCommittedDate
      const flagChange = itemEvents.find(
        (e) =>
          ['TRACKING_CHANGED', 'BOM_TRACKING_RETIRED'].includes(e.action) &&
          typeof record(record(e.detail).before).trackingEnabled ===
            'boolean' &&
          typeof record(record(e.detail).before).affectsKit === 'boolean',
      )
      const before = record(record(flagChange?.detail).before)
      const previouslyDisabled =
        flagChange && !before.trackingEnabled && !before.affectsKit
      const createdToday = inDay(item.createdAt)
      if (
        createdToday ||
        previouslyDisabled ||
        !previousCommitment ||
        previousCommitment >= previous
      )
        newOverdue.push({
          ...context,
          committedDate: item.currentCommittedDate!,
        })
    }
  }
  promiseChanges.sort(
    (a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime(),
  )
  completions.sort(
    (a, b) =>
      new Date(b.confirmedAt).getTime() - new Date(a.confirmedAt).getTime(),
  )
  newOverdue.sort(
    (a, b) =>
      a.committedDate.localeCompare(b.committedDate) ||
      a.projectCode.localeCompare(b.projectCode) ||
      a.itemName.localeCompare(b.itemName),
  )
  return { day, newOverdue, promiseChanges, completions }
}
export type NpiTodayActivity = ReturnType<typeof todayActivity>
