// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { eventGroups } from '../../lib/npi/event-labels'
import { NpiPagination, usePagination } from './NpiPagination'
import { NpiProjectEventDetail } from './NpiProjectEventDetail'
import type { ReactNode } from 'react'
import type { ProjectDetail } from '../../lib/npi/service'
import type { ProjectEventsPage } from '../../lib/npi/project-events'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
const initialFilter = { q: '', category: 'all', from: '', to: '' }
export function NpiProjectHistory({
  project,
  api,
  children,
}: {
  project: ProjectDetail
  api: Api
  children?: ReactNode
}) {
  const [query, setQuery] = useState(''),
    [kind, setKind] = useState('all'),
    [order, setOrder] = useState('newest')
  const promiseStart = useRef<HTMLDivElement>(null)
  const itemMap = useMemo(
    () => new Map(project.items.map((i) => [i.id, i])),
    [project.items],
  )
  const promises = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    const filtered = project.history.filter((h) => {
      const item = itemMap.get(h.objectId),
        first = !h.oldCommittedDate
      return (
        (kind === 'all' ||
          (kind === 'first'
            ? first
            : !first && h.oldCommittedDate !== h.newCommittedDate)) &&
        (!q ||
          [
            item?.name,
            item?.bomReference?.materialCode,
            h.actorName,
            h.reason,
            h.oldCommittedDate,
            h.newCommittedDate,
          ]
            .filter(Boolean)
            .join(' ')
            .toLocaleLowerCase()
            .includes(q))
      )
    })
    // The service orders by full database timestamps; do not reorder millisecond ties in the browser.
    return order === 'newest' ? filtered.reverse() : filtered
  }, [project.history, itemMap, query, kind, order])
  const pagination = usePagination(promises, 25, promiseStart)
  const [draft, setDraft] = useState(initialFilter),
    [filter, setFilter] = useState(initialFilter)
  const [before, setBefore] = useState<string | null>(null),
    [stack, setStack] = useState<Array<string | null>>([]),
    [revision, setRevision] = useState(0)
  const requestKey = JSON.stringify([
    project.id,
    filter,
    before,
    revision,
    project.events.map((event) => event.id),
  ])
  const [result, setResult] = useState<{
    key: string
    page: ProjectEventsPage
  } | null>(null)
  const [failure, setFailure] = useState<{
    key: string
    message: string
  } | null>(null)
  const page = result?.key === requestKey ? result.page : null
  const error = failure?.key === requestKey ? failure.message : ''
  const loading = !page && !error
  useEffect(() => {
    let active = true
    const params = new URLSearchParams({ ...filter, limit: '25' })
    if (before) params.set('before', before)
    void api<ProjectEventsPage>(`/projects/${project.id}/events?${params}`)
      .then((nextPage) => {
        if (active) {
          setResult({ key: requestKey, page: nextPage })
          setFailure(null)
        }
      })
      .catch((cause) => {
        if (active)
          setFailure({
            key: requestKey,
            message:
              cause instanceof Error ? cause.message : '读取动态失败，请重试。',
          })
      })
    return () => {
      active = false
    }
  }, [api, requestKey, project.id, filter, before])
  const newest = () => {
    setBefore(null)
    setStack([])
    setRevision((r) => r + 1)
  }
  const eventStart = useRef<HTMLDivElement>(null)
  const promisePanel = useRef<HTMLElement>(null),
    eventPanel = useRef<HTMLElement>(null)
  const scrollTo = (target: HTMLElement | null) =>
    requestAnimationFrame(() => {
      if (!target?.isConnected) return
      const header = document.querySelector<HTMLElement>('.npi-project-summary')
      target.style.scrollMarginTop = `${header && getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().height + 12 : 12}px`
      target.scrollIntoView({ behavior: 'instant', block: 'start' })
    })
  const eventNavigation = (label: string) => (
    <nav className="npi-pagination" aria-label={label}>
      <span role="status">
        第{stack.length + 1}页
        {page
          ? ` · 本页${page.items.length}条${!page.nextCursor ? ' · 当前条件下已无更早记录' : ''}`
          : loading
            ? ' · 正在读取'
            : ''}
      </span>
      <div>
        <button
          type="button"
          className="npi-button secondary"
          disabled={loading}
          onClick={newest}
        >
          最新记录
        </button>
        <button
          type="button"
          className="npi-button secondary"
          disabled={loading || !stack.length}
          onClick={() => {
            setBefore(stack.at(-1)!)
            setStack(stack.slice(0, -1))
            scrollTo(eventStart.current)
          }}
        >
          上一页
        </button>
        <button
          type="button"
          className="npi-button secondary"
          disabled={loading || !page?.nextCursor}
          onClick={() => {
            setStack([...stack, before])
            setBefore(page!.nextCursor)
            scrollTo(eventStart.current)
          }}
        >
          更早记录
        </button>
      </div>
    </nav>
  )
  return (
    <>
      <nav className="npi-history-jump" aria-label="历史区域跳转">
        <button
          type="button"
          className="npi-button secondary"
          onClick={() => scrollTo(promisePanel.current)}
        >
          承诺历史
        </button>
        <button
          type="button"
          className="npi-button secondary"
          onClick={() => scrollTo(eventPanel.current)}
        >
          项目动态
        </button>
      </nav>
      <section
        className="npi-panel npi-project-history-panel"
        ref={promisePanel}
        aria-label="项目承诺历史"
      >
        <div className="npi-panel-title">
          <div>
            <h2>承诺历史</h2>
            <p>首次承诺和每次改期均保留；可按物料、回复人、日期或原因查找。</p>
          </div>
          <span>
            符合条件 {promises.length} 条 · 项目共 {project.history.length} 条
          </span>
        </div>
        <div className="npi-module-filters">
          <label>
            查找承诺
            <input
              type="search"
              aria-label="承诺历史搜索"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="物料 / 编码 / 回复人 / 原因"
            />
          </label>
          <label>
            记录类型
            <select
              aria-label="承诺记录类型"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="all">全部承诺</option>
              <option value="first">首次回复</option>
              <option value="changes">日期改期</option>
            </select>
          </label>
          <label>
            时间顺序
            <select
              aria-label="承诺时间顺序"
              value={order}
              onChange={(e) => setOrder(e.target.value)}
            >
              <option value="newest">最新在前</option>
              <option value="oldest">最早在前</option>
            </select>
          </label>
        </div>
        <NpiPagination label="承诺历史顶部翻页" {...pagination} />
        <div ref={promiseStart}>
          {pagination.items.map((h) => (
            <article className="npi-history" key={h.id} data-promise-id={h.id}>
              <History size={18} />
              <div>
                <strong>
                  {itemMap.get(h.objectId)?.name || '历史事项'} ·{' '}
                  {h.oldCommittedDate || '首次回复'} → {h.newCommittedDate}
                </strong>
                <p>{h.reason}</p>
                <small>
                  {h.actorName} ·{' '}
                  {new Date(h.changedAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  })}
                </small>
              </div>
            </article>
          ))}
          {!promises.length && (
            <p className="npi-list-summary">
              {project.history.length
                ? '没有符合条件的承诺记录，请调整筛选。'
                : '暂无承诺记录，制造或采购回复后自动保留。'}
            </p>
          )}
        </div>
        <NpiPagination label="承诺历史分页" {...pagination} />
        {children}
      </section>
      <section
        className="npi-panel npi-project-history-panel"
        ref={eventPanel}
        aria-label="项目全部动态"
      >
        <div className="npi-panel-title">
          <div>
            <h2>项目动态</h2>
            <p>按发生时间查看全部项目记录，每页25条；日期按北京时间筛选。</p>
          </div>
        </div>
        <form
          className="npi-module-filters npi-event-filters"
          onSubmit={(e) => {
            e.preventDefault()
            setFilter({ ...draft, q: draft.q.trim() })
            setBefore(null)
            setStack([])
            setRevision((r) => r + 1)
          }}
        >
          <label>
            查找动态
            <input
              type="search"
              aria-label="项目动态搜索"
              value={draft.q}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              placeholder="事项 / 操作人 / 原因"
            />
          </label>
          <label>
            动态类型
            <select
              aria-label="项目动态类型"
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            >
              <option value="all">全部类型</option>
              {Object.entries(eventGroups).map(([key, g]) => (
                <option key={key} value={key}>
                  {g.label}
                </option>
              ))}
              <option value="other">其他记录</option>
            </select>
          </label>
          <label>
            开始日期
            <input
              type="date"
              aria-label="动态开始日期"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              aria-label="动态结束日期"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </label>
          <button type="submit" className="npi-button">
            查询动态
          </button>
          <button
            type="button"
            className="npi-button secondary"
            onClick={() => {
              setDraft(initialFilter)
              setFilter(initialFilter)
              newest()
            }}
          >
            清空筛选
          </button>
        </form>
        {eventNavigation('项目动态顶部翻页')}
        <div ref={eventStart} aria-busy={loading}>
          {loading && (
            <p role="status" className="npi-list-summary">
              正在读取项目动态…
            </p>
          )}
          {error && (
            <div role="alert" className="npi-list-summary">
              <p>{error}</p>
              <button
                type="button"
                className="npi-button secondary"
                onClick={() => setRevision((r) => r + 1)}
              >
                重试读取动态
              </button>
            </div>
          )}
          {page?.items.map((event) => (
            <NpiProjectEventDetail key={event.id} event={event} />
          ))}
          {page && !page.items.length && (
            <p className="npi-list-summary">
              没有符合条件的动态，请调整筛选或返回最新记录。
            </p>
          )}
        </div>
        {eventNavigation('项目动态分页')}
      </section>
    </>
  )
}
