// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useRef, useState } from 'react'
import { NpiPagination, usePagination } from './NpiPagination'
import type { NpiDashboard } from '../../lib/npi/service'

const stamp = (value: Date | string) =>
  new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })
const matches = (query: string, r: { projectName: string; itemName: string }) =>
  `${r.projectName} ${r.itemName}`
    .toLowerCase()
    .includes(query.trim().toLowerCase())

export function NpiActivity({
  dashboard,
  onOpen,
  showChanges = true,
}: {
  showChanges?: boolean
  dashboard: NpiDashboard
  onOpen: (id: string, itemId?: string) => void
}) {
  const [kind, setKind] = useState<
    'newOverdue' | 'promiseChanges' | 'completions'
  >('newOverdue')
  const [minimum, setMinimum] = useState(2),
    [includeHistory, setIncludeHistory] = useState(false)
  const [query, setQuery] = useState('')
  const activityStart = useRef<HTMLDivElement>(null)
  const tasksStart = useRef<HTMLDivElement>(null)
  const activity = useMemo(
    () => ({
      ...dashboard.todayActivity,
      newOverdue: dashboard.todayActivity.newOverdue.filter((r) =>
        matches(query, r),
      ),
      promiseChanges: dashboard.todayActivity.promiseChanges.filter((r) =>
        matches(query, r),
      ),
      completions: dashboard.todayActivity.completions.filter((r) =>
        matches(query, r),
      ),
    }),
    [dashboard.todayActivity, query],
  )
  const tasks = useMemo(
    () =>
      !showChanges
        ? []
        : dashboard.projects
            .flatMap((p) =>
              p.items
                .filter(
                  (i) =>
                    i.changeCount >= minimum &&
                    (includeHistory ||
                      (p.currentNpiStage !== 'completed' &&
                        !i.actualCompleteDate &&
                        (i.trackingEnabled || i.affectsKit))),
                )
                .map((i) => ({ ...i, projectId: p.id, projectName: p.name })),
            )
            .filter((i) =>
              matches(query, { projectName: i.projectName, itemName: i.name }),
            )
            .sort(
              (a, b) =>
                b.changeCount - a.changeCount ||
                a.requiredDate.localeCompare(b.requiredDate) ||
                a.id.localeCompare(b.id),
            ),
    [dashboard.projects, minimum, includeHistory, query, showChanges],
  )
  const rows = useMemo(
    () =>
      kind === 'newOverdue'
        ? activity.newOverdue.map((r) => ({
            ...r,
            key: r.itemId,
            detail: `承诺 ${r.committedDate} · 要求 ${r.requiredDate}`,
            note: `当前责任人：${r.ownerName}`,
          }))
        : kind === 'promiseChanges'
          ? activity.promiseChanges.map((r) => ({
              ...r,
              key: r.id,
              detail: `${r.oldDate} → ${r.newDate}`,
              note: `${r.actorName} · ${stamp(r.changedAt)} · ${r.reason}`,
            }))
          : activity.completions.map((r) => ({
              ...r,
              key: r.id,
              detail: `实际完成 ${r.actualDate}`,
              note: `${r.actorName} · 确认于 ${stamp(r.confirmedAt)}`,
            })),
    [activity, kind],
  )
  const activityPage = usePagination<(typeof rows)[number]>(
    rows,
    25,
    activityStart,
  )
  const tasksPage = usePagination(tasks, 25, tasksStart)
  return (
    <div className="npi-activity">
      <div className="npi-filters">
        <label>
          项目 / 物料搜索{' '}
          <input
            type="search"
            aria-label="变化与改期任务搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="筛选下方变化与改期任务"
            maxLength={200}
            style={{
              maxWidth: '100%',
              padding: '8px 10px',
              border: '1px solid #dbe2ec',
              borderRadius: 6,
            }}
          />
        </label>
      </div>
      <section className="npi-panel" aria-label="今日变化">
        <div className="npi-panel-title">
          <div>
            <h2>今日变化</h2>
            <p>{activity.day} · 北京时间 · 物料与制造节点</p>
          </div>
        </div>
        <div className="npi-filters">
          {(
            [
              ['newOverdue', '新增逾期', activity.newOverdue.length],
              ['promiseChanges', '承诺变更', activity.promiseChanges.length],
              ['completions', '确认完成', activity.completions.length],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              className={kind === key ? 'active' : ''}
              aria-pressed={kind === key}
              onClick={() => setKind(key)}
            >
              {label} {count}
            </button>
          ))}
        </div>
        <p className="npi-muted">
          新增逾期为当前仍逾期、较前一日新出现的任务；承诺变更不含首次回复；完成按系统确认时间统计。
        </p>
        <NpiPagination label="今日变化顶部翻页" {...activityPage} />
        <div className="npi-table-scroll" ref={activityStart}>
          <table className="npi-table npi-tracking-table">
            <thead>
              <tr>
                <th>项目 / 物料或节点</th>
                <th>变化内容</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {activityPage.items.map((r) => (
                <tr key={r.key}>
                  <td data-label="项目 / 物料或节点">
                    <strong>{r.itemName}</strong>
                    <small>
                      {r.projectName} · {r.projectCode}
                    </small>
                  </td>
                  <td data-label="变化内容">
                    {r.detail}
                    <small>{r.note}</small>
                  </td>
                  <td data-label="操作">
                    <button
                      className="npi-project-link"
                      onClick={() => onOpen(r.projectId, r.itemId)}
                    >
                      定位事项
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <NpiPagination label="今日变化分页" {...activityPage} />
        {!rows.length && <p className="npi-muted">今天暂无此类变化。</p>}
      </section>
      {showChanges && (
        <section className="npi-panel" aria-label="承诺改期任务">
          <div className="npi-panel-title">
            <div>
              <h2>承诺改期任务</h2>
              <p>累计改期次数不含首次回复；保留原任务编号与历史。</p>
            </div>
          </div>
          <div className="npi-filters">
            <label>
              改期次数{' '}
              <select
                aria-label="改期次数筛选"
                value={minimum}
                onChange={(e) => setMinimum(Number(e.target.value))}
              >
                {[1, 2, 3, 5].map((n) => (
                  <option key={n} value={n}>
                    至少 {n} 次
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeHistory}
                onChange={(e) => setIncludeHistory(e.target.checked)}
              />{' '}
              包含已完成 / 停止跟踪
            </label>
            <span>共 {tasks.length} 项</span>
          </div>
          <NpiPagination label="承诺改期顶部翻页" {...tasksPage} />
          <div className="npi-table-scroll" ref={tasksStart}>
            <table className="npi-table npi-tracking-table">
              <thead>
                <tr>
                  <th>项目 / 物料或节点</th>
                  <th>责任人</th>
                  <th>首次承诺</th>
                  <th>当前承诺</th>
                  <th>改期次数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {tasksPage.items.map((i) => (
                  <tr key={i.id}>
                    <td data-label="项目 / 物料或节点">
                      <strong>{i.name}</strong>
                      <small>
                        {i.projectName}
                        {!(i.trackingEnabled || i.affectsKit)
                          ? ' · 已停止跟踪'
                          : i.actualCompleteDate
                            ? ' · 已完成'
                            : ''}
                      </small>
                    </td>
                    <td data-label="责任人">{i.ownerName}</td>
                    <td data-label="首次承诺">{i.firstCommittedDate || '—'}</td>
                    <td data-label="当前承诺">
                      {i.currentCommittedDate || '—'}
                    </td>
                    <td data-label="改期次数">{i.changeCount} 次</td>
                    <td data-label="操作">
                      <button
                        className="npi-project-link"
                        onClick={() => onOpen(i.projectId, i.id)}
                      >
                        定位事项
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <NpiPagination label="承诺改期分页" {...tasksPage} />
          {!tasks.length && (
            <p className="npi-muted">没有符合次数与状态筛选的任务。</p>
          )}
        </section>
      )}
    </div>
  )
}
