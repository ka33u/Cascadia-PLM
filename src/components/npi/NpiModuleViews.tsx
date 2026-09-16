// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useRef, useState } from 'react'
import { nodeNames } from '../../lib/npi/domain'
import {
  arrivalWindowDescription,
  compareExpectedArrival,
  matchesArrivalWindow,
} from '../../lib/npi/procurement-arrival'
import {
  dashboardMetrics,
  projectCompletion,
} from '../../lib/npi/project-dashboard'
import { NpiPagination, usePagination } from './NpiPagination'
import { NpiActivity } from './NpiActivity'
import { NpiAssignedMaterials } from './NpiAssignedMaterials'
import { stageLabels, stateLabels } from './navigation'
import type { ArrivalWindow } from '../../lib/npi/procurement-arrival'
import type { NpiDashboard, NpiMetadata } from '../../lib/npi/service'

type Project = NpiDashboard['projects'][number]
type Open = (id: string, tab?: string, itemId?: string) => void
const byRisk: Record<string, number> = {
  overdue: 0,
  risk: 1,
  pending_reply: 2,
  normal: 3,
  completed: 4,
}
const badge = (status: string) => (
  <span className={`npi-badge npi-${status}`}>
    {stateLabels[status] || status}
  </span>
)
const contains = (query: string, ...values: Array<string | null | undefined>) =>
  values.join(' ').toLowerCase().includes(query.trim().toLowerCase())
const identity = (p: Project) => (
  <small>
    {p.code} · {p.motorModel}
  </small>
)

