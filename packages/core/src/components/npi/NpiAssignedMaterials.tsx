// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import { NpiPagination, usePagination } from './NpiPagination'
import { NpiTrackingHistory } from './NpiTrackingHistory'
import { NpiFiles } from './NpiFiles'
import { useNpiFileOperation } from './useNpiFileOperation'
import type { FormEvent } from 'react'
import type { assignedMaterials } from '../../lib/npi/service'

type Work = Awaited<ReturnType<typeof assignedMaterials>>
type Item = Work['items'][number]
const labels: Record<string, string> = {
  pending_reply: '待回复',
  normal: '正常',
  risk: '风险',
  overdue: '逾期',
  completed: '已完成',
}
export function NpiAssignedMaterials({
  actorId,
  revision,
  managedProjectIds,
}: {
  actorId: string
  revision: object
  managedProjectIds: Array<string>
}) {
  const [data, setData] = useState<Work | null>(null)
  const [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState(''),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('unfinished')
  const [editing, setEditing] = useState<{
    item: Item
    complete: boolean
  } | null>(null)
  const [fileItem, setFileItem] = useState<Item | null>(null)
  const fileOperation = useNpiFileOperation(fileItem?.id || null)
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState('')
  const pending = useRef(false),
    generation = useRef(0),
    start = useRef<HTMLElement>(null)
  const api = useCallback(
    async <T,>(url: string, method = 'GET', body?: unknown): Promise<T> => {
      const multipart = body instanceof FormData
      const response = await fetch('/api/v1/npi' + url, {
        method,
        headers: {
          ...(!multipart ? { 'Content-Type': 'application/json' } : {}),
          'x-npi-actor': actorId,
        },
        body:
          body === undefined
            ? undefined
            : multipart
              ? body
              : JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || '请求失败，请重试')
      return result as T
    },
    [actorId],
  )
  const refresh = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    setLoadError('')
    try {
      const result = await api<Work>('/workbench/materials')
      if (current !== generation.current) return
      if (result.actorId !== actorId)
        throw new Error('登录账号已改变，请整页刷新')
      setData(result)
    } catch (error) {
      if (current === generation.current)
        setLoadError(
          error instanceof Error ? error.message : '读取物料待办失败',
        )
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [actorId, api])
  useEffect(() => {
    void refresh()
    return () => {
      generation.current++
    }
  }, [refresh, revision])
  const delegated = useMemo(() => {
    const managed = new Set(managedProjectIds)
    return (data?.items || []).filter((item) => !managed.has(item.programId))
  }, [data, managedProjectIds])
  const rows = useMemo(
    () =>
      delegated
        .filter(
          (item) =>
            (filter === 'all' ||
              (filter === 'unfinished'
                ? !item.actualCompleteDate
                : item.status === filter)) &&
            [
              item.name,
              item.specification,
              item.bomReference?.materialCode,
              item.projectName,
              item.projectCode,
            ]
              .join(' ')
              .toLowerCase()
              .includes(search.trim().toLowerCase()),
        )
        .sort((a, b) => {
          const order = [
            'overdue',
            'risk',
            'pending_reply',
            'normal',
            'completed',
          ]
          return (
            order.indexOf(a.status) - order.indexOf(b.status) ||
            a.requiredDate.localeCompare(b.requiredDate) ||
            a.id.localeCompare(b.id)
          )
        }),
    [delegated, filter, search],
  )
  const page = usePagination(rows, 20, start)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editing || pending.current) return
    pending.current = true
    setSaving(true)
    setSaveError('')
    const form = new FormData(event.currentTarget)
    try {
      await api(
        `/tracking/${editing.item.id}/${editing.complete ? 'complete' : 'promise'}`,
        'POST',
        {
          expectedVersion: editing.item.version,
          ...(editing.complete
            ? {
                actualCompleteDate: form.get('date'),
                remark: form.get('remark'),
              }
            : { committedDate: form.get('date'), reason: form.get('reason') }),
        },
      )
      setEditing(null)
      setNotice(editing.complete ? '已记录完成' : '已保存承诺')
      await refresh()
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : '保存失败，内容已保留',
      )
    } finally {
      pending.current = false
      setSaving(false)
    }
  }
  if (!loading && !loadError && !delegated.length) return null
  return (
    <section ref={start} className="npi-panel" aria-label="我的物料待办">
      <div className="npi-panel-title">
        <div>
          <h2>我的协作物料</h2>
          <p>
            其他项目分给我的BOM物料、临时样机件和其他物料，可直接回复与确认完成。
          </p>
        </div>
        <button
          className="npi-button secondary"
          disabled={loading || saving}
          onClick={() => void refresh()}
        >
          刷新物料待办
        </button>
      </div>
      {notice && (
        <p role="status" className="npi-message">
          {notice}
        </p>
      )}
      {loadError && (
        <p role="alert" className="npi-message error">
          {loadError}。请刷新后再操作。
        </p>
      )}
      <div className="npi-material-filters">
        <input
          aria-label="搜索我的物料"
          type="search"
          placeholder="编码 / 物料 / 项目"
          value={search}
          maxLength={200}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="物料待办状态"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="unfinished">全部未完成</option>
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
          <option value="all">全部记录</option>
        </select>
        <span>共{rows.length}项</span>
      </div>
      {loading && <p role="status">正在刷新物料待办…</p>}
      {!loading && !loadError && !rows.length && (
        <p className="npi-muted">没有符合条件的物料。</p>
      )}
      <NpiPagination
        {...page}
        label="我的物料待办分页"
        disabled={loading || saving}
      />
      {!!rows.length && (
        <div className="npi-table-scroll">
          <table className="npi-table npi-tracking-table">
            <thead>
              <tr>
                <th>物料 / 项目</th>
                <th>要求日期</th>
                <th>当前承诺</th>
                <th>实际完成</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr key={item.id}>
                  <td data-label="物料 / 项目">
                    <strong>{item.name}</strong>
                    <div className="npi-muted">
                      {item.sourceType === 'ERP_BOM'
                        ? 'BOM物料'
                        : item.trackingType === 'other'
                          ? '其他物料'
                          : '临时样机件'}{' '}
                      · {item.qty} {item.unit}
                    </div>
                    <div>{item.bomReference?.materialCode}</div>
                    <small>
                      {item.projectCode} · {item.projectName}
                    </small>
                    <div>{item.specification}</div>
                  </td>
                  <td data-label="要求日期">{item.requiredDate}</td>
                  <td data-label="当前承诺">
                    {item.currentCommittedDate || '尚未回复'}
                  </td>
                  <td data-label="实际完成">
                    {item.actualCompleteDate || '—'}
                  </td>
                  <td data-label="状态">
                    <span className={`npi-badge npi-${item.status}`}>
                      {labels[item.status]}
                    </span>
                  </td>
                  <td data-label="操作">
                    <div className="npi-actions">
                      {!item.actualCompleteDate &&
                        item.currentNpiStage !== 'completed' && (
                          <>
                            <button
                              className="npi-button"
                              disabled={loading || !!loadError || saving}
                              onClick={() => {
                                setEditing({ item, complete: false })
                                setSaveError('')
                              }}
                            >
                              {item.currentCommittedDate
                                ? '修改承诺'
                                : '回复日期'}
                            </button>
                            <button
                              className="npi-button secondary"
                              disabled={loading || !!loadError || saving}
                              onClick={() => {
                                setEditing({ item, complete: true })
                                setSaveError('')
                              }}
                            >
                              确认完成
                            </button>
                          </>
                        )}
                      <button
                        className="npi-button secondary"
                        disabled={loading || !!loadError || saving}
                        onClick={() => setHistoryId(item.id)}
                      >
                        承诺历史
                      </button>
                      <button
                        className="npi-button secondary"
                        disabled={loading || !!loadError || saving}
                        onClick={() => setFileItem(item)}
                      >
                        资料与照片
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={!!fileItem}
        onOpenChange={(open) => {
          if (!open && !fileOperation.isBusy()) setFileItem(null)
        }}
      >
        <DialogContent
          className="npi-modal npi-file-operation-dialog"
          data-saving={fileOperation.busy}
        >
          <DialogTitle>物料资料与照片</DialogTitle>
          <DialogDescription>
            {fileItem?.name} · {fileItem?.projectName}
          </DialogDescription>
          {fileItem && (
            <NpiFiles
              key={fileItem.id}
              api={api}
              scope={{ kind: 'tracking', id: fileItem.id }}
              readOnly={fileItem.currentNpiStage === 'completed'}
              onBusyChange={fileOperation.onBusyChange}
            />
          )}
        </DialogContent>
      </Dialog>
      {historyId && (
        <NpiTrackingHistory
          itemId={historyId}
          api={api}
          onClose={() => setHistoryId(null)}
        />
      )}
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open && !pending.current) setEditing(null)
        }}
      >
        <DialogContent className="npi-modal">
          <DialogTitle>
            {editing?.complete ? '确认物料完成' : '物料日期回复'}
          </DialogTitle>
          <DialogDescription>
            {editing?.item.name} · {editing?.item.projectName}
          </DialogDescription>
          {editing && (
            <form
              key={editing.item.id + String(editing.complete)}
              onSubmit={submit}
            >
              <fieldset
                disabled={saving}
                style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
              >
                <div className="npi-form-grid">
                  <label>
                    <span>
                      {editing.complete ? '实际完成日期' : '承诺完成日期'}
                    </span>
                    <input
                      name="date"
                      type="date"
                      required
                      defaultValue={
                        editing.complete
                          ? data?.today
                          : editing.item.currentCommittedDate ||
                            editing.item.requiredDate
                      }
                      max={editing.complete ? data?.today : undefined}
                    />
                  </label>
                  {!editing.complete && (
                    <label className="wide">
                      <span>
                        变更原因
                        {editing.item.currentCommittedDate
                          ? '（必填）'
                          : '（选填）'}
                      </span>
                      <textarea
                        name="reason"
                        required={!!editing.item.currentCommittedDate}
                        maxLength={2000}
                      />
                    </label>
                  )}
                  {editing.complete && (
                    <label className="wide">
                      <span>完成备注</span>
                      <textarea name="remark" maxLength={2000} />
                    </label>
                  )}
                </div>
              </fieldset>
              {saveError && (
                <p role="alert" className="npi-message error">
                  {saveError}
                </p>
              )}
              <div className="npi-actions">
                <button
                  type="button"
                  className="npi-button secondary"
                  disabled={saving}
                  onClick={() => setEditing(null)}
                >
                  取消
                </button>
                <button className="npi-button" disabled={saving}>
                  {saving ? '正在保存…' : '保存'}
                </button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
