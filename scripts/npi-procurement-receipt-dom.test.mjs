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
const { NpiProcurementReplyDialog } =
  await import('../packages/core/src/components/npi/NpiProcurementReplyDialog.tsx')
const item = {
  id: 'purchase-A',
  name: '编码器',
  projectName: '新品A',
  ownerId: 'buyer',
  requiredDate: '2026-09-20',
  currentCommittedDate: '2026-09-18',
  firstCommittedDate: '2026-09-18',
  actualCompleteDate: null,
  trackingEnabled: true,
  affectsKit: true,
  version: 3,
  remark: '原备注',
  supplier: '原供应商',
}
const calls = []
const defaultApi = async (path, method = 'GET', body) => {
  calls.push({ path, method, body })
  return {}
}
const show = (props = {}) =>
  render(
    h(NpiProcurementReplyDialog, {
      item,
      complete: true,
      actorId: 'buyer',
      today: '2026-09-15',
      api: defaultApi,
      onClose: () => {},
      onSaved: async () => {},
      ...props,
    }),
  )
const button = (name) => screen.getByRole('button', { name, exact: true })
const click = (name) => fireEvent.click(button(name))
test.beforeEach(() => {
  calls.length = 0
})

test('saved arrival with failed refresh stays open; retries issue no second completion write and preserve attachment intent', async () => {
  let refreshes = 0,
    files = 0,
    closes = 0
  show({
    onSaved: async () => {
      refreshes++
      if (refreshes < 3) throw Error('列表暂不可用')
    },
    onClose: () => closes++,
    onOpenFiles: () => files++,
  })
  fireEvent.change(screen.getByLabelText('到货说明（选填）'), {
    target: { value: '包装已验收' },
  })
  click('保存并补充资料')
  await waitFor(() =>
    assert.match(screen.getByRole('alert').textContent, /已保存.*列表刷新失败/),
  )
  assert.equal(closes, 0)
  assert.equal(files, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.remark, '包装已验收')
  assert.equal(screen.getByLabelText('实际到货日期').matches(':disabled'), true)
  assert.equal(
    screen.queryByRole('button', { name: '保存到货', exact: true }),
    null,
  )
  click('重试刷新列表')
  await waitFor(() =>
    assert.match(screen.getByRole('alert').textContent, /列表仍未刷新/),
  )
  assert.equal(calls.length, 1)
  click('重试刷新列表')
  await waitFor(() => assert.equal(files, 1))
  assert.equal(closes, 0)
  assert.equal(calls.length, 1)
  assert.equal(refreshes, 3)
})

test('reply uses the same refresh-only recovery without exposing arrival files', async () => {
  let fail = true,
    closes = 0
  show({
    complete: false,
    onSaved: async () => {
      if (fail) throw Error('读取失败')
    },
    onClose: () => closes++,
    onOpenFiles: () => {
      throw Error('Unexpected files')
    },
  })
  click('保存回复')
  await waitFor(() => assert.ok(screen.getByRole('alert')))
  assert.equal(calls[0].path, '/tracking/purchase-A/promise')
  assert.equal(
    screen.queryByRole('button', { name: '补充到货资料', exact: true }),
    null,
  )
  fail = false
  click('重试刷新列表')
  await waitFor(() => assert.equal(closes, 1))
  assert.equal(calls.length, 1)
})

test('unconfirmed write blocks resubmission until same-version reload verifies no completion', async () => {
  let writes = 0
  show({
    api: async (path, method = 'GET') => {
      if (method === 'POST') {
        writes++
        throw Error('连接中断')
      }
      return { actorId: 'buyer', items: [item] }
    },
  })
  click('保存到货')
  await waitFor(() =>
    assert.match(screen.getByRole('alert').textContent, /读取最新记录/),
  )
  assert.equal(button('保存到货').disabled, true)
  click('读取最新记录')
  await waitFor(() => assert.equal(button('保存到货').disabled, false))
  assert.equal(writes, 1)
})

test('lost response followed by confirmed completion locks the date and allows files without another write', async () => {
  let writes = 0,
    files = 0
  show({
    onOpenFiles: () => files++,
    api: async (path, method = 'GET') => {
      if (method === 'POST') {
        writes++
        throw Error('响应丢失')
      }
      return {
        actorId: 'buyer',
        items: [{ ...item, version: 4, actualCompleteDate: '2026-09-15' }],
      }
    },
  })
  click('保存到货')
  await waitFor(() => assert.ok(screen.getByRole('alert')))
  click('读取最新记录')
  await waitFor(() => assert.ok(button('补充到货资料')))
  assert.equal(button('保存到货').disabled, true)
  click('补充到货资料')
  assert.equal(files, 1)
  assert.equal(writes, 1)
})

test('refresh in flight protects closing and actions; changed-session reads do not unlock resubmission', async () => {
  let release,
    closes = 0
  const held = new Promise((r) => (release = r))
  let refreshes = 0
  show({
    onClose: () => closes++,
    onSaved: async () => {
      if (++refreshes === 1) throw Error('失败')
      await held
    },
  })
  click('保存到货')
  await waitFor(() => assert.ok(button('重试刷新列表')))
  click('重试刷新列表')
  assert.equal(button('关闭').disabled, true)
  fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
  assert.equal(closes, 0)
  release()
  await waitFor(() => assert.equal(closes, 1))
  cleanup()
  show({
    api: async (path, method = 'GET') => {
      if (method === 'POST') throw Error('断开')
      return { actorId: 'different', items: [item] }
    },
  })
  click('保存到货')
  await waitFor(() => assert.ok(screen.getByRole('alert')))
  click('读取最新记录')
  await waitFor(() =>
    assert.match(screen.getByRole('alert').textContent, /登录账号已改变/),
  )
  assert.equal(button('保存到货').disabled, true)
})
