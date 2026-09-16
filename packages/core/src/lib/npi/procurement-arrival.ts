// SPDX-License-Identifier: AGPL-3.0-or-later
type ArrivalItem = {
  currentCommittedDate: string | null
  actualCompleteDate: string | null
}
export type ArrivalWindow = 'all' | 'today' | '7' | '14'
export const isArrivalWindow = (
  value: string,
): value is Exclude<ArrivalWindow, 'all'> =>
  value === 'today' || value === '7' || value === '14'

export function arrivalRange(
  day: string,
  window: Exclude<ArrivalWindow, 'all'>,
) {
  const days = window === 'today' ? 0 : Number(window)
  return {
    from: day,
    to: new Date(Date.parse(day + 'T00:00:00Z') + days * 86400000)
      .toISOString()
      .slice(0, 10),
  }
}

export function matchesArrivalWindow(
  item: ArrivalItem,
  day: string,
  window: ArrivalWindow,
) {
  if (window === 'all') return true
  const range = arrivalRange(day, window)
  return (
    !item.actualCompleteDate &&
    !!item.currentCommittedDate &&
    item.currentCommittedDate >= range.from &&
    item.currentCommittedDate <= range.to
  )
}

export function arrivalWindowDescription(
  day: string,
  window: Exclude<ArrivalWindow, 'all'>,
) {
  const range = arrivalRange(day, window)
  return `按当前承诺到货日期：${range.from} 至 ${range.to}（含今日及截止日），已到货不计；按承诺日期从近到远显示。`
}

export function compareExpectedArrival(a: ArrivalItem, b: ArrivalItem) {
  return (a.currentCommittedDate || '9999-12-31').localeCompare(
    b.currentCommittedDate || '9999-12-31',
  )
}
