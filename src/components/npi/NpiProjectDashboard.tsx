// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  dashboardMetrics,
  isExceptional,
  projectCompletion,
  scopeDashboardProjects,
  selectDashboardProjects,
} from '../../lib/npi/project-dashboard'
import { NpiActivity } from './NpiActivity'
import { NpiDashboardBriefs } from './NpiDashboardBriefs'
import { NpiPagination, usePagination } from './NpiPagination'
import { NpiAssignedMaterials } from './NpiAssignedMaterials'
import type { ProjectFilter } from '../../lib/npi/project-dashboard'
import type { NpiDashboard, NpiMetadata } from '../../lib/npi/service'

const stages: Record<string, string> = {
  design: '设计中',
  manufacturing: '制造准备',
  prototype: '样机制作',
  test: '样机试验',
  completed: '完成',
}
const statuses: Record<string, string> = {
  pending_reply: '待回复',
  normal: '正常',
  risk: '风险',
  overdue: '逾期',
  completed: '完成',
}
export function NpiProjectDashboard({
  dashboard,
  actor,
  view,
  onOpen,
  onCreate,
}: {
  dashboard: NpiDashboard
  actor: NpiMetadata['actor']
  view: string
  onOpen: (id: string, itemId?: string) => void
  onCreate: () => void
}) {
  const [filter, setFilter] = useState<ProjectFilter>('all')
  const [search, setSearch] = useState('')
  const [exceptionsOnly, setExceptionsOnly] = useState(false)
  const [normalExpanded, setNormalExpanded] = useState(false)
  const day = dashboard.todayActivity.day
  const projects = useMemo(
    () => scopeDashboardProjects(dashboard.projects, view, actor),
    [dashboard.projects, view, actor],
  )
  const metrics = useMemo(
    () => dashboardMetrics(projects, day),
    [projects, day],
  )
  const selected = useMemo(
    () =>
      selectDashboardProjects(projects, {
        filter,
        search,
        exceptionsOnly,
        day,
      }),
    [projects, filter, search, exceptionsOnly, day],
  )
  const { normal, primary } = useMemo(() => {
    const normalRows =
      filter === 'all' && !search.trim()
        ? selected.filter((p) => p.riskStatus === 'normal')
        : []
    const normalIds = new Set(normalRows.map((p) => p.id))
    return {
      normal: normalRows,
      primary: selected.filter((p) => !normalIds.has(p.id)),
    }
  }, [selected, filter, search])
  const primaryStart = useRef<HTMLDivElement>(null),
    normalStart = useRef<HTMLDivElement>(null)
  const primaryPage = usePagination(primary, 25, primaryStart),
    normalPage = usePagination(normal, 25, normalStart)
  const scopedDashboard = useMemo(() => {
    const ids = new Set(projects.map((p) => p.id))
    return {
      ...dashboard,
      projects,
      metrics,
      todayActivity: {
        ...dashboard.todayActivity,
        newOverdue: dashboard.todayActivity.newOverdue.filter((r) =>
          ids.has(r.projectId),
        ),
        promiseChanges: dashboard.todayActivity.promiseChanges.filter((r) =>
          ids.has(r.projectId),
        ),
        completions: dashboard.todayActivity.completions.filter((r) =>
          ids.has(r.projectId),
        ),
      },
    }
  }, [dashboard, projects, metrics])
  const drilldown = (next: ProjectFilter) => {
    setFilter(next)
    setSearch('')
    setExceptionsOnly(false)
    setNormalExpanded(true)
  }
  const reset = () => {
    setFilter('all')
    setSearch('')
    setExceptionsOnly(false)
    setNormalExpanded(false)
  }
  const table = (rows: typeof projects, label: string) => (
    <div className="npi-table-scroll">
      <table
        className="npi-table npi-tracking-table project-list"
        aria-label={label}
      >
        <thead>
          <tr>
            <th>新品项目</th>
            <th>当前阶段</th>
            <th>样机要求</th>
            <th>制造承诺齐套</th>
            <th>系统预测齐套</th>
            <th>当前瓶颈 / 完成结果</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const completion = projectCompletion(p)
            return (
              <tr key={p.id} data-project-id={p.id}>
                <td data-label="新品项目">
                  <button
                    className="npi-project-link"
                    onClick={() => onOpen(p.id)}
                  >
                    {p.name}
                    <ChevronRight size={15} />
                  </button>
                  <small>
                    {p.code} · {p.motorModel}
                  </small>
                </td>
                <td data-label="当前阶段">{stages[p.currentNpiStage]}</td>
                <td data-label="样机要求">
                  <span className="npi-date">{p.prototypeRequiredDate}</span>
                </td>
                <td data-label="制造承诺齐套">
                  <span className="npi-date">
                    {p.kit.manufacturingCommittedKitDate || '—'}
                  </span>
                </td>
                <td data-label="系统预测齐套">
                  <div>
                    <span className="npi-date">
                      {p.kit.predictedKitDate || '—'}
                    </span>
                    {!p.kit.predictionComplete && (
                      <small className="npi-warning-text">预测不完整</small>
                    )}
                  </div>
                </td>
                <td
                  data-label={
                    p.currentNpiStage === 'completed' ? '完成结果' : '当前瓶颈'
                  }
                >
                  <div>
                    {p.currentNpiStage === 'completed' ? (
                      <>
                        {completion.actualDate || '未记录样机实际完成'}
                        <small>
                          {completion.onTime
                            ? '按期完成'
                            : completion.actualDate
                              ? '晚于样机要求'
                              : '未计入按期完成'}
                        </small>
                      </>
                    ) : (
                      <>
                        <button
                          className="npi-project-link"
                          onClick={() => onOpen(p.id, p.kit.bottleneck?.id)}
                        >
                          {p.kit.bottleneck?.name ||
                            (p.kit.predictionComplete
                              ? '查看齐套明细'
                              : '关键项待回复')}
                        </button>
                        <small>{p.kit.bottleneck?.ownerName}</small>
                        <small className="npi-warning-text">
                          {
                            p.kit.alerts.find((a) => a.code !== 'PENDING_REPLY')
                              ?.message
                          }
                        </small>
                      </>
                    )}
                  </div>
                </td>
                <td data-label="状态">
                  <span className={`npi-badge npi-${p.riskStatus}`}>
                    {statuses[p.riskStatus]}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
  return (
    <>
      {['technical', 'manufacturing'].includes(actor.role) && (
        <NpiAssignedMaterials
          key={actor.id}
          actorId={actor.id}
          revision={dashboard}
          managedProjectIds={dashboard.projects.map((project) => project.id)}
        />
      )}
      <div className="npi-kpis" role="group" aria-label="项目指标">
        {[
          { key: 'all', label: '在研新品', value: metrics.active },
          { key: 'pending_reply', label: '待回复项目', value: metrics.pending },
          { key: 'risk', label: '风险项目', value: metrics.risk },
          { key: 'overdue', label: '逾期项目', value: metrics.overdue },
          { key: 'month', label: '本月样机目标', value: metrics.month },
          {
            key: 'completed',
            label: '完成项目按期率',
            value: metrics.onTimeRate == null ? '—' : `${metrics.onTimeRate}%`,
          },
        ].map((k) => (
          <button
            key={k.key}
            aria-pressed={filter === k.key}
            className={`npi-kpi ${filter === k.key ? 'selected' : ''} ${k.key}`}
            onClick={() => drilldown(k.key as ProjectFilter)}
          >
            <span>{k.label}</span>
            <strong>{k.value}</strong>
            <small>
              查看项目 <ChevronRight size={12} />
            </small>
          </button>
        ))}
      </div>
      <section className="npi-panel" aria-label="项目进度列表">
        <div className="npi-panel-title">
          <div>
            <h2>新品进度概览</h2>
            <p>
              {view === 'manufacturing' && actor.role !== 'admin'
                ? '本人负责制造的项目'
                : '当前账号可见的项目'}{' '}
              · 指标不随下方搜索变化
            </p>
          </div>
          <label className="npi-search">
            <span className="sr-only">搜索项目</span>
            <input
              type="search"
              maxLength={200}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索项目名称 / 型号 / 编号"
            />
          </label>
        </div>
        <div className="npi-filters">
          {(
            [
              ['all', '在研'],
              ['pending_reply', '待回复'],
              ['risk', '风险'],
              ['overdue', '逾期'],
              ['month', '本月样机'],
              ['completed', '已完成'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              aria-pressed={filter === key}
              className={filter === key ? 'active' : ''}
              onClick={() => {
                setFilter(key)
                if (key === 'completed' || key === 'month')
                  setExceptionsOnly(false)
              }}
            >
              {label}
            </button>
          ))}
          <label className="npi-exception-toggle">
            <input
              type="checkbox"
              checked={exceptionsOnly}
              onChange={(e) => setExceptionsOnly(e.target.checked)}
            />
            仅看异常
          </label>
          <button onClick={reset}>重置筛选</button>
        </div>
        {!!projects.length && (
          <p className="npi-list-summary" role="status">
            共 {selected.length} 个项目 · 异常{' '}
            {selected.filter(isExceptional).length} 个
            {normal.length
              ? ` · 正常 ${normal.length} 个${normalExpanded ? '已展开' : '已收起'}`
              : ''}
            {filter === 'completed'
              ? ` · 按期 ${selected.filter((p) => projectCompletion(p).onTime).length} 个（按样机装配实际日期）`
              : ''}
          </p>
        )}
        {!!primary.length && (
          <div ref={primaryStart}>
            <NpiPagination label="项目概览顶部翻页" {...primaryPage} />
            {table(primaryPage.items, '项目结果')}
            <NpiPagination label="项目概览底部翻页" {...primaryPage} />
          </div>
        )}
        {!!normal.length && (
          <div className="npi-normal-group">
            <button
              className="npi-normal-toggle"
              aria-expanded={normalExpanded}
              aria-controls="npi-normal-projects"
              onClick={() => setNormalExpanded(!normalExpanded)}
            >
              <ChevronRight
                size={18}
                className={normalExpanded ? 'expanded' : ''}
              />
              <strong>正常项目（{normal.length}）</strong>
              <span>{normalExpanded ? '收起' : '展开查看'}</span>
            </button>
            <div id="npi-normal-projects" hidden={!normalExpanded}>
              {normalExpanded && (
                <div ref={normalStart}>
                  <NpiPagination label="正常项目顶部翻页" {...normalPage} />
                  {table(normalPage.items, '正常项目')}
                  <NpiPagination label="正常项目底部翻页" {...normalPage} />
                </div>
              )}
            </div>
          </div>
        )}
        {!projects.length ? (
          <div className="npi-empty">
            <h3>
              {view === 'manufacturing' && actor.role !== 'admin'
                ? '当前没有本人负责制造的项目'
                : '开始第一个新品项目'}
            </h3>
            <p>指定技术与制造负责人，再导入ERP BOM，即可跟踪样机齐套。</p>
            {['admin', 'technical'].includes(actor.role) && (
              <button className="npi-button" onClick={onCreate}>
                新建新品
              </button>
            )}
          </div>
        ) : (
          !selected.length && (
            <div className="npi-empty">
              <h3>没有符合筛选条件的项目</h3>
              <p>
                {exceptionsOnly
                  ? '当前没有匹配的异常项目，可取消“仅看异常”或调整搜索。'
                  : '请调整搜索或状态筛选。'}
              </p>
            </div>
          )
        )}
      </section>
      <NpiDashboardBriefs projects={projects} onOpen={onOpen} />

      {!!projects.length && (
        <NpiActivity
          showChanges={false}
          dashboard={scopedDashboard}
          onOpen={onOpen}
        />
      )}
      <p className="npi-footnote">
        项目按逾期 → 风险 → 待回复 →
        正常排序；日期采用北京时间。点击指标会清除搜索与“仅看异常”，展示对应项目；本月样机包含已完成项目。
      </p>
    </>
  )
}
