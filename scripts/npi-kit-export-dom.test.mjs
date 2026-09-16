// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory component interaction only; no browser process, network or database.
import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})
const keys = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'HTMLFormElement',
  'Element',
  'Node',
  'NodeFilter',
  'DocumentFragment',
  'MutationObserver',
  'CustomEvent',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'FormData',
]
for (const key of keys)
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === 'window' ? dom.window : dom.window[key],
  })
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(
  dom.window,
)
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(
  dom.window,
)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h } = await import('react')
const { render, fireEvent, screen, waitFor, cleanup, within } =
  await import('@testing-library/react')
const { NpiKitMaterials } =
  await import('../packages/core/src/components/npi/NpiKitMaterials.tsx')
const ExcelJS = (await import('exceljs')).default
const blobs = [],
  filenames = []
const originalCreate = URL.createObjectURL,
  originalRevoke = URL.revokeObjectURL
const originalClick = window.HTMLAnchorElement.prototype.click
let fail = false
URL.createObjectURL = (blob) => {
  if (fail) throw new Error('下载暂不可用')
  blobs.push(blob)
  return 'blob:kit-test'
}
URL.revokeObjectURL = () => {}
window.HTMLAnchorElement.prototype.click = function () {
  filenames.push(this.download)
}
const common = {
  specification: '',
  qty: '1',
  unit: '件',
  ownerName: '测试人',
  requiredDate: '2026-10-15',
  actualCompleteDate: null,
  status: 'risk',
  trackingEnabled: true,
  affectsKit: true,
  supplier: '',
  remark: '',
  trackingType: 'purchase',
}
const project = {
  code: 'P/001',
  name: '齐套导出',
  currentNpiStage: 'manufacturing',
  imports: [],
  activeBomImportId: null,
  untrackedBomCount: 10,
  requiredKitDate: '2026-10-15',
  kit: {
    predictionComplete: false,
    manufacturingCommittedKitDate: null,
    predictedKitDate: null,
  },
  items: [
    { ...common, id: 'bom', sourceType: 'ERP_BOM', name: '机壳' },
    {
      ...common,
      id: 'external',
      sourceType: 'EXTERNAL',
      name: '编码器',
      currentCommittedDate: '2026-10-18',
    },
    { ...common, id: 'node', sourceType: 'MANUFACTURING', name: '制造节点' },
  ],
}
const props = {
  project,
  focusedItemId: null,
  onClearFocus: () => {},
  canManage: false,
  onExternal: () => {},
  onBom: () => {},
  renderTable: (items) => h('p', {}, items.map((i) => i.name).join(',')),
}
try {
  await test('Kit export follows current source/search filters, excludes manufacturing nodes and disables empty exports', async () => {
    render(h(NpiKitMaterials, props))
    assert.ok(screen.getByRole('button', { name: '导出当前筛选（2项）' }))
    fireEvent.change(screen.getByLabelText('齐套物料来源'), {
      target: { value: 'EXTERNAL' },
    })
    fireEvent.click(screen.getByRole('button', { name: '导出当前筛选（1项）' }))
    await waitFor(() => assert.equal(blobs.length, 1))
    await waitFor(() =>
      assert.equal(
        screen.getByRole('button', { name: '导出当前筛选（1项）' }).disabled,
        false,
      ),
    )
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await blobs[0].arrayBuffer())
    const sheet = workbook.getWorksheet('齐套物料')
    assert.equal(sheet.rowCount, 6)
    assert.equal(sheet.getCell('C6').value, '编码器')
    assert.match(sheet.getCell('A2').value, /BOM外物料/)
    assert.equal(filenames[0], 'P_001-齐套物料.xlsx')
    fireEvent.change(screen.getByLabelText('搜索齐套物料'), {
      target: { value: '不存在' },
    })
    assert.equal(
      screen.getByRole('button', { name: '导出当前筛选（0项）' }).disabled,
      true,
    )
    cleanup()
  })
  await test('Export failures retain selection and allow retry; focused exports contain only the located item', async () => {
    render(h(NpiKitMaterials, { ...props, focusedItemId: 'external' }))
    fail = true
    fireEvent.click(screen.getByRole('button', { name: '导出当前筛选（1项）' }))
    await screen.findByText(/Excel导出失败：下载暂不可用/)
    assert.equal(
      screen.getByRole('button', { name: '导出当前筛选（1项）' }).disabled,
      false,
    )
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '导出当前筛选（1项）' }))
    await waitFor(() => assert.equal(blobs.length, 2))
    await waitFor(() =>
      assert.equal(
        screen.getByRole('button', { name: '导出当前筛选（1项）' }).disabled,
        false,
      ),
    )
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await blobs[1].arrayBuffer())
    assert.match(
      workbook.getWorksheet('齐套物料').getCell('A2').value,
      /定位物料/,
    )
    assert.equal(screen.queryByRole('alert'), null)
    cleanup()
  })
} finally {
  cleanup()
  // Let the download cleanup callback complete before restoring the URL API.
  await new Promise((resolve) => setTimeout(resolve, 1100))
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
  window.HTMLAnchorElement.prototype.click = originalClick
  dom.window.close()
}
