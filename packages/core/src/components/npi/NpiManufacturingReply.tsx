// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState } from 'react'
import { nodeNames } from '../../lib/npi/domain'
import type { FormEvent } from 'react'
import type { ProjectDetail } from '../../lib/npi/service'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export function NpiManufacturingReply({
  project,
  api,
  onSaved,
  onReload,
  onException,
  onBusyChange,
  onCancel,
  readOnly = false,
  disabled = false,
}: {
  project: ProjectDetail
  api: Api
  onSaved: () => Promise<void>
  onReload: () => Promise<ProjectDetail>
  onBusyChange?: (busy: boolean) => void
  onCancel?: () => void
  onException?: () => void
  readOnly?: boolean
  disabled?: boolean
}) {
  const snapshot = (value = project) => ({
    version: value.plan?.version,
    values: Object.fromEntries(
      Object.keys(nodeNames).map((type) => [
        type,
        value.items.find((i) => i.trackingType === type)
          ?.currentCommittedDate || '',
      ]),
    ),
  })
  const [base, setBase] = useState(snapshot)
  const [values, setValues] = useState(base.values)
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [operation, setOperation] = useState<
      'save' | 'read' | 'refresh' | null
    >(null),
    [message, setMessage] = useState(''),
    [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [needsReload, setNeedsReload] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [latest, setLatest] = useState<ProjectDetail | null>(null)
  const pending = useRef(false)
  const busy = operation !== null
  const current = latest || project
  const reviewRequired = !!latest || base.version !== project.plan?.version
  const locked =
    readOnly ||
    disabled ||
    unavailable ||
    !current.plan ||
    current.currentNpiStage === 'completed'
  const begin = (kind: 'save' | 'read' | 'refresh') => {
    if (pending.current) return false
    pending.current = true
    setOperation(kind)
    onBusyChange?.(true)
    return true
  }
  const finish = () => {
    pending.current = false
    setOperation(null)
    onBusyChange?.(false)
  }
  const reload = async () => {
    if (saved || disabled || !begin('read')) return
    setError('')
    setMessage('')
    try {
      const next = await onReload()
      if (next.id !== project.id) throw Error('项目已改变，请返回后重新打开。')
      setLatest(next)
      setUnavailable(false)
      setMessage('最新计划已读取，未保存输入仍保留；请核对后载入。')
    } catch (err) {
      setNeedsReload(true)
      setUnavailable(true)
      setError(
        err instanceof Error ? err.message : '最新计划暂时无法读取，请重试。',
      )
    } finally {
      finish()
    }
  }
  const acceptLatest = () => {
    if (pending.current || saved || locked) return
    const next = snapshot(current)
    const kept = Object.fromEntries(
      Object.keys(nodeNames).map((type) => [
        type,
        current.items.find((i) => i.trackingType === type)
          ?.actualCompleteDate || values[type] === base.values[type]
          ? next.values[type] || ''
          : values[type] || '',
      ]),
    )
    setBase(next)
    setValues(kept)
    setReasons(
      Object.fromEntries(
        Object.entries(reasons).filter(
          ([type]) => next.values[type] && kept[type] !== next.values[type],
        ),
      ),
    )
    setLatest(null)
    setNeedsReload(false)
    setError('')
    setMessage('已载入最新计划，未完成节点的未保存输入已保留。')
  }
  const retryRefresh = async () => {
    if (!saved || disabled || !begin('refresh')) return
    setError('')
    try {
      await onSaved()
      setSaved(false)
      setMessage('制造承诺已保存，齐套预测和历史已更新。')
    } catch (err) {
      setError(
        `制造承诺已保存，列表仍未刷新。${err instanceof Error ? err.message : '请重试刷新。'}`,
      )
    } finally {
      finish()
    }
  }
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (pending.current || locked || saved || needsReload || reviewRequired)
      return
    setError('')
    setMessage('')
    const changes: Record<string, unknown> = {},
      changeReasons: Record<string, string> = {}
    for (const [type, value] of Object.entries(values)) {
      if (
        current.items.find((i) => i.trackingType === type)?.actualCompleteDate
      )
        continue
      if (value === base.values[type]) continue
      if (!value) {
        setError('已有承诺不能清空，请填写新的真实日期。')
        return
      }
      changes[`${type}Committed`] = value
      if (base.values[type] && !reasons[type]?.trim()) {
        setError('修改已有承诺必须说明改期原因。')
        return
      }
      changeReasons[`${type}Committed`] = reasons[type] || ''
    }
    if (!Object.keys(changes).length) {
      setMessage('没有需要保存的日期变化。')
      return
    }
    if (!begin('save')) return
    let committed = false
    try {
      const result = await api<{ version: number }>(
        `/projects/${project.id}/manufacturing-plan`,
        'PUT',
        { expectedVersion: base.version, ...changes, changeReasons },
      )
      committed = true
      setSaved(true)
      setBase({ version: result.version, values: { ...values } })
      setReasons({})
      setMessage('制造承诺已保存，无需重复提交。')
      await onSaved()
      setMessage('制造承诺已保存，齐套预测和历史已更新。')
      setSaved(false)
    } catch (err) {
      if (!committed) setNeedsReload(true)
      setError(
        `${committed ? '制造承诺已保存，列表刷新失败。请重试刷新，无需再次提交。' : '填写内容已保留，请刷新最新计划并核对后继续。'} ${err instanceof Error ? err.message : '请求未完成。'}`,
      )
    } finally {
      finish()
    }
  }
  return (
    <section
      className="npi-panel npi-inline-manufacturing"
      aria-label="制造部集中回复"
    >
      <div className="npi-panel-title">
        <div>
          <h2>制造部集中回复</h2>
          <p>一次回复四个节点；改期原因随日期一起保存。</p>
        </div>
        <div className="npi-reply-actions">
          {!readOnly && onException && (
            <button
              className="npi-button secondary"
              disabled={
                busy || locked || saved || needsReload || reviewRequired
              }
              onClick={onException}
            >
              添加异常件
            </button>
          )}
          {!saved && (
            <button
              type="button"
              className="npi-button secondary"
              disabled={busy || disabled}
              onClick={() => void reload()}
            >
              {operation === 'read' ? '正在读取…' : '刷新最新计划'}
            </button>
          )}
        </div>
      </div>
      {(saved || reviewRequired || message || error) && (
        <div className="npi-reply-feedback">
          {!saved && reviewRequired && (
            <div className="npi-alert">
              制造计划已读取或更新，当前输入仍保留。核对后载入最新计划继续。
              <button
                type="button"
                disabled={busy || locked}
                onClick={acceptLatest}
              >
                载入最新计划
              </button>
            </div>
          )}
          {message && <p role="status">{message}</p>}
          {error && (
            <p role="alert" className="npi-error-text">
              {error}
            </p>
          )}
          {saved && (
            <button
              type="button"
              className="npi-button secondary"
              disabled={busy || disabled}
              onClick={() => void retryRefresh()}
            >
              {operation === 'refresh' ? '正在刷新…' : '重试刷新列表'}
            </button>
          )}
        </div>
      )}
      <form onSubmit={save}>
        <fieldset disabled={busy || locked || saved}>
          <div className="npi-inline-dates">
            {Object.entries(nodeNames).map(([type, label]) => {
              const item = current.items.find((i) => i.trackingType === type)
              const changed =
                !!base.values[type] && values[type] !== base.values[type]
              return (
                <div key={type}>
                  <label>
                    {label}
                    <input
                      aria-label={`${label}承诺日期`}
                      type="date"
                      value={
                        item?.actualCompleteDate
                          ? item.currentCommittedDate || ''
                          : values[type] || ''
                      }
                      disabled={!!item?.actualCompleteDate}
                      onChange={(e) =>
                        setValues({ ...values, [type]: e.target.value })
                      }
                    />
                  </label>
                  <small>
                    要求 {item?.requiredDate} · 当前承诺{' '}
                    {(saved ? base.values[type] : item?.currentCommittedDate) ||
                      '待回复'}{' '}
                    · 实际 {item?.actualCompleteDate || '未完成'}
                  </small>
                  {changed && !item?.actualCompleteDate && (
                    <label className="npi-inline-reason">
                      改期原因
                      <input
                        aria-label={`${label}改期原因`}
                        value={reasons[type] || ''}
                        required
                        maxLength={1000}
                        onChange={(e) =>
                          setReasons({ ...reasons, [type]: e.target.value })
                        }
                      />
                    </label>
                  )}
                </div>
              )
            })}
          </div>
          <div className="npi-inline-save">
            <span>首次承诺永久保留，已完成节点不修改。</span>
            {onCancel && (
              <button
                type="button"
                className="npi-button secondary"
                onClick={onCancel}
              >
                取消
              </button>
            )}
            {readOnly ? (
              <span>由项目制造负责人回复</span>
            ) : (
              <button
                className="npi-button"
                type="submit"
                disabled={needsReload || reviewRequired}
              >
                {operation === 'save' ? '正在保存…' : '保存制造回复'}
              </button>
            )}
          </div>
        </fieldset>
      </form>
    </section>
  )
}
