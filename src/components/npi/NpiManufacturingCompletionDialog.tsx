// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState } from 'react'
import { nodeNames, today } from '../../lib/npi/domain'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import type { FormEvent } from 'react'
import type { NpiMetadata, ProjectDetail } from '../../lib/npi/service'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export function NpiManufacturingCompletionDialog({
  project,
  actor,
  api,
  onSaved,
  onClose,
}: {
  project: ProjectDetail
  actor: NpiMetadata['actor']
  api: Api
  onSaved: () => Promise<void>
  onClose: () => void
}) {
  const [base, setBase] = useState(project)
  const [latest, setLatest] = useState<ProjectDetail | null>(null)
  const [currentActor, setCurrentActor] = useState(actor)
  const [dates, setDates] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'read' | 'save' | 'refresh' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [needsReload, setNeedsReload] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [saved, setSaved] = useState(false)
  const pending = useRef(false)
  const current = latest || base
  const nodes = current.items.filter((i) => i.sourceType === 'MANUFACTURING')
  const authorized =
    currentActor.role === 'admin' ||
    currentActor.id === current.manufacturingOwnerId
  const locked =
    !authorized ||
    current.currentNpiStage === 'completed' ||
    !current.plan ||
    unavailable
  const allCompleted = nodes.every((i) => !!i.actualCompleteDate)
  const reload = async () => {
    if (pending.current) return
    pending.current = true
    setBusy('read')
    setError('')
    setNotice('')
    try {
      const [next, meta] = await Promise.all([
        api<ProjectDetail>(`/projects/${base.id}`),
        api<NpiMetadata>('/meta'),
      ])
      if (meta.actor.id !== actor.id)
        throw Error('登录账号已改变，请整页刷新。')
      setCurrentActor(meta.actor)
      setLatest(next)
      setUnavailable(false)
      setNotice('已读取最新记录，未提交的日期仍保留；请核对已完成节点。')
    } catch (e) {
      setUnavailable(true)
      setError(e instanceof Error ? e.message : '读取失败，请重试。')
    } finally {
      pending.current = false
      setBusy(null)
    }
  }
  const acceptLatest = () => {
    if (!latest || pending.current || locked) return
    setDates((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([type]) =>
          latest.items.some(
            (i) =>
              i.sourceType === 'MANUFACTURING' &&
              i.trackingType === type &&
              !i.actualCompleteDate,
          ),
        ),
      ),
    )
    setBase(latest)
    setLatest(null)
    setNeedsReload(false)
    setError('')
    setNotice('已核对最新记录，未完成节点的输入已保留。')
  }
  const refreshSaved = async () => {
    await onSaved()
    onClose()
  }
  const retryRefresh = async () => {
    if (pending.current) return
    pending.current = true
    setBusy('refresh')
    setError('')
    try {
      await refreshSaved()
    } catch (e) {
      setError(
        `完成记录已保存，列表仍未刷新。${e instanceof Error ? e.message : '请重试。'}`,
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
      locked ||
      allCompleted ||
      saved ||
      latest ||
      needsReload
    )
      return
    const actualDates = Object.fromEntries(
      Object.entries(dates).filter(
        ([type, value]) =>
          value &&
          nodes.some((i) => i.trackingType === type && !i.actualCompleteDate),
      ),
    )
    if (!Object.keys(actualDates).length) {
      setError('请填写至少一个已完成节点的实际日期。')
      return
    }
    if (Object.values(actualDates).some((date) => date > today())) {
      setError('实际完成日期不能在未来。')
      return
    }
    pending.current = true
    setBusy('save')
    setError('')
    setNotice('')
    let committed = false
    try {
      await api(`/projects/${base.id}/manufacturing-completion`, 'POST', {
        expectedVersion: base.plan?.version,
        actualDates,
      })
      committed = true
      setSaved(true)
      await refreshSaved()
    } catch (e) {
      if (!committed) setNeedsReload(true)
      setError(
        `${committed ? '完成记录已保存，列表刷新失败。请重试刷新，无需再次提交。' : '填写内容已保留，请读取最新记录核对后继续。'} ${e instanceof Error ? e.message : '请求未完成。'}`,
      )
    } finally {
      pending.current = false
      setBusy(null)
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
        className="npi-modal npi-manufacturing-dialog npi-manufacturing-completion-dialog"
        data-saving={!!busy}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogTitle>集中确认制造完成</DialogTitle>
        <DialogDescription style={{ overflowWrap: 'anywhere' }}>
          {base.name} · {base.code}。只填写本次已完成的节点，其他节点留空。
        </DialogDescription>
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
        {notice && <p role="status">{notice}</p>}
        {locked && (
          <p role="status">
            {unavailable
              ? '暂时无法核对当前权限与记录，请重新读取。'
              : !authorized
                ? '项目制造负责人已变化，当前账号不能确认完成。'
                : '项目已完成，完成记录只读。'}
          </p>
        )}
        {allCompleted && <p role="status">制造四节点均已完成。</p>}
        {latest && !locked && !allCompleted && (
          <div className="npi-alert">
            <span>
              以下已完成日期来自最新记录；核对后保留其余输入继续填写。
            </span>
            <button type="button" disabled={!!busy} onClick={acceptLatest}>
              按最新记录继续
            </button>
          </div>
        )}
        <form onSubmit={submit}>
          <fieldset disabled={!!busy || locked || saved}>
            <div className="npi-form-grid">
              {Object.entries(nodeNames).map(([type, label]) => {
                const item = nodes.find((i) => i.trackingType === type)
                return (
                  <label key={type}>
                    <span>{label} · 实际完成日期</span>
                    <input
                      type="date"
                      aria-label={`${label}实际完成日期`}
                      max={today()}
                      value={item?.actualCompleteDate || dates[type] || ''}
                      disabled={!item || !!item.actualCompleteDate}
                      onChange={(event) => {
                        setDates((previous) => ({
                          ...previous,
                          [type]: event.target.value,
                        }))
                        if (!needsReload) setError('')
                      }}
                    />
                    <small>
                      要求 {item?.requiredDate || '—'} · 承诺{' '}
                      {item?.currentCommittedDate || '待回复'}
                      {item?.actualCompleteDate ? ' · 已完成' : ''}
                    </small>
                  </label>
                )
              })}
            </div>
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
              {saved || allCompleted || locked ? '关闭' : '取消'}
            </button>
            {saved ? (
              <button
                type="button"
                className="npi-button"
                disabled={!!busy}
                onClick={() => void retryRefresh()}
              >
                {busy ? '正在刷新…' : '重试刷新'}
              </button>
            ) : (
              <button
                type="submit"
                className="npi-button"
                disabled={
                  !!busy || locked || allCompleted || !!latest || needsReload
                }
              >
                {busy === 'save' ? '正在保存…' : '保存完成记录'}
              </button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
