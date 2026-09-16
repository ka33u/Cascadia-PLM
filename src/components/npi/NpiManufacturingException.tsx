// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import { NpiPagination, usePagination } from './NpiPagination'
import type { FormEvent } from 'react'
import type { BomRow } from '../../lib/npi/bom'
import type { NpiMetadata, ProjectDetail } from '../../lib/npi/service'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
type Snapshot = {
  project: ProjectDetail
  rows: Array<BomRow>
  actor: NpiMetadata['actor']
  manufacturingOwnerName: string
}
export function NpiManufacturingException({
  projectId,
  actorId,
  api,
  onClose,
  onSaved,
}: {
  projectId: string
  actorId: string
  api: Api
  onClose: () => void
  onSaved: (itemId: string) => Promise<void>
}) {
  const [base, setBase] = useState<Snapshot | null>(null),
    [latest, setLatest] = useState<Snapshot | null>(null)
  const [search, setSearch] = useState(''),
    [selected, setSelected] = useState('')
  const [date, setDate] = useState(''),
    [reason, setReason] = useState(''),
    [affectsKit, setAffectsKit] = useState(true)
  const [operation, setOperation] = useState<
    'read' | 'save' | 'refresh' | null
  >('read')
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [needsReload, setNeedsReload] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const request = useRef(0),
    pending = useRef(false),
    dialog = useRef<HTMLDivElement>(null)
  const busy = operation !== null,
    loading = operation === 'read'
  const display = latest || base
  const rows = useMemo(() => base?.rows || [], [base])
  const tracked = useMemo(
    () =>
      new Map(
        (display?.project.items || [])
          .filter((i) => i.bomItemId)
          .map((i) => [i.bomItemId, i]),
      ),
    [display],
  )
  const current = tracked.get(selected)
  const accessReason = (snapshot: Snapshot | null) => {
    if (!snapshot) return ''
    if (snapshot.project.currentNpiStage === 'completed')
      return '项目已完成，只读。'
    if (
      snapshot.actor.role !== 'admin' &&
      (snapshot.actor.role !== 'manufacturing' ||
        snapshot.actor.id !== snapshot.project.manufacturingOwnerId)
    )
      return '当前账号已不是本项目制造负责人，请交由现任负责人处理。'
    return ''
  }
  const unavailable = (row: BomRow) => {
    const item = tracked.get(row.id)
    if (accessReason(display)) return accessReason(display)
    if (item?.actualCompleteDate) return '物料已完成，不可改写承诺'
    if (
      item &&
      (item.ownerId !== display?.project.manufacturingOwnerId ||
        item.trackingType !== 'material')
    )
      return (
        '由' +
        (item.ownerName || '其他责任人') +
        '负责，请由原责任人回复或先办理交接'
      )
    return ''
  }
  const selectionLocked =
    busy || !!savedId || needsReload || !!latest || !!accessReason(display)
  const load = useCallback(
    async (review = false) => {
      if (pending.current) return
      pending.current = true
      const sequence = ++request.current
      setOperation('read')
      setError('')
      setMessage('')
      if (review) setNeedsReload(true)
      try {
        const [project, meta] = await Promise.all([
          api<ProjectDetail>('/projects/' + projectId),
          api<NpiMetadata>('/meta'),
        ])
        if (project.id !== projectId || meta.actor.id !== actorId)
          throw Error('项目或登录账号已改变，请关闭后重新打开。')
        const tree = project.activeBomImportId
          ? await api<{ rows: Array<BomRow> }>(
              '/projects/' +
                projectId +
                '/bom/tree?importId=' +
                project.activeBomImportId,
            )
          : { rows: [] }
        if (sequence !== request.current) return
        const snapshot = {
          project,
          rows: tree.rows,
          actor: meta.actor,
          manufacturingOwnerName:
            meta.users.find((u) => u.id === project.manufacturingOwnerId)
              ?.name || project.manufacturingOwnerId,
        }
        if (review) {
          setLatest(snapshot)
          setMessage(
            '未保存输入已保留。请核对当前版本、责任人和承诺，再载入继续。',
          )
        } else {
          setBase(snapshot)
          setNeedsReload(false)
        }
      } catch (err) {
        if (sequence !== request.current) return
        setLatest(null)
        setNeedsReload(true)
        setError(err instanceof Error ? err.message : '读取BOM失败，请重试。')
      } finally {
        if (sequence === request.current) {
          pending.current = false
          setOperation(null)
        }
      }
    },
    [api, projectId, actorId],
  )
  useEffect(() => {
    void load()
    return () => {
      request.current++
      pending.current = false
    }
  }, [load])
  useEffect(() => {
    if (error || message || latest) dialog.current?.scrollTo({ top: 0 })
  }, [error, message, latest])
  const acceptLatest = () => {
    if (pending.current || !latest || accessReason(latest)) return
    const old = base?.project.items.find((i) => i.bomItemId === selected)
    const next = latest.project.items.find((i) => i.bomItemId === selected)
    const exists = latest.rows.some((r) => r.id === selected)
    if (exists) {
      if (date === (old?.currentCommittedDate || ''))
        setDate(next?.currentCommittedDate || '')
      if (affectsKit === (old?.affectsKit ?? true))
        setAffectsKit(next?.affectsKit ?? true)
    } else setSelected('')
    setBase(latest)
    setLatest(null)
    setNeedsReload(false)
    setError('')
    setMessage(
      !selected
        ? '已载入最新BOM，请选择异常物料。'
        : exists
          ? '已载入最新BOM，已编辑的日期、原因与齐套选择仍保留；未编辑字段已更新。'
          : 'BOM已换版，请重新选择物料。新选择会使用该物料的当前日期，并重新填写异常原因。',
    )
  }
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])
  const filtered = useMemo(
    () =>
      rows.filter((r) =>
        (r.materialCode + ' ' + r.materialName)
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
      ),
    [rows, search],
  )
  const pageStart = useRef<HTMLDivElement>(null),
    page = usePagination(filtered, 20, pageStart)
  const row = rows.find((r) => r.id === selected)
  const choose = (next: BomRow) => {
    if (pending.current || selectionLocked || unavailable(next)) return
    setSelected(next.id)
    setDate(tracked.get(next.id)?.currentCommittedDate || '')
    setAffectsKit(tracked.get(next.id)?.affectsKit ?? true)
    setReason('')
    setMessage('')
  }
  const retryRefresh = async () => {
    if (pending.current || !savedId) return
    pending.current = true
    setOperation('refresh')
    setError('')
    const sequence = request.current
    try {
      await onSaved(savedId)
      if (sequence === request.current) onClose()
    } catch (err) {
      if (sequence === request.current)
        setError(
          '制造异常件已保存，列表仍未刷新。' +
            (err instanceof Error ? err.message : '请重试刷新。'),
        )
    } finally {
      if (sequence === request.current) {
        pending.current = false
        setOperation(null)
      }
    }
  }
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (pending.current || selectionLocked || !base || !row || unavailable(row))
      return
    if (!reason.trim()) {
      setError('请填写异常原因。')
      return
    }
    pending.current = true
    setOperation('save')
    setError('')
    setMessage('')
    const sequence = request.current
    let committed = false
    try {
      const result = await api<{ id: string }>(
        '/projects/' + projectId + '/manufacturing-exceptions',
        'POST',
        {
          expectedProjectVersion: base.project.version,
          activeImportId: base.project.activeBomImportId,
          bomItemId: row.id,
          expectedVersion: current?.version ?? 0,
          committedDate: date,
          reason,
          affectsKit,
        },
      )
      if (sequence !== request.current) return
      committed = true
      setSavedId(result.id)
      setMessage('制造异常件已保存，无需重复提交。')
      await onSaved(result.id)
      if (sequence === request.current) onClose()
    } catch (err) {
      if (sequence !== request.current) return
      if (!committed) setNeedsReload(true)
      setError(
        (committed
          ? '制造异常件已保存，列表刷新失败。请重试刷新，无需再次提交。'
          : '本次保存未确认，填写内容已保留。请重新载入BOM并核对最新记录后继续。') +
          ' ' +
          (err instanceof Error ? err.message : '请求未完成。'),
      )
    } finally {
      if (sequence === request.current) {
        pending.current = false
        setOperation(null)
      }
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose()
      }}
    >
      <DialogContent
        ref={dialog}
        className="npi-modal npi-exception-dialog"
        data-saving={busy}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle>添加制造异常件</DialogTitle>
        <DialogDescription>
          {base && `${base.project.name} · ${base.project.code}。`}
          从当前BOM选择物料，交项目制造负责人跟踪。预计完成日期、原因和齐套影响一并保存。
        </DialogDescription>
        {(error || message || latest) && (
          <div className="npi-exception-feedback">
            {error && (
              <p role="alert" className="npi-message error">
                {error}
              </p>
            )}
            {message && <p role="status">{message}</p>}
            {latest && (
              <div className="npi-alert">
                <strong>最新BOM与跟踪信息已读取，请核对后继续。</strong>
                <p>
                  生效BOM：
                  {!base
                    ? '已读取'
                    : latest.project.activeBomImportId ===
                        base.project.activeBomImportId
                      ? '仍为原版本'
                      : '已换版'}
                  ；制造负责人：
                  {latest.manufacturingOwnerName}。
                </p>
                <p>
                  {!selected
                    ? '尚未选择异常物料，请载入后选择。'
                    : latest.rows.some((r) => r.id === selected)
                      ? '当前选中物料仍在生效BOM内。'
                      : '原选中物料不在当前BOM中，需要重新选择；不会按相同编码自动替换。'}
                </p>
                {current && (
                  <p>
                    最新要求：{current.requiredDate}；首次承诺：
                    {current.firstCommittedDate || '未回复'}；当前承诺：
                    {current.currentCommittedDate || '未回复'}；实际完成：
                    {current.actualCompleteDate || '未完成'}；影响齐套：
                    {current.affectsKit ? '是' : '否'}。
                  </p>
                )}
                {accessReason(latest) && <p>{accessReason(latest)}</p>}
                <button
                  type="button"
                  className="npi-button secondary"
                  disabled={busy || !!accessReason(latest)}
                  onClick={acceptLatest}
                >
                  核对后载入最新BOM
                </button>
              </div>
            )}
            {savedId && (
              <button
                type="button"
                className="npi-button secondary"
                disabled={busy}
                onClick={() => void retryRefresh()}
              >
                重试刷新列表
              </button>
            )}
          </div>
        )}
        <div className="npi-actions">
          <input
            type="search"
            aria-label="搜索异常件BOM"
            placeholder="搜索物料编码 / 名称"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={200}
            disabled={selectionLocked}
          />
          <button
            className="npi-button secondary"
            disabled={busy || !!savedId}
            onClick={() => void load(true)}
          >
            重新载入BOM
          </button>
        </div>
        {loading ? (
          <p role="status">正在读取当前BOM…</p>
        ) : !base ? (
          <p role="status">未能载入BOM，请重新载入后继续。</p>
        ) : !rows.length ? (
          <p role="status">当前没有BOM，请先导入并确认生效版本。</p>
        ) : (
          <>
            <div
              className="npi-exception-list"
              ref={pageStart}
              role="group"
              aria-label="选择BOM异常件"
            >
              {page.items.map((r) => (
                <button
                  type="button"
                  key={r.id}
                  className="npi-exception-option"
                  aria-label={`选择${r.materialCode} ${r.materialName} 第${r.rowNo}行`}
                  aria-pressed={selected === r.id}
                  disabled={selectionLocked || !!unavailable(r)}
                  onClick={() => choose(r)}
                >
                  <strong>
                    {r.materialCode} · {r.materialName}
                  </strong>
                  <small>
                    {r.level}级 · Excel第{r.rowNo}行 · {r.qty} {r.unit} ·{' '}
                    {r.specification || '未填规格'}
                  </small>
                  {r.parentId && (
                    <small>
                      上级：{rowById.get(r.parentId)?.materialName} ·{' '}
                      {rowById.get(r.parentId)?.materialCode} · 第
                      {rowById.get(r.parentId)?.rowNo}行
                    </small>
                  )}
                  <small>
                    {(savedId && selected === r.id
                      ? '已保存，等待刷新最新状态'
                      : unavailable(r)) ||
                      (tracked.has(r.id)
                        ? '保留原跟踪编号与首次承诺'
                        : '新增制造重点跟踪')}
                  </small>
                </button>
              ))}
              {!filtered.length && <p>没有匹配物料，请调整搜索内容。</p>}
            </div>
            <NpiPagination
              label="异常件BOM分页"
              {...page}
              disabled={selectionLocked}
            />
          </>
        )}
        <form onSubmit={save}>
          <fieldset
            disabled={selectionLocked || !row || !!unavailable(row)}
            className="npi-exception-fields"
          >
            {row && (
              <div className="npi-exception-selected">
                <strong>
                  已选择：{row.materialName} · {row.materialCode} · Excel第
                  {row.rowNo}行
                </strong>
                {savedId ? (
                  <p>
                    本次已保存预计完成：{date}；影响齐套：
                    {affectsKit ? '是' : '否'}。最新状态将在刷新后显示。
                  </p>
                ) : (
                  <p>
                    要求日期：
                    {current?.requiredDate || base?.project.requiredKitDate}
                    ；首次承诺：{current?.firstCommittedDate || '尚未回复'}
                    ；当前承诺：{current?.currentCommittedDate || '尚未回复'}
                  </p>
                )}
                {unavailable(row) && <p>{unavailable(row)}</p>}
              </div>
            )}
            <div className="npi-form-grid">
              <label>
                <span>预计完成日期</span>
                <input
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
              <label>
                <span className="npi-checkbox">
                  <input
                    type="checkbox"
                    checked={affectsKit}
                    onChange={(e) => setAffectsKit(e.target.checked)}
                  />
                  影响齐套
                </span>
              </label>
              <label className="wide">
                <span>异常原因</span>
                <textarea
                  aria-label="异常原因"
                  required
                  maxLength={2000}
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            </div>
          </fieldset>
          <div className="npi-actions">
            <button
              type="button"
              className="npi-button secondary"
              disabled={busy}
              onClick={() => {
                if (!pending.current) onClose()
              }}
            >
              取消
            </button>
            <button
              type="submit"
              className="npi-button"
              disabled={selectionLocked || !row || !!unavailable(row)}
            >
              {operation === 'save'
                ? '正在保存…'
                : savedId
                  ? '异常件已保存'
                  : '保存异常件'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
