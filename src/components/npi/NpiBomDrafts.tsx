// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react'
import type { BomDraft } from '../../lib/npi/bom-draft-service'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export function NpiBomDrafts({
  api,
  projectId,
  revision,
  busy,
  onResume,
  onDiscard,
}: {
  api: Api
  projectId: string
  revision: number
  busy: boolean
  onResume: (draft: BomDraft) => Promise<void>
  onDiscard: (draft: BomDraft) => Promise<void>
}) {
  const [drafts, setDrafts] = useState<Array<BomDraft>>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [removing, setRemoving] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    setRemoving(null)
    void api<{ drafts: Array<BomDraft> }>(`/projects/${projectId}/bom/drafts`)
      .then((result) => {
        if (live) setDrafts(result.drafts)
      })
      .catch((e) => {
        if (live) {
          setDrafts([])
          setError(e instanceof Error ? e.message : '草稿读取失败')
        }
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [api, projectId, revision, retry])
  return (
    <section className="npi-preview" aria-label="我的BOM草稿">
      <h3>我的BOM草稿 {drafts.length ? `（${drafts.length}）` : ''}</h3>
      <p className="npi-list-summary">
        草稿保留原始Excel，刷新后可继续。恢复时按上方选定模板（未选则沿用原模板的当前配置）重新解析；核对后才生成正式版本。
      </p>
      {loading ? (
        <p role="status">正在读取草稿…</p>
      ) : error ? (
        <div role="alert">
          {error}{' '}
          <button
            className="npi-button secondary"
            disabled={busy}
            onClick={() => setRetry((n) => n + 1)}
          >
            重试读取草稿
          </button>
        </div>
      ) : drafts.length ? (
        drafts.map((draft) => (
          <article
            key={draft.id}
            aria-label={`草稿：${draft.sourceName}`}
            className="npi-draft-card"
          >
            <strong>{draft.sourceName}</strong>
            <p>
              {draft.motherCode} · {draft.rowCount} 项 · {draft.templateName}
            </p>
            <p className="npi-list-summary">
              保存于{' '}
              {new Date(draft.savedAt!).toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
              })}
            </p>
            <div className="npi-actions">
              {removing === draft.id ? (
                <>
                  <span>移除后无法从列表继续，已生成的BOM版本不受影响。</span>
                  <button
                    className="npi-button secondary"
                    disabled={busy}
                    onClick={() => setRemoving(null)}
                  >
                    保留草稿
                  </button>
                  <button
                    className="npi-button secondary"
                    disabled={busy}
                    onClick={() => void onDiscard(draft)}
                  >
                    确认移除草稿
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="npi-button"
                    disabled={busy}
                    onClick={() => void onResume(draft)}
                  >
                    恢复预览
                  </button>
                  <button
                    className="npi-button secondary"
                    disabled={busy}
                    onClick={() => setRemoving(draft.id)}
                  >
                    移除草稿
                  </button>
                </>
              )}
            </div>
          </article>
        ))
      ) : (
        <p>暂无已保存草稿。解析通过后可选择“保存为草稿”。</p>
      )}
    </section>
  )
}
