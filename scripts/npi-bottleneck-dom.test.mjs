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
const { NpiBottleneck, bottleneckLabel } =
  await import('../packages/core/src/components/npi/NpiBottleneck.tsx')
const item = {
  id: 'material',
  type: 'tracking_item',
  name: '机壳',
  ownerName: '制造',
  committedDate: '2026-10-18',
}
try {
  await test('Incomplete prediction labels only the known bottleneck and forwards its exact identity for focus', () => {
    const kit = { bottleneck: item, predictionComplete: false },
      calls = []
    render(h(NpiBottleneck, { kit, onLocate: (...args) => calls.push(args) }))
    assert.ok(screen.getByText('已知瓶颈（预测不完整）'))
    assert.equal(bottleneckLabel(kit, 'unrelated'), null)
    fireEvent.click(screen.getByRole('button', { name: '定位瓶颈' }))
    assert.deepEqual(calls, [['material', 'tracking_item']])
    cleanup()
  })
  await test('Manufacturing bottleneck routes as a node and an absent bottleneck offers no focus action', () => {
    const calls = []
    const view = render(
      h(NpiBottleneck, {
        kit: {
          bottleneck: { ...item, id: 'tooling', type: 'manufacturing_node' },
          predictionComplete: true,
        },
        onLocate: (...args) => calls.push(args),
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '定位瓶颈' }))
    assert.deepEqual(calls, [['tooling', 'manufacturing_node']])
    view.rerender(
      h(NpiBottleneck, {
        kit: { bottleneck: null, predictionComplete: false },
        onLocate: () => {
          throw new Error('No target')
        },
      }),
    )
    assert.equal(screen.queryByRole('button', { name: '定位瓶颈' }), null)
    assert.ok(screen.getByText('请先取得关键项承诺日期'))
    cleanup()
  })
} finally {
  cleanup()
  dom.window.close()
}
