// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import type { FormEvent } from 'react'
import type {
  NpiMetadata,
  NpiTracking,
  ProjectDetail,
} from '../../lib/npi/service'

type CreatedMaterial = { id: string; name: string }

export function NpiExternalMaterial({
  project,
  meta,
  api,
  onClose,
  onSaved,
  onOpenFiles,
}: {
  project: ProjectDetail
  meta: NpiMetadata
  api: <T>(path: string, method?: string, data?: unknown) => Promise<T>
  onClose: () => void
  onSaved: (created: CreatedMaterial) => Promise<NpiTracking>
  onOpenFiles?: (item: NpiTracking) => void
}) {
  const buyers = meta.users.filter((u) => u.role === 'procurement')
  const makers = meta.users.filter((u) =>
    ['manufacturing', 'technical'].includes(u.role || ''),
  )
  const recent = buyers.some((u) => u.id === meta.recentProcurementOwnerId)
    ? meta.recentProcurementOwnerId || ''
    : ''
  const [type, setType] = useState<'purchase' | 'material' | 'other'>(
    'purchase',
  )
  const [ownerIds, setOwnerIds] = useState({
    purchase: recent,
    material: '',
    other: '',
  })
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [saved, setSaved] = useState<CreatedMaterial | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const pending = useRef(false)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (error && dialog.current) dialog.current.scrollTop = 0
  }, [error])
  const attempt = useRef<{
    data: Record<string, unknown>
    openFiles: boolean
  } | null>(null)
  const options = type === 'purchase' ? buyers : makers
  const afterSave = async (created: CreatedMaterial) => {
    const item = await onSaved(created)
    if (item.id !== created.id)
      throw Error('新增物料尚未出现在最新清单，请重试刷新。')
    onClose()
    if (attempt.current?.openFiles) onOpenFiles?.(item)
  }
  const retryRefresh = async () => {
    if (pending.current || !saved) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await afterSave(saved)
    } catch (err) {
      setError(
        `物料已新增，列表仍未刷新。${err instanceof Error ? err.message : '请重试刷新。'}`,
      )
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const saveAttempt = async () => {
    if (pending.current || saved || !attempt.current) return
    pending.current = true
    setBusy(true)
    setError('')
    let committed = false
    try {
      const created = await api<CreatedMaterial>(
        `/projects/${project.id}/external-items`,
        'POST',
        attempt.current.data,
      )
      if (!created.id || typeof created.id !== 'string')
        throw Error('未收到有效物料编号，请重试本次保存核对。')
      committed = true
      setSaved(created)
      setUncertain(false)
      await afterSave(created)
    } catch (submitError) {
      const status =
        submitError &&
        typeof submitError === 'object' &&
        'status' in submitError
          ? submitError.status
          : undefined
      const rejected = status === 400 || status === 422
      if (!committed) {
        setUncertain(!rejected)
        if (rejected) attempt.current = null
      }
      setError(
        `${committed ? '物料已新增，列表刷新失败。请重试刷新，无需再次创建。' : rejected ? '物料未新增，请调整填写内容后保存。' : '保存结果待确认，填写内容已保留。请重试本次保存，同一提交不会重复新增；关闭后请先核对项目清单。'} ${submitError instanceof Error ? submitError.message : '请求未完成。'}`,
      )
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (pending.current || saved || uncertain) return
    const data = new FormData(e.currentTarget)
    const submitter = (e.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null
    attempt.current = {
      openFiles: submitter?.value === 'files',
      data: {
        requestId: crypto.randomUUID(),
        name: data.get('name'),
        specification: data.get('specification'),
        qty: data.get('qty'),
        unit: data.get('unit'),
        trackingType: type,
        ownerId: ownerIds[type],
        requiredDate: data.get('requiredDate'),
        supplier: data.get('supplier'),
        affectsKit: data.has('affectsKit'),
        remark: data.get('remark'),
      },
    }
    await saveAttempt()
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
        className="npi-modal npi-external-material-dialog"
        data-saving={busy}
      >
        <DialogTitle>添加BOM外物料</DialogTitle>
        <DialogDescription>
          采购件、临时样机件或其他试验用品；保存后进入责任人的待回复清单，可直接补充PDF或图片。
        </DialogDescription>
        {(saved || error || uncertain) && (
          <div className="npi-external-feedback">
            {saved && (
              <p role="status">「{saved.name}」已新增，无需重复创建。</p>
            )}
            {error && (
              <p role="alert" className="npi-message error">
                {error}
              </p>
            )}
            {(saved || uncertain) && (
              <div className="npi-actions">
                <button
                  type="button"
                  className="npi-button"
                  disabled={busy}
                  onClick={() => void (saved ? retryRefresh() : saveAttempt())}
                >
                  {busy ? '正在处理…' : saved ? '重试刷新列表' : '重试本次保存'}
                </button>
              </div>
            )}
          </div>
        )}
        <form onSubmit={submit}>
          <fieldset
            disabled={busy || !!saved || uncertain}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <div className="npi-form-grid">
              <label>
                <span>物料名称</span>
                <input name="name" required maxLength={255} />
              </label>
              <label>
                <span>规格</span>
                <input name="specification" maxLength={1000} />
              </label>
              <label>
                <span>数量</span>
                <input
                  name="qty"
                  defaultValue="1"
                  required
                  inputMode="decimal"
                />
              </label>
              <label>
                <span>单位</span>
                <input name="unit" defaultValue="只" maxLength={30} />
              </label>
              <label>
                <span>物料类型</span>
                <select
                  aria-label="物料类型"
                  value={type}
                  onChange={(e) =>
                    setType(e.target.value as 'purchase' | 'material' | 'other')
                  }
                >
                  <option value="purchase">BOM外采购件</option>
                  <option value="material">临时样机件</option>
                  <option value="other">其他物料</option>
                </select>
              </label>
              <label>
                <span>回复责任人</span>
                <select
                  aria-label="回复责任人"
                  required
                  value={ownerIds[type]}
                  onChange={(e) =>
                    setOwnerIds({ ...ownerIds, [type]: e.target.value })
                  }
                >
                  <option value="" disabled>
                    请选择
                  </option>
                  {options.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || u.email} ·{' '}
                      {u.role === 'procurement'
                        ? '采购'
                        : u.role === 'technical'
                          ? '技术负责人'
                          : '制造负责人'}
                    </option>
                  ))}
                </select>
              </label>
              {!options.length && (
                <p style={{ gridColumn: '1 / -1' }} role="status">
                  暂无可选{type === 'purchase' ? '采购' : '技术或制造'}
                  人员，请管理员配置对应岗位。
                </p>
              )}
              {type === 'purchase' &&
                recent &&
                ownerIds.purchase === recent && (
                  <p className="npi-muted" style={{ gridColumn: '1 / -1' }}>
                    已预选你最近一次使用的采购责任人，可重新选择。
                  </p>
                )}
              <label>
                <span>要求日期</span>
                <input
                  name="requiredDate"
                  type="date"
                  required
                  defaultValue={project.requiredKitDate}
                />
              </label>
              <label>
                <span>供应商</span>
                <input name="supplier" maxLength={255} />
              </label>
              <label>
                <span className="npi-checkbox">
                  <input name="affectsKit" type="checkbox" defaultChecked />
                  影响齐套
                </span>
              </label>
              <label className="wide">
                <span>备注</span>
                <textarea name="remark" rows={3} maxLength={2000} />
              </label>
            </div>
          </fieldset>
          <div className="npi-actions">
            <button
              type="button"
              className="npi-button secondary"
              disabled={busy}
              onClick={onClose}
            >
              {saved ? '关闭' : '取消'}
            </button>
            <button
              type="submit"
              className="npi-button"
              disabled={busy || !options.length || !!saved || uncertain}
            >
              {busy ? '正在保存…' : '保存'}
            </button>
            {onOpenFiles && (
              <button
                type="submit"
                name="afterSave"
                value="files"
                className="npi-button secondary"
                disabled={busy || !options.length || !!saved || uncertain}
              >
                保存并补充资料
              </button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
