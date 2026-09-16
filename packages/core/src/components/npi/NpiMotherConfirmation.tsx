// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react'
import type { BomPreview, MotherConfirmation } from '../../lib/npi/bom'
import type { FormEvent } from 'react'

export type MotherInput = {
  code: string
  name: string
  spec: string
  reason: string
}

export function MotherConfirmationDetail({
  confirmation,
}: {
  confirmation: MotherConfirmation
}) {
  return (
    <div style={{ overflowWrap: 'anywhere' }}>
      <strong>母件人工确认</strong>
      <p>
        原识别：{confirmation.original.code || '未识别编码'} ·{' '}
        {confirmation.original.name || '未识别名称'} ·{' '}
        {confirmation.original.spec || '未提供规格'}
      </p>
      <p>
        确认后：{confirmation.confirmed.code} · {confirmation.confirmed.name} ·{' '}
        {confirmation.confirmed.spec || '未提供规格'}
      </p>
      <p>原因：{confirmation.reason}</p>
      <small>
        {confirmation.confirmedByName} ·{' '}
        {new Date(confirmation.confirmedAt).toLocaleString('zh-CN', {
          timeZone: 'Asia/Shanghai',
        })}
      </small>
    </div>
  )
}

export function NpiMotherConfirmation({
  preview,
  busy,
  onConfirm,
}: {
  preview: BomPreview
  busy: boolean
  onConfirm: (input: MotherInput) => Promise<void>
}) {
  const [open, setOpen] = useState(!preview.mother.code)
  const [input, setInput] = useState<MotherInput>({
    ...preview.mother,
    reason: '',
  })
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError('')
    try {
      await onConfirm(input)
      setOpen(false)
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : '母件确认失败，请重试',
      )
    }
  }
  return (
    <section aria-label="母件信息确认" style={{ marginBlock: 16 }}>
      {preview.motherConfirmation && (
        <MotherConfirmationDetail confirmation={preview.motherConfirmation} />
      )}
      {!open ? (
        <button
          className="npi-button secondary"
          disabled={busy}
          onClick={() => {
            setInput({ ...preview.mother, reason: '' })
            setError('')
            setOpen(true)
          }}
        >
          {preview.motherConfirmation ? '重新确认母件' : '确认 / 修正母件'}
        </button>
      ) : (
        <form onSubmit={submit}>
          <h4>确认本次母件信息</h4>
          <p>
            请根据原始资料核对母件。确认仅用于本次导入，原始Excel保留；其他解析错误仍需修正。
          </p>
          <div className="npi-form-grid">
            {(
              [
                { key: 'code', label: '母件编码', max: 120 },
                { key: 'name', label: '母件名称', max: 255 },
                { key: 'spec', label: '母件规格', max: 1000 },
              ] as const
            ).map(({ key, label, max }) => (
              <label key={key}>
                {label}
                {key !== 'spec' && ' *'}
                <input
                  aria-label={label}
                  value={input[key]}
                  required={key !== 'spec'}
                  maxLength={max}
                  disabled={busy}
                  onChange={(e) =>
                    setInput({ ...input, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            <label className="wide">
              母件确认原因 *
              <textarea
                aria-label="母件确认原因"
                value={input.reason}
                required
                maxLength={2000}
                disabled={busy}
                onChange={(e) => setInput({ ...input, reason: e.target.value })}
              />
            </label>
          </div>
          {error && (
            <p role="alert" className="npi-error-text">
              {error}
            </p>
          )}
          <button className="npi-button" type="submit" disabled={busy}>
            {busy ? '确认中…' : '确认母件并重新预览'}
          </button>{' '}
          {preview.mother.code && (
            <button
              className="npi-button secondary"
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              取消修改
            </button>
          )}
        </form>
      )}
    </section>
  )
}
