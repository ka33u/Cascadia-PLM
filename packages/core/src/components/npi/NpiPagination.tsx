// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export function usePagination<T>(
  rows: ReadonlyArray<T>,
  pageSize = 100,
  scrollTarget?: RefObject<HTMLElement | null>,
) {
  const [cursor, setCursor] = useState({ source: rows, page: 1 })
  const scrollFrame = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (scrollFrame.current !== null)
        cancelAnimationFrame(scrollFrame.current)
    },
    [],
  )
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const page = cursor.source === rows ? Math.min(cursor.page, pageCount) : 1
  const onPage = (next: number) => {
    if (!Number.isFinite(next)) return
    const nextPage = Math.max(1, Math.min(pageCount, Math.floor(next)))
    if (nextPage === page) return
    setCursor({
      source: rows,
      page: nextPage,
    })
    const target = scrollTarget?.current
    if (!target) return
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null
      if (!target.isConnected || target !== scrollTarget.current) return
      const header = document.querySelector<HTMLElement>('.npi-project-summary')
      const offset =
        !target.closest('[role="dialog"]') &&
        header &&
        getComputedStyle(header).position === 'sticky'
          ? header.getBoundingClientRect().height
          : 0
      target.style.scrollMarginTop = `${offset + 12}px`
      target.scrollTop = 0
      target.scrollIntoView({
        block: 'start',
        inline: 'nearest',
        behavior: 'instant',
      })
    })
  }
  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    pageSize,
    pageCount,
    onPage,
  }
}
export function NpiPagination({
  label,
  total,
  page,
  pageSize,
  pageCount,
  onPage,
  disabled = false,
}: {
  label: string
  total: number
  page: number
  pageSize: number
  pageCount: number
  onPage: (page: number) => void
  disabled?: boolean
}) {
  if (total <= pageSize) return null
  return (
    <nav className="npi-pagination" aria-label={label}>
      <span role="status">
        第{page}/{pageCount}页 · 显示{(page - 1) * pageSize + 1}–
        {Math.min(page * pageSize, total)}行，共{total}行
      </span>
      <div>
        <button
          type="button"
          className="npi-button secondary"
          disabled={disabled || page === 1}
          onClick={() => onPage(1)}
        >
          首页
        </button>
        <button
          type="button"
          className="npi-button secondary"
          disabled={disabled || page === 1}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </button>
        <label>
          跳至{' '}
          <select
            aria-label={`${label}页码`}
            value={page}
            disabled={disabled}
            onChange={(e) => onPage(Number(e.target.value))}
          >
            {Array.from({ length: pageCount }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>{' '}
          页
        </label>
        <button
          type="button"
          className="npi-button secondary"
          disabled={disabled || page === pageCount}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </button>
        <button
          type="button"
          className="npi-button secondary"
          disabled={disabled || page === pageCount}
          onClick={() => onPage(pageCount)}
        >
          末页
        </button>
      </div>
    </nav>
  )
}
