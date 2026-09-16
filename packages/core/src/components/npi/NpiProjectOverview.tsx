// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react'
import { ArrowUpRight, FileText } from 'lucide-react'
import { nodeNames } from '../../lib/npi/domain'
import { eventLabels } from '../../lib/npi/event-labels'
import { NpiBottleneck } from './NpiBottleneck'
import { predictionNote } from './prediction-note'
import type { NpiMetadata, ProjectDetail } from '../../lib/npi/service'
import type { NpiFileList } from '../../lib/npi/file-service'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export const dateGap = (actual: string | null, required: string) =>
  actual
    ? Math.round((Date.parse(actual) - Date.parse(required)) / 86400000)
    : null
export function NpiProjectOverview({
  project,
  meta,
  api,
  onTab,
  onLocate,
}: {
  project: ProjectDetail
  meta: NpiMetadata
  api: Api
  onTab: (tab: string) => void
  onLocate: (id: string, type: 'manufacturing_node' | 'tracking_item') => void
}) {
  const [files, setFiles] = useState<NpiFileList | null>(null)
  const [fileError, setFileError] = useState('')
  useEffect(() => {
    let live = true
    void api<NpiFileList>(`/files/project/${project.id}`)
      .then((data) => {
        if (live) setFiles(data)
      })
      .catch(() => {
        if (live) setFileError('资料暂时无法读取，请进入项目资料重试。')
      })
    return () => {
      live = false
    }
  }, [api, project.id])
  const owner = (id: string) =>
    meta.users.find((u) => u.id === id)?.name || '未命名'
  const latest = project.imports.find((i) => i.id === project.activeBomImportId)
  const nodes = Object.entries(nodeNames).map(([type, label]) => ({
    type,
    label,
    item: project.items.find((i) => i.trackingType === type),
  }))
  const gap = dateGap(project.kit.predictedKitDate, project.requiredKitDate)

  return (
    <div className="npi-overview" role="region" aria-label="项目概览">
      <div className="npi-overview-top">
        <section className="npi-panel">
          <div className="npi-panel-title">
            <h2>关键节点</h2>
            <button
              className="npi-project-link"
              onClick={() => onTab('manufacturing')}
            >
              制造准备 <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="npi-node-strip">
            <div className={project.drawingCompleteDate ? 'done' : ''}>
              <span>{project.drawingCompleteDate ? '✓' : '○'}</span>
              <strong>图纸完成</strong>
              <small>{project.drawingCompleteDate || '待完成'}</small>
            </div>
            {nodes.map((n) => (
              <div
                key={n.type}
                className={
                  n.item?.actualCompleteDate ? 'done' : n.item?.status || ''
                }
              >
                <span>{n.item?.actualCompleteDate ? '✓' : '○'}</span>
                <strong>{n.label}</strong>
                <small>
                  {n.item?.actualCompleteDate ||
                    n.item?.currentCommittedDate ||
                    '待回复'}
                </small>
              </div>
            ))}
          </div>
          <p className="npi-list-summary">
            节点优先显示实际完成日期；尚未完成时显示当前承诺。
          </p>
        </section>
        <section className="npi-panel npi-overview-target">
          <small>样机要求完成日期</small>
          <strong>{project.prototypeRequiredDate}</strong>
          <small>系统预测齐套</small>
          <strong className={gap != null && gap > 0 ? 'npi-warning-text' : ''}>
            {project.kit.predictedKitDate ||
              (project.kit.allRelevantCompleted ? '已齐备' : '待回复')}
          </strong>
          <span>
            {project.kit.allRelevantCompleted
              ? '影响齐套的物料和节点均已完成'
              : gap == null
                ? '取得关键项承诺后计算'
                : gap > 0
                  ? `较要求齐套晚 ${gap} 天`
                  : gap < 0
                    ? `较要求齐套早 ${-gap} 天`
                    : '与要求齐套同日'}
            {!project.kit.predictionComplete
              ? ` · ${predictionNote(project.kit)}`
              : ''}
          </span>
        </section>
      </div>
      <div className="npi-overview-grid">
        <section className="npi-panel">
          <div className="npi-panel-title">
            <h2>项目信息</h2>
          </div>
          <dl className="npi-info-grid">
            {[
              ['项目编号', project.code],
              ['电机型号', project.motorModel],
              ['客户', project.profile.customer || '未填写'],
              ['用途 / 应用场景', project.profile.application || '未填写'],
              [
                '额定功率',
                project.profile.ratedPowerKw
                  ? `${project.profile.ratedPowerKw} kW`
                  : '未填写',
              ],
              [
                '额定电压',
                project.profile.ratedVoltageV
                  ? `${project.profile.ratedVoltageV} V`
                  : '未填写',
              ],
              ['极数', project.profile.poles || '未填写'],
              [
                '创建人',
                project.createdBy ? owner(project.createdBy) : '未记录',
              ],
              [
                '创建日期',
                new Date(project.createdAt).toLocaleDateString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                }),
              ],
              ['技术负责人', owner(project.technicalOwnerId)],
              ['制造负责人', owner(project.manufacturingOwnerId)],
              ['要求齐套日期', project.requiredKitDate],
              [
                '制造承诺齐套',
                project.kit.manufacturingCommittedKitDate || '待回复',
              ],
              [
                '当前BOM版本',
                latest
                  ? `V${latest.versionNo} · ${latest.rowCount} 项`
                  : '尚未导入',
              ],
              ['未关闭问题', `${project.openIssueCount} 个`],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="npi-overview-notes">
            <strong>项目说明</strong>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {project.profile.description || '未填写'}
            </p>
          </div>
        </section>
        <section className="npi-panel">
          <div className="npi-panel-title">
            <h2>项目文件</h2>
            <button className="npi-project-link" onClick={() => onTab('files')}>
              管理资料 <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="npi-file-brief">
            {fileError ? (
              <p>{fileError}</p>
            ) : !files ? (
              <p>正在读取项目资料…</p>
            ) : (
              files.files
                .filter((f) => !f.archivedAt)
                .slice(0, 5)
                .map((f) => (
                  <div key={f.id}>
                    <FileText size={17} />
                    {f.available ? (
                      <a href={`/api/v1/npi/file-content/${f.id}`}>{f.title}</a>
                    ) : (
                      <span>{f.title} · 不可用</span>
                    )}
                    <small>
                      {new Date(f.createdAt).toLocaleDateString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                      })}
                    </small>
                  </div>
                ))
            )}
            {files && !files.files.some((f) => !f.archivedAt) && (
              <p>尚无项目资料，可上传技术规格、图纸说明和试验资料。</p>
            )}
          </div>
          {latest && (
            <button className="npi-overview-link" onClick={() => onTab('bom')}>
              <FileText size={17} />
              BOM V{latest.versionNo} · {latest.sourceName}
              <ArrowUpRight size={15} />
            </button>
          )}
        </section>
        <section className="npi-panel">
          <div className="npi-panel-title">
            <h2>异常摘要</h2>
            <button className="npi-project-link" onClick={() => onTab('kit')}>
              查看样机齐套 <ArrowUpRight size={15} />
            </button>
          </div>
          <div style={{ margin: '0 20px 16px' }}>
            <NpiBottleneck kit={project.kit} onLocate={onLocate} />
          </div>
          <div className="npi-overview-counts">
            {[
              ['待回复', project.kit.pendingReplyCount],
              ['风险', project.kit.riskCount],
              ['逾期', project.kit.overdueCount],
            ].map(([label, value]) => (
              <button key={label} onClick={() => onTab('kit')}>
                <span>{label}</span>
                <strong>{value}</strong>
              </button>
            ))}
          </div>
          <div className="npi-overview-notes">
            {project.kit.alerts.length ? (
              project.kit.alerts.slice(0, 4).map((a) => (
                <button
                  key={a.code}
                  onClick={() =>
                    onTab(
                      a.code.includes('ISSUE')
                        ? 'issues'
                        : a.code === 'BOM_REVIEW_PENDING'
                          ? 'bom'
                          : 'kit',
                    )
                  }
                >
                  {a.message}
                  <ArrowUpRight size={14} />
                </button>
              ))
            ) : (
              <p>当前无齐套冲突或未回复预警。</p>
            )}
          </div>
        </section>
        <section className="npi-panel">
          <div className="npi-panel-title">
            <h2>最近动态</h2>
            <button
              className="npi-project-link"
              onClick={() => onTab('history')}
            >
              全部记录 <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="npi-recent-events">
            {project.events.slice(0, 5).map((e) => (
              <div key={e.id}>
                <span>{eventLabels[e.action] || '更新项目记录'}</span>
                <small>
                  {new Date(e.createdAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    hour12: false,
                  })}
                </small>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
