// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useRef, useState } from 'react'
import { NpiPagination, usePagination } from './NpiPagination'
import type { NpiDashboard } from '../../lib/npi/service'

type Brief = {
  id: string
  projectId: string
  itemId?: string
  title: string
  search: string
  status: string
  detail: string
  date?: string
}
type Open = (projectId: string, itemId?: string) => void

function BriefList({
  rows,
  kind,
  onOpen,
}: {
  rows: Array<Brief>
  kind: 'todos' | 'warnings'
  onOpen: Open
}) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const start = useRef<HTMLDivElement>(null)
  const label = kind === 'todos' ? '今日待办' : '风险预警'
  const filtered = useMemo(() => {
    if (!expanded) return rows
    const text = query.trim().toLocaleLowerCase()
    return rows.filter(
      (r) =>
        (status === 'all' || r.status === status) &&
        r.search.toLocaleLowerCase().includes(text),
    )
  }, [rows, expanded, query, status])
  const page = usePagination(filtered, 25, start)
  const visible = expanded ? page.items : rows.slice(0, 5)
  const toggle = () => {
    setExpanded(!expanded)
    setQuery('')
    setStatus('all')
  }
  return (
    <section className="npi-panel npi-dashboard-brief" aria-label={label}>
      <div className="npi-panel-title">
        <div>
          <h2>
            {label}（{rows.length}）
          </h2>
          <p>
            {kind === 'todos'
              ? '待回复与逾期任务，按要求日期排序'
              : '逾期与风险项目，点击进入项目明细'}
          </p>
        </div>
        {(rows.length > 5 || expanded) && (
          <button
            type="button"
            className="npi-project-link"
            aria-expanded={expanded}
            aria-controls={`npi-${kind}-list`}
            onClick={toggle}
          >
            {expanded ? '收起' : '查看全部'}
            {kind === 'todos' ? '待办' : '预警'}
          </button>
        )}
      </div>
      {expanded && (
        <div className="npi-module-filters">
          <label>
            搜索{kind === 'todos' ? '任务' : '预警'}
            <input
              type="search"
              aria-label={`${label}搜索`}
              placeholder={
                kind === 'todos'
                  ? '项目 / 事项 / 责任人'
                  : '项目 / 型号 / 风险内容'
              }
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label>
            状态
            <select
              aria-label={`${label}状态`}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">全部</option>
              <option value="overdue">逾期</option>
              {kind === 'todos' ? (
                <option value="pending_reply">待回复</option>
              ) : (
                <option value="risk">风险</option>
              )}
            </select>
          </label>
        </div>
      )}
      <p className="npi-muted" role="status">
        {expanded
          ? `符合条件 ${filtered.length} 条 · 每页25条`
          : rows.length > 5
            ? `显示前5条，共${rows.length}条`
            : `共${rows.length}条`}
      </p>
      {expanded && <NpiPagination label={`${label}顶部翻页`} {...page} />}
      <div className="npi-work-brief" id={`npi-${kind}-list`} ref={start}>
        {visible.map((row) => (
          <button
            type="button"
            key={row.id}
            data-brief-id={row.id}
            onClick={() => onOpen(row.projectId, row.itemId)}
          >
            <span
              className={
                row.status === 'overdue'
                  ? 'danger'
                  : row.status === 'risk'
                    ? 'warning'
                    : 'pending'
              }
              aria-hidden="true"
            >
              ●
            </span>
            <div>
              <strong>{row.title}</strong>
              <small>{row.detail}</small>
              {row.date && <small>{row.date}</small>}
            </div>
            <span aria-hidden="true">↗</span>
          </button>
        ))}
        {!visible.length && (
          <p>
            {rows.length
              ? '没有符合条件的记录，请调整搜索或状态。'
              : kind === 'todos'
                ? '当前没有待回复或逾期任务。'
                : '当前没有风险或逾期项目。'}
          </p>
        )}
      </div>
      {expanded && <NpiPagination label={`${label}底部翻页`} {...page} />}
    </section>
  )
}

export function NpiDashboardBriefs({
  projects,
  onOpen,
}: {
  projects: NpiDashboard['projects']
  onOpen: Open
}) {
  const todos = useMemo(
    () =>
      projects
        .filter((p) => p.currentNpiStage !== 'completed')
        .flatMap((p) =>
          p.items
            .filter(
              (i) =>
                (i.trackingEnabled || i.affectsKit) &&
                !i.actualCompleteDate &&
                ['pending_reply', 'overdue'].includes(i.status),
            )
            .map((i) => ({
              id: i.id,
              projectId: p.id,
              itemId: i.id,
              title: `${p.name} · ${i.name}`,
              search: `${p.name} ${p.code} ${p.motorModel} ${i.name} ${i.ownerName}`,
              status: i.status,
              detail: `${i.ownerName || '未指定责任人'} · ${i.status === 'overdue' ? '承诺已逾期' : '等待回复'}`,
              date: `要求 ${i.requiredDate} · 承诺 ${i.currentCommittedDate || '待回复'}`,
              requiredDate: i.requiredDate,
            })),
        )
        .sort(
          (a, b) =>
            a.requiredDate.localeCompare(b.requiredDate) ||
            a.id.localeCompare(b.id),
        ),
    [projects],
  )
  const warnings = useMemo(
    () =>
      projects
        .filter(
          (p) =>
            p.currentNpiStage !== 'completed' &&
            ['overdue', 'risk'].includes(p.riskStatus),
        )
        .sort(
          (a, b) =>
            Number(b.riskStatus === 'overdue') -
              Number(a.riskStatus === 'overdue') ||
            a.prototypeRequiredDate.localeCompare(b.prototypeRequiredDate) ||
            a.code.localeCompare(b.code),
        )
        .map((p) => {
          const detail =
            p.kit.alerts.find((a) => a.code !== 'PENDING_REPLY')?.message ||
            (p.riskStatus === 'overdue'
              ? '存在逾期未完成项，请查看项目明细'
              : '承诺晚于要求，请查看项目明细')
          return {
            id: p.id,
            projectId: p.id,
            title: p.name,
            status: p.riskStatus,
            search: `${p.name} ${p.code} ${p.motorModel} ${detail} ${p.kit.bottleneck?.name || ''} ${p.kit.bottleneck?.ownerName || ''}`,
            detail,
            date: `样机要求 ${p.prototypeRequiredDate} · ${p.riskStatus === 'overdue' ? '逾期' : '风险'}`,
          }
        }),
    [projects],
  )
  return (
    <div className="npi-dashboard-briefs">
      <BriefList rows={todos} kind="todos" onOpen={onOpen} />
      <BriefList rows={warnings} kind="warnings" onOpen={onOpen} />
    </div>
  )
}
