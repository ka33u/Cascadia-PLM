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
const { NpiExternalMaterial } =
  await import('../packages/core/src/components/npi/NpiExternalMaterial.tsx')
const { NpiKitMaterials } =
  await import('../packages/core/src/components/npi/NpiKitMaterials.tsx')
try {
  await test('Other material owner selection is independent and failed submissions preserve category and entered values', async () => {
    const calls = []
    let saved = 0,
      closed = 0,
      reject = true
    render(
      h(NpiExternalMaterial, {
        project: { id: 'project', requiredKitDate: '2026-10-15' },
        meta: {
          recentProcurementOwnerId: 'buyer',
          users: [
            { id: 'buyer', name: '采购人', role: 'procurement' },
            { id: 'tech', name: '技术人', role: 'technical' },
            { id: 'mfg', name: '制造人', role: 'manufacturing' },
          ],
        },
        api: async (path, method, body) => {
          calls.push({ path, method, body })
          if (reject) throw new Error('模拟保存失败')
          return { id: 'other-item', name: '特殊试验用品' }
        },
        onSaved: async () => {
          saved++
          return { id: 'other-item', name: '特殊试验用品' }
        },
        onClose: () => {
          closed++
        },
      }),
    )
    const dialog = await screen.findByRole('dialog', { name: '添加BOM外物料' })
    const view = within(dialog),
      type = view.getByLabelText('物料类型'),
      owner = view.getByLabelText('回复责任人')
    assert.equal(owner.value, 'buyer')
    fireEvent.change(view.getByLabelText('物料名称'), {
      target: { value: '特殊试验用品' },
    })
    fireEvent.change(view.getByLabelText('规格'), {
      target: { value: '高温试验' },
    })
    fireEvent.change(view.getByLabelText('数量'), { target: { value: '2.5' } })
    fireEvent.change(type, { target: { value: 'other' } })
    assert.equal(owner.value, '')
    assert.equal(dialog.querySelector('form').checkValidity(), false)
    assert.ok(
      !Array.from(owner.options).some((option) => option.value === 'buyer'),
    )
    fireEvent.change(owner, { target: { value: 'tech' } })
    fireEvent.change(type, { target: { value: 'material' } })
    assert.equal(owner.value, '')
    fireEvent.change(owner, { target: { value: 'mfg' } })
    fireEvent.change(type, { target: { value: 'purchase' } })
    assert.equal(owner.value, 'buyer')
    fireEvent.change(type, { target: { value: 'other' } })
    assert.equal(owner.value, 'tech')
    assert.equal(view.getByLabelText('规格').value, '高温试验')
    fireEvent.submit(dialog.querySelector('form'))
    await waitFor(() =>
      assert.ok(view.getByRole('alert').textContent.includes('模拟保存失败')),
    )
    assert.equal(type.value, 'other')
    assert.equal(owner.value, 'tech')
    assert.equal(view.getByLabelText('数量').value, '2.5')
    assert.equal(saved, 0)
    assert.equal(closed, 0)
    reject = false
    fireEvent.click(view.getByRole('button', { name: '重试本次保存' }))
    await waitFor(() => assert.equal(closed, 1))
    assert.equal(saved, 1)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].body.trackingType, 'other')
    assert.equal(calls[1].body.ownerId, 'tech')
    assert.equal(calls[1].body.qty, '2.5')
    assert.equal(calls[1].body.affectsKit, true)
    cleanup()
  })
  await test('Kit source filters separate all three external categories without changing completion or untracked counts', () => {
    const rows = [
      {
        id: 'purchase',
        sourceType: 'EXTERNAL',
        trackingType: 'purchase',
        name: '采购件',
        status: 'pending_reply',
      },
      {
        id: 'temporary',
        sourceType: 'EXTERNAL',
        trackingType: 'material',
        name: '临时样机件',
        status: 'pending_reply',
      },
      {
        id: 'other',
        sourceType: 'EXTERNAL',
        trackingType: 'other',
        name: '试验用品',
        status: 'completed',
        actualCompleteDate: '2026-09-15',
      },
      {
        id: 'bom',
        sourceType: 'ERP_BOM',
        trackingType: 'material',
        name: 'BOM物料',
        status: 'pending_reply',
      },
    ].map((row) => ({
      specification: '',
      ownerName: '测试人',
      trackingEnabled: true,
      affectsKit: true,
      ...row,
    }))
    render(
      h(NpiKitMaterials, {
        project: {
          items: rows,
          imports: [],
          activeBomImportId: null,
          untrackedBomCount: 9,
          currentNpiStage: 'manufacturing',
        },
        focusedItemId: null,
        onClearFocus: () => {},
        canManage: false,
        onExternal: () => {},
        onBom: () => {},
        renderTable: (items) =>
          h(
            'ul',
            { 'aria-label': '筛选结果' },
            items.map((item) => h('li', { key: item.id }, item.name)),
          ),
      }),
    )
    const statistics = screen.getByRole('group', { name: '齐套物料统计' })
    assert.equal(
      within(statistics)
        .getByRole('button', { name: /^已满足/ })
        .querySelector('strong').textContent,
      '1',
    )
    assert.equal(
      within(statistics)
        .getByRole('button', { name: /^缺料/ })
        .querySelector('strong').textContent,
      '3',
    )
    assert.equal(
      within(statistics)
        .getByRole('button', { name: /^未跟踪/ })
        .querySelector('strong').textContent,
      '9',
    )
    fireEvent.click(
      screen.getByRole('button', { name: '全部跟踪', exact: true }),
    )
    const source = screen.getByLabelText('齐套物料来源')
    for (const [value, label] of [
      ['external_other', '试验用品'],
      ['external_material', '临时样机件'],
      ['external_purchase', '采购件'],
    ]) {
      fireEvent.change(source, { target: { value } })
      assert.deepEqual(
        within(screen.getByRole('list', { name: '筛选结果' }))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
        [label],
      )
    }
    fireEvent.change(source, { target: { value: 'EXTERNAL' } })
    assert.equal(
      within(screen.getByRole('list', { name: '筛选结果' })).getAllByRole(
        'listitem',
      ).length,
      3,
    )
    cleanup()
  })
} finally {
  cleanup()
  dom.window.close()
}
