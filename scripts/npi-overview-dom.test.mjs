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
test.afterEach(() => cleanup())
const { NpiProjectOverview } =
  await import('../packages/core/src/components/npi/NpiProjectOverview.tsx')
const { kitStatus } = await import('../packages/core/src/lib/npi/domain.ts')
const item = {
  id: 'material',
  name: '关键机壳',
  ownerName: '制造',
  sourceType: 'EXTERNAL',
  trackingType: 'material',
  affectsKit: true,
  trackingEnabled: true,
  requiredDate: '2026-10-15',
  currentCommittedDate: '2026-10-18',
  actualCompleteDate: null,
}
const project = (items) => ({
  id: 'project',
  code: 'NPI-TEST',
  name: '概览测试',
  motorModel: 'M',
  profile: {},
  createdAt: '2026-09-15T00:00:00Z',
  technicalOwnerId: 'tech',
  manufacturingOwnerId: 'mfg',
  requiredKitDate: '2026-10-15',
  prototypeRequiredDate: '2026-10-20',
  items,
  imports: [],
  events: [],
  openIssueCount: 0,
  kit: kitStatus(items, '2026-10-15', null, '2026-09-15'),
})
const meta = {
  users: [
    { id: 'tech', name: '技术' },
    { id: 'mfg', name: '制造' },
  ],
}
const api = async () => ({ files: [] })
const show = async (p, onLocate = () => {}) => {
  const result = render(
    h(NpiProjectOverview, { project: p, meta, api, onTab: () => {}, onLocate }),
  )
  await waitFor(() =>
    assert.ok(
      screen.getByText('尚无项目资料，可上传技术规格、图纸说明和试验资料。'),
    ),
  )
  return result
}
try {
  await test('Overview shows the known bottleneck and forwards the material identity while replies are incomplete', async () => {
    const p = project([
        item,
        { ...item, id: 'pending', currentCommittedDate: null },
      ]),
      calls = []
    await show(p, (...args) => calls.push(args))
    assert.ok(screen.getByText('已知瓶颈（预测不完整）'))
    assert.ok(screen.getByText('关键机壳 · 制造 · 2026-10-18'))
    fireEvent.click(screen.getByRole('button', { name: '定位瓶颈' }))
    assert.deepEqual(calls, [['material', 'tracking_item']])
    cleanup()
  })
  await test('Overview routes manufacturing bottleneck and retains the late-by-days comparison', async () => {
    const p = project([
        {
          ...item,
          id: 'tooling',
          name: '工装准备',
          sourceType: 'MANUFACTURING',
          trackingType: 'tooling',
        },
      ]),
      calls = []
    await show(p, (...args) => calls.push(args))
    assert.ok(screen.getByText('当前瓶颈'))
    assert.ok(screen.getByText('较要求齐套晚 3 天'))
    fireEvent.click(screen.getByRole('button', { name: '定位瓶颈' }))
    assert.deepEqual(calls, [['tooling', 'manufacturing_node']])
    cleanup()
  })
  await test('All completed relevant items explain readiness instead of requesting more commitments', async () => {
    await show(project([{ ...item, actualCompleteDate: '2026-10-14' }]))
    assert.ok(screen.getByText('已齐备'))
    assert.ok(screen.getByText('影响齐套的物料和节点均已完成'))
    assert.equal(screen.queryByText('取得关键项承诺后计算'), null)
    assert.equal(screen.queryByRole('button', { name: '定位瓶颈' }), null)
    cleanup()
  })
  await test('No known commitment remains pending and offers no target', async () => {
    await show(project([{ ...item, currentCommittedDate: null }]))
    assert.ok(screen.getByText(/取得关键项承诺后计算/))
    assert.equal(screen.queryByRole('button', { name: '定位瓶颈' }), null)
    cleanup()
  })
} finally {
  cleanup()
  dom.window.close()
}
