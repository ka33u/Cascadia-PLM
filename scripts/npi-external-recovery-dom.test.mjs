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
const { act } = await import('react')
const { NpiExternalMaterial } =
  await import('../packages/core/src/components/npi/NpiExternalMaterial.tsx')
const project = { id: 'project-A', requiredKitDate: '2026-10-15' }
const meta = {
  recentProcurementOwnerId: 'buyer-A',
  users: [
    { id: 'buyer-A', name: '采购A', role: 'procurement' },
    { id: 'maker-A', name: '制造A', role: 'manufacturing' },
  ],
}
const item = {
  id: 'material-A',
  name: '编码器',
  sourceType: 'EXTERNAL',
  ownerId: 'buyer-A',
}
const fill = () =>
  fireEvent.change(screen.getByLabelText('物料名称'), {
    target: { value: '编码器' },
  })
const button = (name) => screen.getByRole('button', { name, exact: true })
const click = (name) => fireEvent.click(button(name))
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const show = (props = {}) =>
  render(
    h(NpiExternalMaterial, {
      project,
      meta,
      api: async () => item,
      onSaved: async () => item,
      onClose: () => {},
      ...props,
    }),
  )

test('Lost create response retries the same frozen payload and retains the direct file action', async () => {
  const writes = []
  let files = 0,
    closes = 0
  show({
    api: async (_path, _method, data) => {
      writes.push(data)
      if (writes.length === 1) throw Error('响应丢失')
      return item
    },
    onOpenFiles: (value) => {
      assert.equal(value.id, item.id)
      files++
    },
    onClose: () => closes++,
  })
  fill()
  click('保存并补充资料')
  await screen.findByRole('button', { name: '重试本次保存' })
  assert.equal(screen.getByLabelText('物料名称').matches(':disabled'), true)
  click('重试本次保存')
  await waitFor(() => assert.equal(closes, 1))
  assert.equal(writes.length, 2)
  assert.deepEqual(writes[0], writes[1])
  assert.match(writes[0].requestId, /^[a-f0-9-]{36}$/)
  assert.equal(files, 1)
})
test('Saved creation with failed refresh never posts again and opens files after recovery', async () => {
  let posts = 0,
    refreshes = 0,
    files = 0,
    closes = 0
  show({
    api: async () => {
      posts++
      return item
    },
    onSaved: async () => {
      refreshes++
      if (refreshes < 3) throw Error('列表读取失败')
      return item
    },
    onOpenFiles: () => files++,
    onClose: () => closes++,
  })
  fill()
  click('保存并补充资料')
  await screen.findByRole('button', { name: '重试刷新列表' })
  assert.equal(button('保存').disabled, true)
  click('重试刷新列表')
  await waitFor(() =>
    assert.match(screen.getByRole('alert').textContent, /列表仍未刷新/),
  )
  click('重试刷新列表')
  await waitFor(() => assert.equal(closes, 1))
  assert.equal(posts, 1)
  assert.equal(refreshes, 3)
  assert.equal(files, 1)
})
test('A validation rejection unlocks correction with a new request identity', async () => {
  const writes = []
  let closes = 0
  show({
    api: async (_path, _method, data) => {
      writes.push(data)
      if (writes.length === 1)
        throw Object.assign(Error('数量不合法'), { status: 422 })
      return item
    },
    onClose: () => closes++,
  })
  fill()
  click('保存')
  await screen.findByRole('alert')
  assert.equal(screen.getByLabelText('数量').matches(':disabled'), false)
  fireEvent.change(screen.getByLabelText('数量'), {
    target: { value: '2.500001' },
  })
  click('保存')
  await waitFor(() => assert.equal(closes, 1))
  assert.notEqual(writes[0].requestId, writes[1].requestId)
  assert.equal(writes[1].qty, '2.500001')
})
test('Synchronous duplicate submissions and close actions wait for the single create', async () => {
  const held = deferred()
  let posts = 0,
    closes = 0
  show({
    api: async () => {
      posts++
      await held.promise
      return item
    },
    onClose: () => closes++,
  })
  fill()
  const form = screen.getByLabelText('物料名称').closest('form')
  act(() => {
    fireEvent.submit(form)
    fireEvent.submit(form)
  })
  fireEvent.keyDown(document, { key: 'Escape' })
  const dialog = screen.getByRole('dialog')
  fireEvent.click(dialog.querySelector(':scope > button'))
  assert.equal(posts, 1)
  assert.equal(closes, 0)
  await act(async () => held.resolve())
  await waitFor(() => assert.equal(closes, 1))
})
test('An unrelated refreshed material cannot receive the new material files', async () => {
  let refreshes = 0,
    files = 0,
    posts = 0
  show({
    api: async () => {
      posts++
      return item
    },
    onSaved: async () => {
      refreshes++
      return refreshes === 1 ? { ...item, id: 'material-B' } : item
    },
    onOpenFiles: () => files++,
  })
  fill()
  click('保存并补充资料')
  await screen.findByRole('button', { name: '重试刷新列表' })
  assert.equal(files, 0)
  click('重试刷新列表')
  await waitFor(() => assert.equal(files, 1))
  assert.equal(posts, 1)
})
