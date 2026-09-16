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
  'File',
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
const { NpiAssignedMaterials } =
  await import('../packages/core/src/components/npi/NpiAssignedMaterials.tsx')
// jsdom does not populate FormData's file entry from an assigned input.files list.
const NativeFormData = globalThis.FormData
globalThis.FormData = class extends NativeFormData {
  constructor(form) {
    super(form)
    const selected = form?.querySelector('input[type="file"]')?.files?.[0]
    if (selected) this.set('file', selected)
  }
}
const originalFetch = globalThis.fetch
const item = {
  id: 'assigned',
  programId: 'foreign-project',
  projectName: '协作项目',
  projectCode: 'DELEGATED',
  name: '样机安装件',
  specification: 'M10',
  sourceType: 'EXTERNAL',
  trackingType: 'material',
  qty: '1',
  unit: '件',
  requiredDate: '2026-10-15',
  currentCommittedDate: null,
  actualCompleteDate: null,
  currentNpiStage: 'manufacturing',
  status: 'pending_reply',
  version: 1,
}
try {
  await test('Assigned material opens scoped files and preserves multipart upload after failure without resubmitting a saved file', async () => {
    let posts = 0,
      failedRefresh = false
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/workbench/materials'))
        return {
          ok: true,
          json: async () => ({
            actorId: 'actor',
            today: '2026-09-15',
            items: [item],
          }),
        }
      assert.equal(url, '/api/v1/npi/files/tracking/assigned')
      if (init.method === 'POST') {
        posts++
        assert.ok(init.body instanceof FormData)
        assert.equal(init.headers['Content-Type'], undefined)
        assert.equal(init.headers['x-npi-actor'], 'actor')
        assert.equal(init.body.get('category'), 'receipt')
        assert.equal(init.body.get('file').name, '完成照片.png')
        if (posts === 1)
          return {
            ok: false,
            json: async () => ({ error: '上传中断，请重试' }),
          }
        failedRefresh = true
        return { ok: true, json: async () => ({ id: 'saved-file' }) }
      }
      if (failedRefresh) {
        failedRefresh = false
        return { ok: false, json: async () => ({ error: '临时读取失败' }) }
      }
      return {
        ok: true,
        json: async () => ({ files: [], canUpload: true, canArchive: false }),
      }
    }
    render(
      h(NpiAssignedMaterials, {
        actorId: 'actor',
        revision: {},
        managedProjectIds: [],
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: '资料与照片' }))
    const dialog = await screen.findByRole('dialog', { name: '物料资料与照片' })
    const input = await within(dialog).findByLabelText('选择文件或照片')
    fireEvent.change(within(dialog).getByLabelText('文件分类'), {
      target: { value: 'receipt' },
    })
    fireEvent.change(input, {
      target: {
        files: [new File(['image'], '完成照片.png', { type: 'image/png' })],
      },
    })
    fireEvent.submit(input.closest('form'))
    await screen.findByText('上传中断，请重试')
    assert.equal(input.files[0].name, '完成照片.png')
    fireEvent.submit(input.closest('form'))
    await screen.findByText(/资料列表加载失败：临时读取失败/)
    assert.ok(screen.getByText('资料已上传成功，无需重复上传。'))
    const requests = calls.filter((c) => c.init.method === 'POST')
    assert.equal(
      requests[0].init.body.get('requestId'),
      requests[1].init.body.get('requestId'),
    )
    fireEvent.click(screen.getByRole('button', { name: '刷新资料' }))
    await waitFor(() =>
      assert.equal(screen.queryByText(/资料列表加载失败/), null),
    )
    assert.equal(posts, 2)
    assert.equal(screen.queryByRole('button', { name: /归档资料/ }), null)
    cleanup()
  })
  await test('Completed delegated project keeps attachment browsing but hides upload controls', async () => {
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () =>
        url.endsWith('/workbench/materials')
          ? {
              actorId: 'actor',
              today: '2026-09-15',
              items: [{ ...item, currentNpiStage: 'completed' }],
            }
          : { files: [], canUpload: false, canArchive: false },
    })
    render(
      h(NpiAssignedMaterials, {
        actorId: 'actor',
        revision: {},
        managedProjectIds: [],
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: '资料与照片' }))
    await screen.findByText(/暂无资料。可上传技术规格/)
    assert.equal(screen.queryByLabelText('选择文件或照片'), null)
    cleanup()
  })
} finally {
  cleanup()
  globalThis.fetch = originalFetch
  dom.window.close()
}
