// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react'
import { profileFields } from '../../lib/npi/project-profile'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import type { FormEvent } from 'react'
import type { NpiMetadata, ProjectDetail } from '../../lib/npi/service'
import type { InheritancePreview } from '../../lib/npi/project-inheritance'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export function NpiProjectInheritance({
  api,
  meta,
  project,
  onCreated,
}: {
  api: Api
  meta: NpiMetadata
  project: ProjectDetail
  onCreated: (id: string, canContinue: boolean) => Promise<void>
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [code, setCode] = useState(''),
    [copyBom, setCopyBom] = useState(true),
    [copyExternal, setCopyExternal] = useState(true)
  const [proposal, setProposal] = useState<Record<string, unknown>>({})
  const [preview, setPreview] = useState<InheritancePreview | null>(null)
  const value = (key: string, fallback = '') =>
    typeof proposal[key] === 'string' ? proposal[key] : fallback
  const edit = () => {
    setCode(
      `NPI-${new Date().getFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    )
    setOpen(true)
    setError('')
    setProposal({})
    setPreview(null)
    setCopyBom(true)
    setCopyExternal(true)
  }
  const review = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    const data = {
      ...Object.fromEntries(new FormData(e.currentTarget)),
      code,
      copyBom,
      copyExternal,
    }
    try {
      setProposal(data)
      setPreview(
        await api<InheritancePreview>(
          `/projects/${project.id}/inheritance-preview`,
          'POST',
          data,
        ),
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '继承预览失败')
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    if (!preview || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api<{ id: string; canContinue: boolean }>(
        `/projects/${project.id}/inherit`,
        'POST',
        { ...proposal, expectedSnapshot: preview.expectedSnapshot },
      )
      setOpen(false)
      await onCreated(result.id, result.canContinue)
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败，请重新预览核对')
    } finally {
      setBusy(false)
    }
  }
  const people = (
    key: string,
    label: string,
    role: string,
    defaultId: string,
    required = true,
  ) => (
    <label>
      {label}
      <select
        name={key}
        aria-label={label}
        defaultValue={value(key, defaultId)}
        required={required}
      >
        <option value="">请选择</option>
        {meta.users
          .filter(
            (u) =>
              u.role === role ||
              u.role === 'admin' ||
              (u.id === meta.actor.id && meta.actor.role === 'admin'),
          )
          .map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.email}
            </option>
          ))}
      </select>
    </label>
  )
  return (
    <>
      <button className="npi-button secondary" onClick={edit}>
        以此项目新建
      </button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v)
        }}
      >
        <DialogContent
          className="npi-modal npi-inherit-modal"
          style={{ maxWidth: 860 }}
        >
          <DialogTitle>
            {preview ? '确认继承并新建' : '从相似项目新建'}
          </DialogTitle>
          <DialogDescription>
            来源：{project.name}
            。复用项目参数和物料配置，新的时间承诺由各负责人重新回复。
          </DialogDescription>
          {error && (
            <div className="npi-error" role="alert">
              {error}
            </div>
          )}
          {!preview ? (
            <form onSubmit={(e) => void review(e)}>
              <div className="npi-form-grid">
                <label>
                  新品名称
                  <input
                    name="name"
                    aria-label="新品名称"
                    maxLength={200}
                    required
                    defaultValue={value(
                      'name',
                      project.name.slice(0, 190) + '（新项目）',
                    )}
                  />
                </label>
                <label>
                  电机型号
                  <input
                    name="motorModel"
                    aria-label="电机型号"
                    maxLength={150}
                    required
                    defaultValue={value('motorModel', project.motorModel)}
                  />
                </label>
                {people(
                  'technicalOwnerId',
                  '技术负责人',
                  'technical',
                  meta.actor.role === 'technical'
                    ? meta.actor.id
                    : project.technicalOwnerId,
                )}
                {people(
                  'manufacturingOwnerId',
                  '制造负责人',
                  'manufacturing',
                  project.manufacturingOwnerId,
                )}
                <label>
                  要求齐套日期
                  <input
                    type="date"
                    name="requiredKitDate"
                    aria-label="要求齐套日期"
                    required
                    defaultValue={value('requiredKitDate')}
                  />
                </label>
                <label>
                  样机要求日期
                  <input
                    type="date"
                    name="prototypeRequiredDate"
                    aria-label="样机要求日期"
                    required
                    defaultValue={value('prototypeRequiredDate')}
                  />
                </label>
                <label className="npi-checkbox">
                  <input
                    type="checkbox"
                    checked={copyBom}
                    onChange={(e) => setCopyBom(e.target.checked)}
                  />
                  当前BOM与重点跟踪配置
                </label>
                <label className="npi-checkbox">
                  <input
                    type="checkbox"
                    checked={copyExternal}
                    onChange={(e) => setCopyExternal(e.target.checked)}
                  />
                  启用的BOM外物料
                </label>
                {(copyBom || copyExternal) &&
                  people(
                    'procurementOwnerId',
                    '继承采购件负责人',
                    'procurement',
                    '',
                    false,
                  )}
                <p className="wide">
                  采购件统一交给选定采购负责人（有采购件时必选）；原技术负责的物料交新技术负责人，其余加工物料交新制造负责人。继承物料的要求日期统一设为新项目要求齐套日期，可在建项后逐项调整。
                </p>
                <details className="wide">
                  <summary>核对客户与电机参数</summary>
                  <div className="npi-form-grid">
                    {profileFields.map((field) => (
                      <label
                        key={field.key}
                        className={field.kind === 'textarea' ? 'wide' : ''}
                      >
                        {field.label}
                        {field.kind === 'textarea' ? (
                          <textarea
                            name={field.key}
                            aria-label={field.label}
                            defaultValue={value(
                              field.key,
                              project.profile[field.key],
                            )}
                            maxLength={field.max}
                            rows={3}
                          />
                        ) : (
                          <input
                            name={field.key}
                            aria-label={field.label}
                            defaultValue={value(
                              field.key,
                              project.profile[field.key],
                            )}
                            maxLength={field.max}
                            inputMode={
                              field.kind === 'decimal'
                                ? 'decimal'
                                : field.kind === 'integer'
                                  ? 'numeric'
                                  : 'text'
                            }
                          />
                        )}
                      </label>
                    ))}
                  </div>
                </details>
              </div>
              <div className="npi-actions">
                <button
                  className="npi-button secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => setOpen(false)}
                >
                  取消
                </button>
                <button className="npi-button" disabled={busy}>
                  预览继承范围
                </button>
              </div>
            </form>
          ) : (
            <section aria-label="项目继承预览">
              <h3>{preview.target.name}</h3>
              <p>
                新项目编号：{preview.target.code} · 型号：
                {preview.target.motorModel}
              </p>
              <p>
                要求齐套 {preview.target.requiredKitDate} · 样机要求{' '}
                {preview.target.prototypeRequiredDate}
              </p>
              <p>
                技术：
                {
                  meta.users.find(
                    (u) => u.id === preview.target.technicalOwnerId,
                  )?.name
                }{' '}
                · 制造：
                {
                  meta.users.find(
                    (u) => u.id === preview.target.manufacturingOwnerId,
                  )?.name
                }
              </p>
              <p>
                当前BOM {preview.counts.bomRows} 行 · 重点跟踪{' '}
                {preview.counts.bomTracking} 项 · BOM外物料{' '}
                {preview.counts.external} 项
              </p>
              <p>
                新项目从“设计中”开始。承诺、实际完成日期、改期历史、问题、文件附件和草稿均不复制；源项目保持原样。源BOM原始Excel及母件信息原样保留；新型号如需变更物料，应在新项目重新导入适用BOM。
              </p>
              <details>
                <summary>查看新项目参数</summary>
                {profileFields.map((f) => (
                  <p key={f.key}>
                    {f.label}：{preview.target[f.key] || '未填写'}
                  </p>
                ))}
              </details>
              {preview.assignments.length > 0 && (
                <div className="npi-preview-scroll">
                  <table className="npi-table">
                    <thead>
                      <tr>
                        <th>继承物料</th>
                        <th>新回复责任人</th>
                        <th>新要求日期</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.assignments.map((a) => (
                        <tr key={a.sourceItemId}>
                          <td>
                            {a.name}
                            <details>
                              <summary>物料配置</summary>
                              <p>
                                {a.specification || '未填写规格'} · {a.qty}{' '}
                                {a.unit}
                              </p>
                              <p>
                                供应商：{a.supplier || '未填写'} ·{' '}
                                {a.affectsKit ? '影响齐套' : '不影响齐套'}
                              </p>
                              <p>{a.remark || '无备注'}</p>
                            </details>
                          </td>
                          <td>{a.ownerName}</td>
                          <td>{a.requiredDate}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="npi-actions">
                <button
                  className="npi-button secondary"
                  disabled={busy}
                  onClick={() => setPreview(null)}
                >
                  返回调整
                </button>
                <button
                  className="npi-button"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  确认新建项目
                </button>
              </div>
            </section>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

export function InheritanceDetail({
  action,
  detail,
}: {
  action: string
  detail: unknown
}) {
  if (action !== 'PROJECT_INHERITED' || !detail || typeof detail !== 'object')
    return null
  const data = detail as {
    sourceName?: unknown
    sourceCode?: unknown
    counts?: { bomRows?: unknown; bomTracking?: unknown; external?: unknown }
  }
  if (
    typeof data.sourceName !== 'string' ||
    typeof data.sourceCode !== 'string'
  )
    return null
  const count = (n: unknown) =>
    typeof n === 'number' && Number.isFinite(n) ? n : 0
  return (
    <p>
      来源：{data.sourceName}（{data.sourceCode}）；继承BOM{' '}
      {count(data.counts?.bomRows)} 行、重点跟踪{' '}
      {count(data.counts?.bomTracking)} 项、BOM外物料{' '}
      {count(data.counts?.external)} 项。承诺与完成记录已重新开始。
    </p>
  )
}
