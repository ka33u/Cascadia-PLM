// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useRef, useState } from 'react'
import {
  arrivalWindowDescription,
  compareExpectedArrival,
  isArrivalWindow,
  matchesArrivalWindow,
} from '../../lib/npi/procurement-arrival'
import { NpiPagination, usePagination } from './NpiPagination'
import type { ReactNode } from 'react'
import type { NpiTracking } from '../../lib/npi/service'

const filters = [
  ['all', '全部未完成'],
  ['pending_reply', '待我回复'],
  ['risk', '我的风险件'],
  ['overdue', '我的逾期件'],
  ['today', '今日到货'],
  ['7', '未来7天到货'],
  ['14', '未来14天到货'],
  ['completed', '已完成'],
] as const
const priority = ['overdue', 'risk', 'pending_reply', 'normal', 'completed']

const matches = (i: NpiTracking, key: string, today: string) =>
  key === 'all'
    ? i.status !== 'completed'
    : isArrivalWindow(key)
      ? matchesArrivalWindow(i, today, key)
      : i.status === key

export function NpiProcurementWorkbench({
  items,
  today,
  renderTable,
}: {
  items: Array<NpiTracking>
  today: string
  renderTable: (rows: Array<NpiTracking>) => ReactNode
}) {
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const start = useRef<HTMLElement>(null)
  const rows = useMemo(
    () =>
      items
        .filter(
          (i) =>
            matches(i, filter, today) &&
            [
              i.bomReference?.materialCode,
              i.name,
              i.projectCode,
              i.projectName,
              i.specification,
              i.supplier,
              i.remark,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(search.trim().toLowerCase()),
        )
        .sort(
          (a, b) =>
            (isArrivalWindow(filter) ? compareExpectedArrival(a, b) : 0) ||
            priority.indexOf(a.status) - priority.indexOf(b.status) ||
            a.requiredDate.localeCompare(b.requiredDate) ||
            a.name.localeCompare(b.name, 'zh-CN') ||
            a.id.localeCompare(b.id),
        ),
    [items, filter, search, today],
  )
  const pagination = usePagination(rows, 25, start)
  return (
    <>
      <div
        className="npi-kit-metrics npi-purchase-metrics"
        role="group"
        aria-label="我的采购待办统计"
      >
        {[
          ['pending_reply', '待我回复', '需要给出到货承诺'],
          ['overdue', '我的逾期件', '承诺已过，尚未到货'],
          ['risk', '我的风险件', '承诺晚于要求日期'],
          ['all', '全部未完成', '含已有正常承诺的采购件'],
        ].map(([key, label, note]) => (
          <button
            key={key}
            aria-label={label}
            aria-pressed={filter === key}
            onClick={() => {
              setFilter(key!)
              setSearch('')
            }}
          >
            <span>{label}</span>
            <strong>
              {items.filter((i) => matches(i, key!, today)).length}
            </strong>
            <small>{note}</small>
          </button>
        ))}
      </div>
      <section
        ref={start}
        className="npi-panel npi-purchase-panel"
        aria-label="我的采购件清单"
      >
        <div className="npi-panel-title">
          <div>
            <h2>我的采购件</h2>
            <p>
              {isArrivalWindow(filter)
                ? '按当前承诺到货日期从近到远，方便安排收货。'
                : '逾期、风险、待回复优先；同类按要求日期排序。'}
            </p>
          </div>
          <select
            aria-label="采购筛选"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            {filters.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {isArrivalWindow(filter) && (
          <p className="npi-list-summary">
            {arrivalWindowDescription(today, filter)}
          </p>
        )}
        <div className="npi-material-filters">
          <label>
            <span className="sr-only">搜索我的采购件</span>
            <input
              type="search"
              aria-label="搜索我的采购件"
              placeholder="搜索编码 / 项目 / 物料 / 供应商"
              value={search}
              maxLength={200}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <span role="status">筛选结果 {rows.length} 项</span>
          {(search || filter !== 'all') && (
            <button
              className="npi-button secondary"
              onClick={() => {
                setSearch('')
                setFilter('all')
              }}
            >
              重置筛选
            </button>
          )}
        </div>
        <NpiPagination label="采购清单顶部翻页" {...pagination} />
        {rows.length ? (
          renderTable(pagination.items)
        ) : (
          <div className="npi-empty">
            <h3>当前没有符合条件的采购件</h3>
            <p>
              {items.length
                ? '可清空搜索或切换待办分类，查看其他采购件。'
                : '分配给你的采购件会显示在这里。'}
            </p>
          </div>
        )}
        <NpiPagination label="采购清单分页" {...pagination} />
      </section>
    </>
  )
}
