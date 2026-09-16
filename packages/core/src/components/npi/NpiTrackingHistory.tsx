// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react'
import { bomReferenceLabel } from '../../lib/npi/tracking-reference'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import type { TrackingHistory } from '../../lib/npi/service'

export function NpiTrackingHistory({
  itemId,
  api,
  onClose,
}: {
  itemId: string
  api: <T>(path: string, method?: string, data?: unknown) => Promise<T>
  onClose: () => void
}) {
  const [data, setData] = useState<TrackingHistory | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setData(null)
    setError('')
    void api<TrackingHistory>(`/tracking/${itemId}/history`)
      .then((result) => {
        if (active) setData(result)
      })
      .catch((e: unknown) => {
        if (active)
          setError(e instanceof Error ? e.message : '读取承诺历史失败')
      })
    return () => {
      active = false
    }
  }, [api, itemId, revision])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="npi-modal">
        <DialogTitle style={{ paddingRight: 24, overflowWrap: 'anywhere' }}>
          {data ? `${data.item.name} · 承诺历史` : '承诺历史'}
        </DialogTitle>
        <DialogDescription>
          保留首次承诺、每次改期的原因和操作人。
        </DialogDescription>
        {error ? (
          <div role="alert" className="npi-message error">
            {error}
          </div>
        ) : !data ? (
          <p role="status">正在读取承诺历史…</p>
        ) : (
          <>
            {data.item.bomReference && (
              <p style={{ overflowWrap: 'anywhere' }}>
                物料编码：{data.item.bomReference.materialCode}
                <br />
                {bomReferenceLabel(data.item.bomReference)}
              </p>
            )}
            <p>
              首次承诺：{data.item.firstCommittedDate || '尚未回复'}
              <br />
              当前承诺：{data.item.currentCommittedDate || '尚未回复'}
              <br />
              改期 {data.item.changeCount} 次
            </p>
            {data.history.length ? (
              data.history.map((h) => (
                <div className="npi-history" key={h.id}>
                  <div>
                    <strong>
                      {h.oldCommittedDate || '首次回复'} → {h.newCommittedDate}
                    </strong>
                    <p>{h.reason}</p>
                    <small>
                      {h.actorName} ·{' '}
                      {new Date(h.changedAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                      })}
                    </small>
                  </div>
                </div>
              ))
            ) : (
              <p>尚无承诺记录，首次回复后会显示在这里。</p>
            )}
          </>
        )}
        <div className="npi-actions">
          <button
            className="npi-button secondary"
            disabled={!data && !error}
            onClick={() => setRevision((v) => v + 1)}
          >
            重新载入历史
          </button>
          <button className="npi-button" onClick={onClose}>
            关闭
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
