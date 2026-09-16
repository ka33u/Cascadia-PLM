// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import { NpiManufacturingReply } from './NpiManufacturingReply'
import type { ProjectDetail } from '../../lib/npi/service'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export function NpiManufacturingReplyDialog({
  project,
  api,
  onSaved,
  onReload,
  onClose,
  readOnly,
}: {
  project: ProjectDetail
  api: Api
  onReload: () => Promise<ProjectDetail>
  onSaved: () => Promise<void>
  onClose: () => void
  readOnly: boolean
}) {
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose()
      }}
    >
      <DialogContent
        className="npi-modal npi-manufacturing-dialog"
        data-saving={busy}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle>集中回复制造四节点</DialogTitle>
        <DialogDescription>
          {project.name} · {project.code}
          。只填写已确认的节点日期，其他节点保留待回复。
        </DialogDescription>
        <NpiManufacturingReply
          project={project}
          api={api}
          readOnly={readOnly}
          onReload={onReload}
          onBusyChange={(value) => {
            pending.current = value
            setBusy(value)
          }}
          onCancel={onClose}
          onSaved={async () => {
            await onSaved()
            onClose()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
