// SPDX-License-Identifier: AGPL-3.0-or-later
import { Boxes } from 'lucide-react'
import type { ProjectDetail } from '../../lib/npi/service'

type Kit = ProjectDetail['kit']
export function bottleneckLabel(kit: Kit, itemId: string) {
  if (kit.bottleneck?.id !== itemId) return null
  return kit.predictionComplete ? '当前瓶颈' : '已知瓶颈（预测不完整）'
}
export function NpiBottleneck({
  kit,
  onLocate,
}: {
  kit: Kit
  onLocate: (id: string, type: 'manufacturing_node' | 'tracking_item') => void
}) {
  const item = kit.bottleneck
  return (
    <div className="npi-bottleneck" style={{ flexWrap: 'wrap' }}>
      <Boxes size={22} />
      <div style={{ flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere' }}>
        <small>{item ? bottleneckLabel(kit, item.id) : '当前瓶颈'}</small>
        <strong>
          {item
            ? `${item.name} · ${item.ownerName} · ${item.committedDate}`
            : kit.predictionComplete
              ? '暂无未完成的已回复关键项'
              : '请先取得关键项承诺日期'}
        </strong>
      </div>
      {item && (
        <button
          type="button"
          className="npi-button secondary"
          onClick={() =>
            onLocate(
              item.id,
              item.type === 'manufacturing_node'
                ? 'manufacturing_node'
                : 'tracking_item',
            )
          }
        >
          定位瓶颈
        </button>
      )}
    </div>
  )
}
