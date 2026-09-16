// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState } from 'react'
import { trackingIdentity } from '../../lib/npi/tracking-reference'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import type { FormEvent } from 'react'
import type { NpiTracking } from '../../lib/npi/service'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
type PurchaseItem = NpiTracking & { currentNpiStage?: string }

type Draft = { date: string; supplier: string; remark: string; reason: string }
const values = (
  item: PurchaseItem,
  complete: boolean,
  today: string,
): Draft => ({
  date: complete ? today : item.currentCommittedDate || item.requiredDate,
  supplier: item.supplier || '',
  remark: item.remark || '',
  reason: '',
})
const locked = (item: PurchaseItem) =>
  !!item.actualCompleteDate ||
  item.currentNpiStage === 'completed' ||
  (!item.trackingEnabled && !item.affectsKit)

export function NpiProcurementReplyDialog({
  item,
  complete,
  actorId,
  today,
  api,
  onClose,
  onSaved,
  onOpenFiles,
}: {
  item: PurchaseItem
  complete: boolean
  actorId: string
  today: string
  api: Api
  onClose: () => void
  onSaved: () => Promise<void>
  onOpenFiles?: () => void
}) {
  const [base, setBase] = useState(item)
  const [draft, setDraft] = useState(() => values(item, complete, today))
  const [latest, setLatest] = useState<PurchaseItem | null>(null)
  const [busy, setBusy] = useState<'read' | 'save' | 'refresh' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [saved, setSaved] = useState(false)
  const [needsReload, setNeedsReload] = useState(false)
  const pending = useRef(false),
    dirty = useRef(new Set<keyof Draft>()),
    afterSave = useRef<'close' | 'files'>('close')
  const change = (key: keyof Draft, value: string) => {
    dirty.current.add(key)
    setDraft((previous) => ({ ...previous, [key]: value }))
  }
  const isLocked = locked(latest || base)
  const needsReason =
    !complete &&
    !!base.currentCommittedDate &&
    draft.date !== base.currentCommittedDate
  const reload = async () => {
    if (pending.current) return
    pending.current = true
    setBusy('read')
    setError('')
    setNotice('')
    try {
      const result = await api<{ actorId: string; items: Array<PurchaseItem> }>(
        '/workbench/procurement',
      )
      if (result.actorId !== actorId)
        throw new Error('登录账号已改变，请整页刷新。')
      const next = result.items.find(
        (row) => row.id === item.id && row.ownerId === actorId,
      )
      if (!next)
        throw new Error('该物料已不在你的采购待办中，请联系项目负责人核对。')
      setUnavailable(false)
      if (next.version !== base.version || locked(next)) {
        setLatest(next)
        setNotice('已读取最新记录，填写内容仍保留。请核对下面的变化。')
      } else {
        setLatest(null)
        setNeedsReload(false)
        setNotice('当前记录未变化，可以继续填写。')
      }
    } catch (e) {
      setUnavailable(true)
      setError(e instanceof Error ? e.message : '暂时无法读取，请重试。')
    } finally {
      pending.current = false
      setBusy(null)
    }
  }
  const acceptLatest = () => {
    if (!latest || pending.current || locked(latest)) return
    const next = values(latest, complete, today)
    setDraft(
      (previous) =>
        Object.fromEntries(
          (Object.keys(previous) as Array<keyof Draft>).map((key) => [
            key,
            dirty.current.has(key) ? previous[key] : next[key],
          ]),
        ) as Draft,
    )
    setBase(latest)
    setLatest(null)
    setNeedsReload(false)
    setError('')
    setNotice('已按最新记录继续编辑；你修改过的输入已保留，请核对后保存。')
  }
  const finish = async () => {
    await onSaved()
    if (afterSave.current === 'files' && onOpenFiles) onOpenFiles()
    else onClose()
  }
  const retryRefresh = async () => {
    if (pending.current || !saved) return
    pending.current = true
    setBusy('refresh')
    setError('')
    try {
      await finish()
    } catch (e) {
      setError(
        `记录已保存，列表仍未刷新。${e instanceof Error ? e.message : '请重试。'}`,
      )
    } finally {
      pending.current = false
      setBusy(null)
    }
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (
      pending.current ||
      latest ||
      unavailable ||
      isLocked ||
      saved ||
      needsReload
    )
      return
    if (needsReason && !draft.reason.trim()) {
      setError('修改承诺日期必须填写变更原因。')
      return
    }
    pending.current = true
    const submitter = (event.nativeEvent as SubmitEvent).submitter
    afterSave.current =
      submitter instanceof HTMLButtonElement && submitter.value === 'files'
        ? 'files'
        : 'close'
    setBusy('save')
    setError('')
    setNotice('')
    let committed = false
    try {
      await api(
        `/tracking/${base.id}/${complete ? 'complete' : 'promise'}`,
        'POST',
        {
          expectedVersion: base.version,
          ...(complete
            ? { actualCompleteDate: draft.date, remark: draft.remark }
            : {
                committedDate: draft.date,
                reason: draft.reason,
                supplier: draft.supplier,
                remark: draft.remark,
              }),
        },
      )
      committed = true
      setSaved(true)
      await finish()
    } catch (e) {
      if (!committed) setNeedsReload(true)
      setError(
        `${committed ? '已保存，但列表刷新失败；请重试刷新列表，无需再次提交。' : '填写内容已保留，请读取最新记录核对后继续。'} ${e instanceof Error ? e.message : '请求未完成。'}`,
      )
    } finally {
      pending.current = false
      setBusy(null)
    }
  }
  const current = latest || base
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose()
      }}
    >
      <DialogContent
        className="npi-modal npi-purchase-reply-dialog"
        data-saving={!!busy}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle>{complete ? '确认到货' : '采购日期回复'}</DialogTitle>
        <DialogDescription style={{ overflowWrap: 'anywhere' }}>
          {trackingIdentity(base)} · {base.projectName || base.projectCode}。
          {complete
            ? '记录实际到货日期，可选择保存后直接补充照片与到货资料。'
            : '填写预计到货日期；供应商与备注可以稍后补充。'}
        </DialogDescription>
        <p className="npi-list-summary">
          要求到货：{base.requiredDate} · 首次承诺：
          {base.firstCommittedDate || '尚未回复'} · 当前承诺：
          {base.currentCommittedDate || '尚未回复'}
        </p>
        {!saved && (
          <div className="npi-actions">
            <button
              type="button"
              className="npi-button secondary"
              disabled={!!busy}
              onClick={() => void reload()}
            >
              {busy === 'read' ? '正在读取…' : '读取最新记录'}
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="npi-message">
            {notice}
          </p>
        )}
        {latest && (
          <section className="npi-preview" aria-label="采购记录变化">
            <h3>最新采购记录</h3>
            <p>
              要求到货：{base.requiredDate} → {latest.requiredDate}
            </p>
            <p>
              当前承诺：{base.currentCommittedDate || '尚未回复'} →{' '}
              {latest.currentCommittedDate || '尚未回复'}
            </p>
            <p style={{ overflowWrap: 'anywhere' }}>
              供应商：{base.supplier || '未填写'} →{' '}
              {latest.supplier || '未填写'}
            </p>
            <p style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
              备注：{base.remark || '未填写'} → {latest.remark || '未填写'}
            </p>
            {!isLocked && (
              <button
                type="button"
                className="npi-button secondary"
                disabled={!!busy || unavailable}
                onClick={acceptLatest}
              >
                以最新记录继续编辑
              </button>
            )}
          </section>
        )}
        {isLocked && (
          <p role="status" className="npi-message">
            {current.actualCompleteDate
              ? `该物料已于 ${current.actualCompleteDate} 确认到货，不能再次修改。`
              : '该项目已完成或物料已停止跟踪，当前记录只读。'}
          </p>
        )}
        <form onSubmit={submit}>
          <fieldset
            disabled={!!busy || isLocked || saved}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <div className="npi-form-grid">
              <label>
                <span>{complete ? '实际到货日期' : '预计到货日期'}</span>
                <input
                  type="date"
                  required
                  max={complete ? today : undefined}
                  value={draft.date}
                  onChange={(e) => change('date', e.target.value)}
                />
              </label>
              {needsReason && (
                <label className="wide">
                  <span>变更原因（必填）</span>
                  <textarea
                    required
                    maxLength={2000}
                    value={draft.reason}
                    onChange={(e) => change('reason', e.target.value)}
                  />
                </label>
              )}
              {complete && (
                <label className="wide">
                  <span>到货说明（选填）</span>
                  <textarea
                    maxLength={2000}
                    value={draft.remark}
                    onChange={(e) => change('remark', e.target.value)}
                  />
                </label>
              )}
            </div>
            {!complete && (
              <details className="npi-purchase-reply-details">
                <summary>供应商与备注（选填）</summary>
                <div className="npi-form-grid">
                  <label>
                    <span>供应商</span>
                    <input
                      maxLength={255}
                      value={draft.supplier}
                      onChange={(e) => change('supplier', e.target.value)}
                    />
                  </label>
                  <label className="wide">
                    <span>备注</span>
                    <textarea
                      maxLength={2000}
                      value={draft.remark}
                      onChange={(e) => change('remark', e.target.value)}
                    />
                  </label>
                </div>
              </details>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="npi-message error">
              {error}
            </p>
          )}
          <div className="npi-actions">
            <button
              type="button"
              className="npi-button secondary"
              disabled={!!busy}
              onClick={onClose}
            >
              {saved || isLocked ? '关闭' : '取消'}
            </button>
            {!saved && (
              <button
                className="npi-button"
                disabled={
                  !!busy || !!latest || unavailable || isLocked || needsReload
                }
              >
                {busy === 'save'
                  ? '正在保存…'
                  : complete
                    ? '保存到货'
                    : '保存回复'}
              </button>
            )}
            {!saved && complete && onOpenFiles && (
              <button
                type="submit"
                value="files"
                className="npi-button secondary"
                disabled={
                  !!busy || !!latest || unavailable || isLocked || needsReload
                }
              >
                保存并补充资料
              </button>
            )}
            {saved && (
              <button
                type="button"
                className="npi-button"
                disabled={!!busy}
                onClick={() => void retryRefresh()}
              >
                {busy === 'refresh' ? '正在刷新…' : '重试刷新列表'}
              </button>
            )}
            {complete &&
              onOpenFiles &&
              (saved || current.actualCompleteDate) && (
                <button
                  type="button"
                  className="npi-button secondary"
                  disabled={!!busy || unavailable}
                  onClick={onOpenFiles}
                >
                  补充到货资料
                </button>
              )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
