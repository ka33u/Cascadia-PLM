// SPDX-License-Identifier: AGPL-3.0-or-later
export type ProjectFilter =
  'all' | 'pending_reply' | 'risk' | 'overdue' | 'month' | 'completed'
type DashboardProject = {
  id: string
  name: string
  motorModel: string
  code: string
  manufacturingOwnerId: string
  currentNpiStage: string
  riskStatus: string
  prototypeRequiredDate: string
  kit: {
    pendingReplyCount: number
    riskCount: number
    alerts: Array<{ code: string }>
  }
  items: Array<{ trackingType: string; actualCompleteDate: string | null }>
}
export const isExceptional = (p: Pick<DashboardProject, 'riskStatus'>) =>
  ['overdue', 'risk', 'pending_reply'].includes(p.riskStatus)
export function projectMatchesFilter(
  p: DashboardProject,
  filter: ProjectFilter,
  day: string,
) {
  const active = p.currentNpiStage !== 'completed'
  switch (filter) {
    case 'all':
      return active
    case 'pending_reply':
      return active && p.kit.pendingReplyCount > 0
    case 'risk':
      return (
        active &&
        (p.kit.riskCount > 0 ||
          p.kit.alerts.some((a) => a.code !== 'PENDING_REPLY'))
      )
    case 'overdue':
      return active && p.riskStatus === 'overdue'
    case 'month':
      return p.prototypeRequiredDate.startsWith(day.slice(0, 7))
    case 'completed':
      return !active
  }
}
export function scopeDashboardProjects<T extends DashboardProject>(
  projects: Array<T>,
  view: string,
  actor: { id: string; role: string },
) {
  return projects.filter(
    (p) =>
      view !== 'manufacturing' ||
      actor.role === 'admin' ||
      p.manufacturingOwnerId === actor.id,
  )
}
export function selectDashboardProjects<T extends DashboardProject>(
  projects: Array<T>,
  options: {
    filter: ProjectFilter
    day: string
    search: string
    exceptionsOnly: boolean
  },
) {
  const search = options.search.trim().toLowerCase()
  const order = ['overdue', 'risk', 'pending_reply', 'normal', 'completed']
  return projects
    .filter(
      (p) =>
        projectMatchesFilter(p, options.filter, options.day) &&
        (!options.exceptionsOnly || isExceptional(p)) &&
        `${p.name} ${p.motorModel} ${p.code}`.toLowerCase().includes(search),
    )
    .sort(
      (a, b) =>
        order.indexOf(a.riskStatus) - order.indexOf(b.riskStatus) ||
        a.prototypeRequiredDate.localeCompare(b.prototypeRequiredDate) ||
        a.code.localeCompare(b.code),
    )
}
export function projectCompletion(
  p: Pick<DashboardProject, 'items' | 'prototypeRequiredDate'>,
) {
  const actualDate =
    p.items.find((i) => i.trackingType === 'assembly')?.actualCompleteDate ||
    null
  return {
    actualDate,
    onTime: !!actualDate && actualDate <= p.prototypeRequiredDate,
  }
}
export function dashboardMetrics(
  projects: Array<DashboardProject>,
  day: string,
) {
  const count = (filter: ProjectFilter) =>
    projects.filter((p) => projectMatchesFilter(p, filter, day)).length
  const completed = projects.filter((p) =>
    projectMatchesFilter(p, 'completed', day),
  )
  const onTime = completed.filter((p) => projectCompletion(p).onTime).length
  return {
    active: count('all'),
    pending: count('pending_reply'),
    risk: count('risk'),
    overdue: count('overdue'),
    month: count('month'),
    completed: completed.length,
    onTime,
    onTimeRate: completed.length
      ? Math.round((onTime / completed.length) * 100)
      : null,
  }
}
