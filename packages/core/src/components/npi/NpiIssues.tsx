// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import { NpiFiles } from './NpiFiles'
import { useNpiFileOperation } from './useNpiFileOperation'
import type { FormEvent } from 'react'
import type { NpiIssue, NpiIssueDetail } from '../../lib/npi/issue-service'
import type { NpiMetadata, ProjectDetail } from '../../lib/npi/service'
import type { BomRow } from '../../lib/npi/bom'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
const states: Record<string, string> = {
  Open: '新建',
  InProgress: '处理中',
  Pending: '等待反馈',
  Resolved: '已解决',
  Verified: '已验证',
  Closed: '已关闭',
  Cancelled: '已取消',
}
const severities: Record<string, string> = {
  Medium: '一般',
  High: '重要',
  Critical: '重大',
  Low: '一般',
}
const stamp = (value: Date | string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
export function NpiIssues({
  api,
  meta,
  project,
  onChanged,
}: {
  api: Api
  meta: NpiMetadata
  project?: ProjectDetail
  onChanged: () => Promise<void>
}) {
  const [list, setList] = useState<Array<NpiIssue>>([])
  const [detail, setDetail] = useState<NpiIssueDetail | null>(null)
  const fileOperation = useNpiFileOperation(detail?.id || null)
  const [mode, setMode] = useState<'create' | 'edit' | 'view' | null>(null)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const [bom, setBom] = useState<Array<BomRow>>([])
  const readonly =
    meta.actor.role === 'supervisor' || project?.currentNpiStage === 'completed'
  const manage =
    !!project &&
    ['technical', 'manufacturing', 'admin'].includes(meta.actor.role) &&
    !readonly
  const projectId = project?.id
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [notice, setNotice] = useState('')
  const pending = useRef(false),
    generation = useRef(0),
    listRevision = useRef(0)
  const noteRequest = useRef<{
    issueId: string
    message: string
    requestId: string
  } | null>(null)
  const blocked =
    busy || fileOperation.busy || loading || !!loadError || !!refreshError
  const reload = useCallback(async () => {
    const revision = ++listRevision.current
    setLoading(true)
    setLoadError('')
    try {
      const next = await api<Array<NpiIssue>>(
        projectId ? `/projects/${projectId}/issues` : '/workbench/issues',
      )
      if (revision === listRevision.current) setList(next)
    } catch (e) {
      if (revision === listRevision.current)
        setLoadError(e instanceof Error ? e.message : '读取问题列表失败')
      throw e
    } finally {
      if (revision === listRevision.current) setLoading(false)
    }
  }, [api, projectId])
  useEffect(() => {
    generation.current++
    setList([])
    setMode(null)
    setDetail(null)
    setError('')
    setNotice('')
    setRefreshError('')
    void reload().catch(() => {})
    return () => {
      generation.current++
      listRevision.current++
    }
  }, [reload])
  const refresh = async (id?: string, current = generation.current) => {
    if (id) {
      const next = await api<NpiIssueDetail>(`/issues/${id}`)
      if (current !== generation.current) return
      setDetail(next)
    }
    await reload()
    if (current !== generation.current) return
    await onChanged()
    if (current === generation.current) setRefreshError('')
  }
  const retryRefresh = async () => {
    if (pending.current || fileOperation.isBusy()) return
    pending.current = true
    setBusy(true)
    const current = generation.current
    try {
      await refresh(mode === 'view' ? detail?.id : undefined, current)
    } catch (e) {
      if (current === generation.current)
        setRefreshError(e instanceof Error ? e.message : '刷新失败')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const open = async (id: string) => {
    if (blocked || pending.current || fileOperation.isBusy()) return
    pending.current = true
    setError('')
    setNotice('')
    setBusy(true)
    const current = generation.current
    try {
      const next = await api<NpiIssueDetail>(`/issues/${id}`)
      if (current !== generation.current) return
      setDetail(next)
      setMode('view')
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : '读取问题失败')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const create = async () => {
    if (!project || blocked || pending.current || fileOperation.isBusy()) return
    pending.current = true
    const current = generation.current
    setError('')
    setNotice('')
    setBusy(true)
    try {
      const tree = await api<{ rows: Array<BomRow> }>(
        `/projects/${project.id}/bom/tree`,
      )
      if (current !== generation.current) return
      setBom(tree.rows)
      setDetail(null)
      setMode('create')
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : '读取关联物料失败')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const mutation = async (
    path: string,
    method: string,
    data: unknown,
    close = false,
    onSaved?: () => void,
  ) => {
    if (blocked || pending.current || fileOperation.isBusy()) return
    pending.current = true
    const current = generation.current
    setBusy(true)
    setError('')
    setNotice('')
    let saved = false
    try {
      await api(path, method, data)
      saved = true
      if (current !== generation.current) return
      onSaved?.()
      setNotice('已保存成功，无需重复提交。')
      if (close) setMode(null)
      await refresh(close ? undefined : detail?.id, current)
    } catch (e) {
      if (current !== generation.current) return
      const message = e instanceof Error ? e.message : '请稍后重试'
      if (saved) setRefreshError(message)
      else
        setError(
          path.endsWith('/notes')
            ? `未收到保存确认，填写内容已保留。可直接重试当前记录：${message}`
            : `提交失败，填写内容已保留：${message}`,
        )
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!project) return
    const f = new FormData(e.currentTarget)
    const data: Record<string, unknown> = Object.fromEntries(f)
    if (mode === 'edit' && detail) {
      data.expectedVersion = detail.version
      data.expectedModifiedAt = detail.modifiedAt
      void mutation(`/issues/${detail.id}`, 'PATCH', data, true)
    } else {
      const [type, id] = String(data.related || '').split(':')
      if (type === 'track') data.trackingItemId = id
      if (type === 'bom') data.bomItemId = id
      delete data.related
      void mutation(`/projects/${project.id}/issues`, 'POST', data, true)
    }
  }
  const choices = meta.users.filter(
    (u) =>
      u.role === 'procurement' ||
      u.id === project?.technicalOwnerId ||
      u.id === project?.manufacturingOwnerId ||
      (u.id === meta.actor.id && meta.actor.role === 'admin'),
  )
  return (
    <section className="npi-panel npi-issues">
      <div className="npi-panel-title">
        <div>
          <h2>{project ? '项目问题' : '我负责的问题'}</h2>
          <p>协调异常、追踪处理结果；重大问题关闭后解除风险提示。</p>
        </div>
        {manage && (
          <button
            className="npi-button"
            onClick={() => void create()}
            disabled={blocked}
          >
            新建问题
          </button>
        )}
      </div>
      <button
        className="npi-button secondary"
        disabled={busy || fileOperation.busy || loading}
        onClick={() => void retryRefresh()}
      >
        刷新问题
      </button>
      {notice && !mode && (
        <p role="status" className="npi-message">
          {notice}
        </p>
      )}
      {(loadError || refreshError) && !mode && (
        <p role="alert" className="npi-message error">
          问题刷新失败：{refreshError || loadError}。请点击“刷新问题”重试。
          {list.length > 0 && '当前显示上次读取的记录。'}
        </p>
      )}
      {loading && <p role="status">正在读取问题…</p>}
      <label className="npi-issue-filter">
        <input
          type="checkbox"
          checked={showClosed}
          onChange={(e) => setShowClosed(e.target.checked)}
        />{' '}
        包含已关闭 / 已取消
      </label>
      {error && !mode && (
        <p role="alert" className="npi-message error">
          {error}
        </p>
      )}
      <div className="npi-issue-list">
        {list
          .filter(
            (i) => showClosed || !['Closed', 'Cancelled'].includes(i.state),
          )
          .map((i) => (
            <button
              key={i.id}
              className="npi-issue-card"
              onClick={() => void open(i.id)}
              disabled={blocked}
            >
              <span
                className={`npi-badge ${i.severity === 'Critical' ? 'npi-overdue' : i.severity === 'High' ? 'npi-risk' : 'npi-normal'}`}
              >
                {severities[i.severity] || i.severity}
              </span>
              <strong>{i.title}</strong>
              <span>{states[i.state] || i.state}</span>
              <small>
                {i.ownerName} · 计划关闭 {i.targetDate}
                {i.overdue ? ' · 已超期' : ''}
                {!project ? ` · ${i.projectName}` : ''}
              </small>
            </button>
          ))}
        {!loading &&
          !loadError &&
          !refreshError &&
          !list.some(
            (i) => showClosed || !['Closed', 'Cancelled'].includes(i.state),
          ) && <p className="npi-empty">暂无符合条件的项目问题。</p>}
      </div>
      <Dialog
        open={!!mode}
        onOpenChange={(value) => {
          if (!value && !pending.current && !fileOperation.isBusy()) {
            setMode(null)
            setError('')
          }
        }}
      >
        <DialogContent
          className="npi-modal npi-file-operation-dialog"
          data-saving={busy || fileOperation.busy}
        >
          <DialogTitle>
            {mode === 'create'
              ? '新建项目问题'
              : mode === 'edit'
                ? '修改项目问题'
                : detail?.title}
          </DialogTitle>
          <DialogDescription>
            {mode === 'view'
              ? `${detail?.number} · ${states[detail?.state || ''] || detail?.state}`
              : '问题用于需要协调的异常；普通承诺改期请在原跟踪项中处理。'}
          </DialogDescription>
          {(mode === 'create' || mode === 'edit') && (
            <form key={`${mode}-${detail?.id || 'new'}`} onSubmit={save}>
              <fieldset
                disabled={blocked}
                style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
              >
                <div className="npi-form-grid">
                  <label className="wide">
                    问题标题
                    <input
                      name="title"
                      maxLength={200}
                      defaultValue={mode === 'edit' ? detail?.title : ''}
                      required
                    />
                  </label>
                  <label className="wide">
                    问题说明
                    <textarea
                      name="description"
                      rows={4}
                      maxLength={10000}
                      defaultValue={mode === 'edit' ? detail?.description : ''}
                      required
                    />
                  </label>
                  <label>
                    严重度
                    <select
                      name="severity"
                      aria-label="严重度"
                      defaultValue={detail?.severity || 'Medium'}
                    >
                      <option value="Medium">一般</option>
                      <option value="High">重要</option>
                      <option value="Critical">重大</option>
                    </select>
                  </label>
                  <label>
                    问题责任人
                    <select
                      name="ownerId"
                      aria-label="问题责任人"
                      defaultValue={
                        detail?.ownerId || project?.manufacturingOwnerId || ''
                      }
                      required
                    >
                      {choices.map((u) => (
                        <option value={u.id} key={u.id}>
                          {u.name || u.email}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    计划关闭日期
                    <input
                      type="date"
                      name="targetDate"
                      defaultValue={
                        detail?.targetDate || project?.requiredKitDate
                      }
                      required
                    />
                  </label>
                  {mode === 'create' && (
                    <label>
                      关联对象
                      <select aria-label="关联对象" name="related">
                        <option value="">整个项目</option>
                        <optgroup label="制造节点 / 重点物料 / BOM外物料">
                          {project?.items.map((i) => (
                            <option value={`track:${i.id}`} key={i.id}>
                              {i.name}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="当前BOM物料">
                          {bom.map((i) => (
                            <option key={i.id} value={`bom:${i.id}`}>
                              {i.materialCode} · {i.materialName} · 第{i.rowNo}
                              行
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </label>
                  )}
                  {mode === 'edit' && (
                    <label className="wide">
                      修改原因
                      <textarea
                        name="reason"
                        rows={3}
                        maxLength={2000}
                        required
                      />
                    </label>
                  )}
                </div>
                <div className="npi-actions">
                  <button
                    className="npi-button secondary"
                    type="button"
                    disabled={blocked}
                    onClick={() => setMode(null)}
                  >
                    取消
                  </button>
                  <button className="npi-button" disabled={blocked}>
                    保存问题
                  </button>
                </div>
              </fieldset>
            </form>
          )}
          {mode === 'view' && detail && (
            <>
              {notice && (
                <p role="status" className="npi-message">
                  {notice}
                </p>
              )}
              {(loadError || refreshError) && (
                <p role="alert" className="npi-message error">
                  问题刷新失败：{refreshError || loadError}
                  。已保存的内容无需重新提交。
                </p>
              )}
              <button
                type="button"
                className="npi-button secondary"
                disabled={busy || fileOperation.busy || loading}
                onClick={() => void retryRefresh()}
              >
                刷新问题详情
              </button>
              <p>
                {severities[detail.severity]} · {detail.ownerName} · 计划关闭{' '}
                {detail.targetDate}
              </p>
              <p>关联：{detail.relatedLabel}</p>
              <p className="npi-issue-description">{detail.description}</p>
              {manage && !['Closed', 'Cancelled'].includes(detail.state) && (
                <button
                  className="npi-button secondary"
                  disabled={blocked}
                  onClick={() => {
                    setError('')
                    setMode('edit')
                  }}
                >
                  修改问题资料
                </button>
              )}
              {!readonly && detail.transitions.length > 0 && (
                <form
                  key={detail.state}
                  onSubmit={(e) => {
                    e.preventDefault()
                    const f = new FormData(e.currentTarget)
                    void mutation(`/issues/${detail.id}/transition`, 'POST', {
                      toState: f.get('toState'),
                      comments: f.get('comments'),
                      expectedVersion: detail.version,
                      expectedModifiedAt: detail.modifiedAt,
                    })
                  }}
                >
                  <fieldset
                    disabled={blocked}
                    style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
                  >
                    <div className="npi-form-grid">
                      <label>
                        推进状态
                        <select aria-label="推进状态" name="toState">
                          {detail.transitions.map((t) => (
                            <option value={t.toStateId} key={t.id}>
                              {states[t.toStateId] || t.toStateName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="wide">
                        处理说明
                        <textarea
                          name="comments"
                          rows={3}
                          maxLength={5000}
                          required
                        />
                      </label>
                    </div>
                    <button className="npi-button" disabled={blocked}>
                      更新状态
                    </button>
                  </fieldset>
                </form>
              )}
              {!readonly && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    const form = e.currentTarget
                    const f = new FormData(form)
                    const message = String(f.get('message') || '')
                    if (
                      noteRequest.current?.issueId !== detail.id ||
                      noteRequest.current.message !== message
                    )
                      noteRequest.current = {
                        issueId: detail.id,
                        message,
                        requestId: crypto.randomUUID(),
                      }
                    void mutation(
                      `/issues/${detail.id}/notes`,
                      'POST',
                      {
                        message,
                        requestId: noteRequest.current.requestId,
                      },
                      false,
                      () => {
                        noteRequest.current = null
                        form.reset()
                      },
                    )
                  }}
                >
                  <fieldset
                    disabled={blocked}
                    style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
                  >
                    <label className="npi-issue-note">
                      补充处理记录
                      <textarea
                        name="message"
                        rows={3}
                        maxLength={5000}
                        required
                      />
                    </label>
                    <button className="npi-button secondary" disabled={blocked}>
                      记录进展
                    </button>
                  </fieldset>
                </form>
              )}
              <NpiFiles
                key={detail.id}
                api={api}
                scope={{ kind: 'issue', id: detail.id }}
                readOnly={
                  readonly || ['Closed', 'Cancelled'].includes(detail.state)
                }
                buyer={meta.actor.role === 'procurement'}
                onBusyChange={fileOperation.onBusyChange}
                disabled={busy || loading || !!loadError || !!refreshError}
              />
              <h3>处理时间线</h3>
              {[
                ...detail.history.map((h) => ({
                  id: h.id,
                  at: h.timestamp,
                  text: `${states[h.fromState || ''] || h.fromState || '新建'} → ${states[h.toState] || h.toState}`,
                  note: h.comments || '',
                  actor:
                    meta.users.find((u) => u.id === h.actorId)?.name ||
                    (h.actorId === meta.actor.id
                      ? meta.actor.name
                      : '系统用户'),
                })),
                ...detail.notes.map((n) => ({
                  id: n.id,
                  at: n.createdAt,
                  text:
                    n.action === 'ISSUE_CREATED'
                      ? '创建问题'
                      : n.action === 'ISSUE_UPDATED'
                        ? '修改问题资料'
                        : '处理记录',
                  note: String(
                    (n.detail as { message?: string; reason?: string })
                      .message ||
                      (n.detail as { reason?: string }).reason ||
                      '',
                  ),
                  actor: n.actorName || '系统用户',
                })),
              ]
                .sort(
                  (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
                )
                .map((h) => (
                  <div className="npi-history" key={h.id}>
                    <div>
                      <strong>{h.text}</strong>
                      <p>{h.note}</p>
                      <small>
                        {h.actor} · {stamp(h.at)}
                      </small>
                    </div>
                  </div>
                ))}
            </>
          )}
          {error && mode && (
            <p role="alert" className="npi-message error">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
