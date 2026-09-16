// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react'
import { validateTemplate } from '../../lib/npi/bom'
import { trackingPropertyHelp } from '../../lib/npi/bom-tracking'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import type { ImportTemplate } from '../../lib/npi/bom'
import type { FormEvent } from 'react'

export type TemplateDraft = {
  config: ImportTemplate
  version: number
  enabled: boolean
}
const fields = [
  ['level', '层级', true],
  ['materialCode', '物料编码', true],
  ['materialName', '物料名称', true],
  ['qty', '基本用量', true],
  ['lineNo', '子件行号', false],
  ['specification', '规格', false],
  ['unit', '计量单位', false],
  ['supplyType', '供应类型', false],
  ['warehouse', '仓库', false],
  ['issueDepartment', '领料部门', false],
  ['effectiveDate', '生效日期', false],
  ['remark', '备注', false],
  ['trackingProperties', '跟踪属性', false],
] as const

export function NpiImportTemplateEditor({
  template,
  api,
  onSaved,
  onClose,
}: {
  template: TemplateDraft
  api: <T>(path: string, method?: string, data?: unknown) => Promise<T>
  onSaved: () => Promise<void>
  onClose: () => void
}) {
  const [config, setConfig] = useState(() => structuredClone(template.config))
  const [enabled, setEnabled] = useState(template.enabled)
  const [version, setVersion] = useState(template.version)
  const [advanced, setAdvanced] = useState(false)
  const [json, setJson] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const normalize = (value: ImportTemplate) => {
    for (const [key, column] of Object.entries(value.fieldMapping)) {
      if (typeof column !== 'string')
        throw new Error(`列标题必须是文本：${key}`)
    }
    const fieldMapping = Object.fromEntries(
      Object.entries(value.fieldMapping)
        .filter(([, v]) => typeof v === 'string' && v.trim())
        .map(([k, v]) => [k, v.trim()]),
    )
    const next = {
      ...value,
      name: value.name.trim(),
      sheetName: value.sheetName.trim(),
      fieldMapping,
      motherInfoMapping: Object.fromEntries(
        Object.entries(value.motherInfoMapping).map(([k, v]) => [
          k,
          v.trim().toUpperCase(),
        ]),
      ) as ImportTemplate['motherInfoMapping'],
    }
    validateTemplate(next)
    if (next.id !== template.config.id)
      throw new Error('模板编号不可更改，请另建模板')
    return next
  }
  const fromJson = () => {
    const value: unknown = JSON.parse(json)
    validateTemplate(value)
    return normalize(value)
  }
  const switchMode = () => {
    setError('')
    try {
      if (advanced) setConfig(fromJson())
      else setJson(JSON.stringify(config, null, 2))
      setAdvanced(!advanced)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '配置格式无效')
    }
  }
  const reload = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const latest = await api<{ templates: Array<TemplateDraft> }>('/meta')
      const found = latest.templates.find(
        (t) => t.config.id === template.config.id,
      )
      if (!found) throw new Error('模板已不存在，请关闭后刷新列表')
      setConfig(structuredClone(found.config))
      setEnabled(found.enabled)
      setVersion(found.version)
      setAdvanced(false)
      setJson('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '读取最新模板失败')
    } finally {
      setBusy(false)
    }
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError('')
    try {
      const next = advanced ? fromJson() : normalize(config)
      setBusy(true)
      await api('/templates', 'PUT', {
        config: next,
        enabled,
        expectedVersion: version,
      })
      await onSaved()
      onClose()
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : '保存失败，请核对后重试',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="npi-modal">
        <DialogTitle>
          {template.version ? '维护BOM导入模板' : '新建BOM导入模板'}
        </DialogTitle>
        <DialogDescription>
          按ERP导出文件填写工作表名和列标题。保存后用于后续解析，已导入版本保留当时的模板。
        </DialogDescription>
        <form onSubmit={save}>
          <button
            className="npi-button secondary"
            type="button"
            disabled={busy}
            onClick={switchMode}
          >
            {advanced ? '返回表单配置' : '高级配置（JSON）'}
          </button>
          {advanced && (
            <button
              className="npi-button secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setAdvanced(false)
                setError('')
              }}
            >
              放弃JSON修改
            </button>
          )}
          {advanced ? (
            <div className="npi-form-grid">
              <label className="wide">
                字段映射配置（JSON）
                <textarea
                  aria-label="字段映射配置（JSON）"
                  value={json}
                  disabled={busy}
                  onChange={(e) => setJson(e.target.value)}
                  rows={18}
                  spellCheck={false}
                />
              </label>
            </div>
          ) : (
            <>
              <div className="npi-form-grid">
                <label>
                  模板名称 *
                  <input
                    aria-label="模板名称"
                    value={config.name}
                    required
                    disabled={busy}
                    onChange={(e) =>
                      setConfig({ ...config, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  工作表名称 *
                  <input
                    aria-label="工作表名称"
                    value={config.sheetName}
                    required
                    disabled={busy}
                    onChange={(e) =>
                      setConfig({ ...config, sheetName: e.target.value })
                    }
                  />
                </label>
                <label>
                  表头所在行 *
                  <input
                    aria-label="表头所在行"
                    type="number"
                    min={1}
                    max={100}
                    required
                    value={config.headerRow || ''}
                    disabled={busy}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        headerRow: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  数据起始行 *
                  <input
                    aria-label="数据起始行"
                    type="number"
                    min={2}
                    max={200}
                    required
                    value={config.dataStartRow || ''}
                    disabled={busy}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        dataStartRow: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="wide">
                  层级格式
                  <select
                    aria-label="层级格式"
                    disabled={busy}
                    value={config.levelParser}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        levelParser: e.target
                          .value as ImportTemplate['levelParser'],
                      })
                    }
                  >
                    <option value="plus">加号层级（+、++、+++）</option>
                    <option value="number">数字层级（1、2、3）</option>
                  </select>
                </label>
              </div>
              <h3>母件所在单元格</h3>
              <p>例如A4。请填写编码、名称和规格所在的单元格。</p>
              <div className="npi-form-grid">
                {(
                  [
                    ['code', '母件编码单元格'],
                    ['name', '母件名称单元格'],
                    ['spec', '母件规格单元格'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label} *
                    <input
                      aria-label={label}
                      value={config.motherInfoMapping[key]}
                      required
                      disabled={busy}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          motherInfoMapping: {
                            ...config.motherInfoMapping,
                            [key]: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <h3>Excel列标题映射</h3>
              <p>
                填写表头中的原始文字，例如“子件编码”。标有 *
                的四项必填，其余列没有时可留空。
              </p>
              <p className="npi-muted">
                跟踪属性为可选映射。{trackingPropertyHelp}
              </p>
              <div className="npi-form-grid">
                {fields.map(([key, label, required]) => (
                  <label key={key}>
                    {label}
                    {required && ' *'}
                    <input
                      aria-label={`${label}列标题`}
                      value={config.fieldMapping[key] || ''}
                      required={required}
                      disabled={busy}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          fieldMapping: {
                            ...config.fieldMapping,
                            [key]: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </>
          )}
          <label className="npi-checkbox">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            启用此模板
          </label>
          <p>停用后不再用于新预览；历史BOM仍可查看。</p>
          {error && (
            <p role="alert" className="npi-message error">
              {error}
            </p>
          )}
          <div className="npi-actions">
            {error && template.version > 0 && (
              <button
                className="npi-button secondary"
                type="button"
                disabled={busy}
                onClick={() => void reload()}
              >
                载入最新模板（放弃本次修改）
              </button>
            )}
            <button
              className="npi-button secondary"
              type="button"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button className="npi-button" type="submit" disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
