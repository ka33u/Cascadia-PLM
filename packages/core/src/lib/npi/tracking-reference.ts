// SPDX-License-Identifier: AGPL-3.0-or-later
export interface TrackingBomReference {
  materialCode: string
  versionNo: number
  rowNo: number
  current: boolean
}

export function bomReferenceLabel(reference: TrackingBomReference) {
  return `ERP BOM V${reference.versionNo} · 原表第${reference.rowNo}行 · ${reference.current ? '当前版本' : '历史版本'}`
}

export function trackingIdentity(item: {
  name: string
  bomReference?: TrackingBomReference | null
}) {
  return item.bomReference
    ? `${item.name} · ${item.bomReference.materialCode} · ${bomReferenceLabel(item.bomReference)}`
    : item.name
}