export function NpiProjectLibrary({
  dashboard,
  mode,
  onOpen,
}: {
  dashboard: NpiDashboard
  mode: 'projects' | 'bom'
  onOpen: Open
}) {
  const [query, setQuery] = useState(''),
    [stage, setStage] = useState('all'),
    [bomState, setBomState] = useState('all')
  const start = useRef<HTMLDivElement>(null)
  const rows = useMemo(
    () =>
      dashboard.projects
        .filter(
          (p) =>
            contains(query, p.name, p.code, p.motorModel) &&
            (stage === 'all' || p.currentNpiStage === stage) &&
            (mode !== 'bom' ||
              bomState === 'all' ||
              (bomState === 'missing'
                ? !p.activeBomImportId
                : bomState === 'review'
                  ? p.bomReviewCount > 0
                  : !!p.activeBomImportId)),
        )
        .sort((a, b) =>
          a.code.localeCompare(b.code, 'zh-CN', { numeric: true }),
        ),
    [dashboard, query, stage, bomState, mode],
  )
  const pagination = usePagination(rows, 25, start)
  return (
    <section
      className="npi-panel"
      aria-label={mode === 'bom' ? '项目BOM管理' : '新品项目目录'}
    >
      <div className="npi-panel-title">
        <h2>{mode === 'bom' ? '项目BOM版本' : '项目目录'}</h2>
        <span>共 {rows.length} 个项目</span>
      </div>
      <div className="npi-module-filters">
        <label>
          查找项目
          <input
            type="search"
            aria-label="模块项目搜索"
            placeholder="项目名称 / 编号 / 型号"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label>
          项目阶段
          <select
            aria-label="模块项目阶段"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
          >
            <option value="all">全部阶段</option>
            {Object.entries(stageLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {mode === 'bom' && (
          <label>
            BOM状态
            <select
              aria-label="项目BOM状态"
              value={bomState}
              onChange={(e) => setBomState(e.target.value)}
            >
              <option value="all">全部</option>
              <option value="missing">尚未导入</option>
              <option value="imported">已有BOM</option>
              <option value="review">换版待复核</option>
            </select>
          </label>
        )}
      </div>
      <div ref={start} className="npi-table-scroll">
        <table className="npi-table npi-tracking-table">
          <thead>
            <tr>
              <th>新品项目</th>
              <th>阶段</th>
              {mode === 'bom' ? (
                <>
                  <th>当前BOM</th>
                  <th>版本与复核</th>
                </>
              ) : (
                <>
                  <th>样机要求</th>
                  <th>要求齐套</th>
                  <th>状态</th>
                </>
              )}
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {pagination.items.map((p) => {
              const active = p.imports.find((i) => i.id === p.activeBomImportId)
              return (
                <tr key={p.id}>
                  <td data-label="新品项目">
                    <strong>{p.name}</strong>
                    {identity(p)}
                  </td>
                  <td data-label="阶段">{stageLabels[p.currentNpiStage]}</td>
                  {mode === 'bom' ? (
                    <>
                      <td data-label="当前BOM">
                        {active
                          ? `V${active.versionNo} · ${active.rowCount}项`
                          : '尚未导入'}
                        <small>{active?.sourceName}</small>
                      </td>
                      <td data-label="版本与复核">
                        {p.imports.length} 个版本
                        <small
                          className={p.bomReviewCount ? 'npi-warning-text' : ''}
                        >
                          {p.bomReviewCount
                            ? `${p.bomReviewCount}项旧跟踪待复核`
                            : '无待复核项'}
                        </small>
                      </td>
                    </>
                  ) : (
                    <>
                      <td data-label="样机要求">{p.prototypeRequiredDate}</td>
                      <td data-label="要求齐套">{p.requiredKitDate}</td>
                      <td data-label="状态">{badge(p.riskStatus)}</td>
                    </>
                  )}
                  <td data-label="操作">
                    <button
                      className="npi-project-link"
                      onClick={() =>
                        onOpen(p.id, mode === 'bom' ? 'bom' : 'overview')
                      }
                    >
                      {mode === 'bom' ? '进入BOM' : '项目详情'} ↗
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!rows.length && (
          <p className="npi-module-empty">没有匹配的项目，请调整搜索或筛选。</p>
        )}
      </div>
      <NpiPagination
        label={mode === 'bom' ? 'BOM项目分页' : '项目目录分页'}
        {...pagination}
      />
    </section>
  )
}

export function NpiPreparationBoard({
  dashboard,
  actor,
  mode,
  onOpen,
  onReply,
  onComplete,
  users = [],
}: {
  dashboard: NpiDashboard
  actor: NpiMetadata['actor']
  mode: 'manufacturing' | 'purchasing'
  onOpen: Open
  onReply: (id: string) => void
  onComplete: (id: string) => void
  users?: NpiMetadata['users']
}) {
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState('unfinished'),
    [kind, setKind] = useState('all'),
    [purchaseOwner, setPurchaseOwner] = useState('all'),
    [arrival, setArrival] = useState<ArrivalWindow>('all'),
    [mine, setMine] = useState(
      mode === 'manufacturing' && actor.role === 'manufacturing',
    )
  const start = useRef<HTMLDivElement>(null)
  const all = useMemo(
    () =>
      dashboard.projects.flatMap((p) =>
        p.items
          .filter((i) =>
            mode === 'manufacturing'
              ? i.sourceType === 'MANUFACTURING'
              : i.trackingType === 'purchase' &&
                (i.trackingEnabled || i.affectsKit),
          )
          .map((item) => ({ project: p, item })),
      ),
    [dashboard, mode],
  )
  const purchaseOwners = useMemo(() => {
    if (mode !== 'purchasing') return []
    const people = new Map(users.map((user) => [user.id, user]))
    return [
      ...new Map(
        all.map(({ item }) => {
          const person = people.get(item.ownerId)
          return [
            item.ownerId,
            {
              id: item.ownerId,
              label: `${item.ownerName || person?.name || '未命名用户'}${person?.email ? ` · ${person.email}` : ''}`,
            },
          ]
        }),
      ).values(),
    ].sort(
      (a, b) =>
        a.label.localeCompare(b.label, 'zh-CN') || a.id.localeCompare(b.id),
    )
  }, [all, users, mode])
  const scoped = useMemo(
    () =>
      all.filter(
        ({ project: p, item: i }) =>
          contains(
            query,
            p.name,
            p.code,
            p.motorModel,
            i.name,
            i.ownerName,
            i.bomReference?.materialCode,
          ) &&
          (!mine || i.ownerId === actor.id) &&
          (kind === 'all' || i.trackingType === kind) &&
          (mode !== 'purchasing' ||
            ((purchaseOwner === 'all' || i.ownerId === purchaseOwner) &&
              matchesArrivalWindow(i, dashboard.todayActivity.day, arrival))),
      ),
    [
      all,
      query,
      mine,
      kind,
      actor.id,
      mode,
      purchaseOwner,
      arrival,
      dashboard.todayActivity.day,
    ],
  )
  const rows = useMemo(
    () =>
      scoped
        .filter(
          ({ project: p, item: i }) =>
            status === 'all' ||
            (status === 'unfinished'
              ? !i.actualCompleteDate && p.currentNpiStage !== 'completed'
              : i.status === status),
        )
        .sort(
          (a, b) =>
            (mode === 'purchasing' && arrival !== 'all'
              ? compareExpectedArrival(a.item, b.item)
              : 0) ||
            (byRisk[a.item.status] ?? 5) - (byRisk[b.item.status] ?? 5) ||
            a.item.requiredDate.localeCompare(b.item.requiredDate) ||
            a.project.code.localeCompare(b.project.code),
        ),
    [scoped, status, mode, arrival],
  )
  const pagination = usePagination(rows, 25, start)
  return (
    <>
      {mode === 'manufacturing' && actor.role === 'manufacturing' && (
        <NpiAssignedMaterials
          actorId={actor.id}
          revision={dashboard}
          managedProjectIds={dashboard.projects.map((p) => p.id)}
        />
      )}
      <section
        className="npi-panel"
        aria-label={
          mode === 'manufacturing' ? '制造四节点任务' : '采购物料任务'
        }
      >
        <div className="npi-panel-title">
          <div>
            <h2>
              {mode === 'manufacturing' ? '制造四节点任务' : '采购物料任务'}
            </h2>
            <p>
              {mode === 'manufacturing'
                ? '直接回复四节点日期或确认完成，进入项目可追溯完整历史。'
                : '按责任人跟进采购交期，进入物料可查看承诺及到货资料。'}
            </p>
          </div>
          <span>共 {rows.length} 项</span>
        </div>
        <div className="npi-module-counts">
          {Object.entries(stateLabels).map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >
              {label}{' '}
              <strong>
                {scoped.filter((r) => r.item.status === value).length}
              </strong>
            </button>
          ))}
        </div>
        <div className="npi-module-filters">
          <label>
            查找任务
            <input
              type="search"
              aria-label="业务任务搜索"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="项目 / 物料 / 负责人"
            />
          </label>
          <label>
            任务状态
            <select
              aria-label="业务任务状态"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="unfinished">未完成</option>
              <option value="all">全部记录</option>
              {Object.entries(stateLabels).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {mode === 'manufacturing' && (
            <label>
              制造节点
              <select
                aria-label="制造节点筛选"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="all">四个节点</option>
                {Object.entries(nodeNames).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode === 'purchasing' && (
            <>
              <label className="npi-purchase-owner-filter">
                采购责任人
                <select
                  aria-label="采购责任人筛选"
                  value={purchaseOwner}
                  onChange={(e) => setPurchaseOwner(e.target.value)}
                  className="npi-purchase-owner-select"
                >
                  <option value="all">全部采购责任人</option>
                  {purchaseOwners.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                承诺到货范围
                <select
                  aria-label="采购到货范围"
                  value={arrival}
                  onChange={(e) => setArrival(e.target.value as ArrivalWindow)}
                >
                  <option value="all">不限到货日期</option>
                  <option value="today">今日到货</option>
                  <option value="7">未来7天到货</option>
                  <option value="14">未来14天到货</option>
                </select>
              </label>
              {(purchaseOwner !== 'all' || arrival !== 'all') && (
                <button
                  className="npi-button secondary"
                  onClick={() => {
                    setPurchaseOwner('all')
                    setArrival('all')
                  }}
                >
                  清除采购条件
                </button>
              )}
            </>
          )}
          <label className="npi-module-checkbox">
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => setMine(e.target.checked)}
            />
            仅本人负责
          </label>
        </div>
        {mode === 'purchasing' && arrival !== 'all' && (
          <p className="npi-list-summary">
            {arrivalWindowDescription(dashboard.todayActivity.day, arrival)}
          </p>
        )}
        <div ref={start} className="npi-table-scroll">
          <table className="npi-table npi-tracking-table">
            <thead>
              <tr>
                <th>项目 / 任务</th>
                <th>负责人</th>
                <th>要求日期</th>
                <th>首次承诺</th>
                <th>当前承诺</th>
                <th>实际完成</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagination.items.map(({ project: p, item: i }) => (
                <tr key={i.id} data-npi-task={i.id}>
                  <td data-label="项目 / 任务">
                    <strong>{i.name}</strong>
                    <small>
                      {p.name} · {p.code}
                    </small>
                    {mode === 'purchasing' && (
                      <small>
                        {i.sourceType === 'ERP_BOM' ? 'ERP BOM' : 'BOM外采购件'}
                      </small>
                    )}
                  </td>
                  <td data-label="负责人">{i.ownerName}</td>
                  <td data-label="要求日期">{i.requiredDate}</td>
                  <td data-label="首次承诺">{i.firstCommittedDate || '—'}</td>
                  <td data-label="当前承诺">
                    {i.currentCommittedDate || '待回复'}
                    <small>改期 {i.changeCount} 次</small>
                  </td>
                  <td data-label="实际完成">{i.actualCompleteDate || '—'}</td>
                  <td data-label="状态">{badge(i.status)}</td>
                  <td data-label="操作">
                    <div className="npi-row-actions">
                      <button
                        className="npi-project-link"
                        onClick={() => {
                          if (
                            mode === 'manufacturing' &&
                            p.currentNpiStage !== 'completed' &&
                            (actor.role === 'admin' ||
                              (['technical', 'manufacturing'].includes(
                                actor.role,
                              ) &&
                                actor.id === p.manufacturingOwnerId))
                          )
                            onReply(p.id)
                          else
                            onOpen(
                              p.id,
                              mode === 'manufacturing'
                                ? 'manufacturing'
                                : 'kit',
                              mode === 'purchasing' ? i.id : undefined,
                            )
                        }}
                      >
                        {mode === 'manufacturing'
                          ? p.currentNpiStage !== 'completed' &&
                            (actor.role === 'admin' ||
                              (['technical', 'manufacturing'].includes(
                                actor.role,
                              ) &&
                                actor.id === p.manufacturingOwnerId))
                            ? '集中回复'
                            : '查看制造准备'
                          : '查看采购物料'}{' '}
                        ↗
                      </button>
                      {mode === 'manufacturing' &&
                        !i.actualCompleteDate &&
                        p.currentNpiStage !== 'completed' &&
                        (actor.role === 'admin' ||
                          (['technical', 'manufacturing'].includes(
                            actor.role,
                          ) &&
                            actor.id === p.manufacturingOwnerId)) && (
                          <button
                            className="npi-project-link"
                            onClick={() => onComplete(p.id)}
                          >
                            确认完成
                          </button>
                        )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <p className="npi-module-empty">
              没有匹配的任务，请调整搜索、状态或负责人范围。
            </p>
          )}
        </div>
        <NpiPagination label="业务任务分页" {...pagination} />
      </section>
    </>
  )
}

export function NpiReports({
  dashboard,
  onOpen,
}: {
  dashboard: NpiDashboard
  onOpen: Open
}) {
  const [stage, setStage] = useState('all')
  const [query, setQuery] = useState('')
  const completeStart = useRef<HTMLDivElement>(null)
  const searched = useMemo(
    () =>
      dashboard.projects.filter((p) =>
        contains(query, p.name, p.code, p.motorModel),
      ),
    [dashboard, query],
  )
  const projects = useMemo(
    () =>
      searched.filter((p) => stage === 'all' || p.currentNpiStage === stage),
    [searched, stage],
  )
  const completed = useMemo(
    () => projects.filter((p) => p.currentNpiStage === 'completed'),
    [projects],
  )
  const completedPage = usePagination(completed, 25, completeStart)
  const metrics = dashboardMetrics(projects, dashboard.todayActivity.day)
  const ids = new Set(projects.map((p) => p.id))
  const scoped = {
    ...dashboard,
    projects,
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
  return (
    <div aria-label="新品报表" role="region">
      <section className="npi-panel">
        <div className="npi-panel-title">
          <h2>阶段与样机完成分析</h2>
          <span>{dashboard.todayActivity.day} · 北京时间</span>
        </div>
        <div className="npi-module-filters">
          <label>
            查找项目
            <input
              aria-label="报表项目搜索"
              type="search"
              placeholder="项目名称 / 编号 / 型号"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={200}
            />
          </label>
          <label>
            分析范围
            <select
              aria-label="报表阶段范围"
              value={stage}
              onChange={(e) => setStage(e.target.value)}
            >
              <option value="all">全部阶段</option>
              {Object.entries(stageLabels).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="npi-module-counts">
          <span>
            在研项目 <strong>{metrics.active}</strong>
          </span>
          <span>
            完成项目{' '}
            <strong>
              {projects.filter((p) => p.currentNpiStage === 'completed').length}
            </strong>
          </span>
          <span>
            完成项目按期率{' '}
            <strong>
              {metrics.onTimeRate == null ? '—' : `${metrics.onTimeRate}%`}
            </strong>
          </span>
        </div>
        <div className="npi-stage-distribution">
          {Object.entries(stageLabels).map(([value, label]) => (
            <button
              key={value}
              aria-pressed={stage === value}
              onClick={() => setStage(stage === value ? 'all' : value)}
            >
              <span>{label}</span>
              <strong>
                {searched.filter((p) => p.currentNpiStage === value).length}
              </strong>
            </button>
          ))}
        </div>
        <p className="npi-list-summary">
          按期率按已完成项目的样机装配实际日期计算；尚未记录实际日期的项目不计为按期。
        </p>
        <div ref={completeStart} className="npi-table-scroll">
          <table className="npi-table npi-tracking-table">
            <thead>
              <tr>
                <th>已完成项目</th>
                <th>样机要求</th>
                <th>样机实际</th>
                <th>完成结果</th>
              </tr>
            </thead>
            <tbody>
              {completedPage.items.map((p) => {
                const completion = projectCompletion(p)
                return (
                  <tr key={p.id}>
                    <td data-label="已完成项目">
                      <button
                        className="npi-project-link"
                        onClick={() => onOpen(p.id)}
                      >
                        {p.name} ↗
                      </button>
                      {identity(p)}
                    </td>
                    <td data-label="样机要求">{p.prototypeRequiredDate}</td>
                    <td data-label="样机实际">
                      {completion.actualDate || '未记录'}
                    </td>
                    <td data-label="完成结果">
                      {completion.onTime
                        ? '按期完成'
                        : completion.actualDate
                          ? '晚于要求'
                          : '待核对实际日期'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!projects.some((p) => p.currentNpiStage === 'completed') && (
            <p className="npi-module-empty">当前范围尚无已完成项目。</p>
          )}
        </div>
        <NpiPagination label="完成项目报表分页" {...completedPage} />
      </section>
      <NpiActivity
        dashboard={scoped}
        onOpen={(id, itemId) => onOpen(id, undefined, itemId)}
      />
    </div>
  )
}
