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
const { NpiFiles } =
  await import('../packages/core/src/components/npi/NpiFiles.tsx')
const { NpiIssues } =
  await import('../packages/core/src/components/npi/NpiIssues.tsx')
const { useNpiFileOperation } =
  await import('../packages/core/src/components/npi/useNpiFileOperation.ts')
const { Dialog, DialogContent, DialogTitle, DialogDescription } =
  await import('../packages/core/src/components/ui/Dialog.tsx')
const { useState } = await import('react')
const { renderHook, act } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
const allow = { files: [], canUpload: true, canArchive: true }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function Host({ api, disabled = false }) {
  const [open, setOpen] = useState(true)
  const operation = useNpiFileOperation(open ? 'A' : null)
  return h(
    Dialog,
    {
      open,
      onOpenChange: (value) => {
        if (!operation.isBusy()) setOpen(value)
      },
    },
    h(
      DialogContent,
      { 'data-saving': operation.busy },
      h(DialogTitle, null, '资料窗口'),
      h(DialogDescription, null, '操作保护测试'),
      open &&
        h(NpiFiles, {
          api,
          scope: { kind: 'tracking', id: 'A' },
          disabled,
          onBusyChange: operation.onBusyChange,
        }),
    ),
  )
}
const selectFile = async () => {
  const input = await screen.findByLabelText('选择文件或照片')
  fireEvent.change(input, {
    target: { files: [new File(['png'], '照片.png', { type: 'image/png' })] },
  })
  return input
}
const button = (name) => screen.getByRole('button', { name, exact: true })
const submitFile = (input) => fireEvent.submit(input.closest('form'))
const close = () => fireEvent.click(button('Close'))
test.afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

test('upload blocks closing and repeated submission until refresh settles, then exposes success plus refresh error', async () => {
  const save = deferred(),
    refresh = deferred()
  let posts = 0,
    reads = 0
  const api = async (path, method = 'GET') => {
    if (method === 'POST') {
      posts++
      return save.promise
    }
    if (++reads > 1) return refresh.promise
    return allow
  }
  render(h(Host, { api }))
  const input = await selectFile()
  submitFile(input)
  submitFile(input)
  assert.equal(posts, 1)
  close()
  fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
  assert.ok(screen.getByRole('dialog'))
  assert.equal(input.matches(':disabled'), true)
  assert.match(screen.getByRole('dialog').textContent, /正在上传资料/)
  await act(async () => save.resolve({ id: 'saved' }))
  assert.equal(screen.getByRole('dialog').getAttribute('data-saving'), 'true')
  close()
  assert.ok(screen.getByRole('dialog'))
  await act(async () => refresh.reject(Error('资料列表离线')))
  await screen.findByText(/资料列表加载失败：资料列表离线/)
  assert.ok(screen.getByText('资料已上传成功，无需重复上传。'))
  assert.equal(posts, 1)
  close()
  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null))
})

test('archive locks the reason and close, retains input on failure, and recovers without changing the reason', async () => {
  const first = deferred()
  let posts = 0,
    archived = false
  const file = {
    id: 'file',
    title: '规格书',
    name: 'spec.pdf',
    mimeType: 'application/pdf',
    available: true,
    size: 10,
    uploader: '技术',
    createdAt: '2026-09-15T00:00:00Z',
  }
  const api = async (path, method = 'GET', data) => {
    if (method === 'POST') {
      posts++
      assert.equal(data.reason, '已替换新版')
      if (posts === 1) return first.promise
      archived = true
      return { ok: true }
    }
    return {
      ...allow,
      files: [
        {
          ...file,
          archivedAt: archived ? '2026-09-15T00:00:00Z' : null,
          archiveReason: '已替换新版',
        },
      ],
    }
  }
  render(h(Host, { api }))
  fireEvent.click(await screen.findByRole('button', { name: '归档资料' }))
  const reason = screen.getByLabelText('归档原因')
  fireEvent.change(reason, { target: { value: '已替换新版' } })
  fireEvent.submit(reason.closest('form'))
  fireEvent.submit(reason.closest('form'))
  assert.equal(posts, 1)
  assert.equal(reason.disabled, true)
  close()
  assert.ok(screen.getByRole('dialog'))
  assert.ok(button('正在归档…'))
  await act(async () => first.reject(Error('归档响应未收到')))
  await screen.findByText('归档响应未收到')
  assert.equal(reason.value, '已替换新版')
  fireEvent.submit(reason.closest('form'))
  await screen.findByText(/资料已归档，勾选/)
  assert.equal(posts, 2)
  close()
  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null))
})

test('older window callbacks cannot unlock another scope or a reopened visit of the same scope', () => {
  const { result, rerender } = renderHook(
    ({ scope }) => useNpiFileOperation(scope),
    { initialProps: { scope: 'A' } },
  )
  const oldA = result.current.onBusyChange
  act(() => oldA(true))
  assert.equal(result.current.isBusy(), true)
  rerender({ scope: 'B' })
  act(() => result.current.onBusyChange(true))
  act(() => oldA(false))
  assert.equal(result.current.busy, true)
  assert.equal(result.current.isBusy(), true)
  rerender({ scope: 'A' })
  act(() => result.current.onBusyChange(true))
  act(() => oldA(false))
  assert.equal(result.current.busy, true)
  assert.equal(result.current.isBusy(), true)
})

test('delegated material window shares upload protection and unlocks after failure', async () => {
  const upload = deferred()
  let posts = 0
  const item = {
    id: 'assigned',
    programId: 'foreign',
    projectName: '协作项目',
    projectCode: 'DELEGATED',
    name: '协作安装件',
    sourceType: 'EXTERNAL',
    trackingType: 'material',
    qty: '1',
    unit: '件',
    requiredDate: '2026-10-15',
    status: 'pending_reply',
    version: 1,
    currentNpiStage: 'manufacturing',
  }
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/workbench/materials'))
      return {
        ok: true,
        json: async () => ({
          actorId: 'actor',
          today: '2026-09-15',
          items: [item],
        }),
      }
    if (init.method === 'POST') {
      posts++
      return upload.promise
    }
    return { ok: true, json: async () => allow }
  }
  render(
    h(NpiAssignedMaterials, {
      actorId: 'actor',
      revision: {},
      managedProjectIds: [],
    }),
  )
  fireEvent.click(await screen.findByRole('button', { name: '资料与照片' }))
  const input = await selectFile()
  submitFile(input)
  close()
  assert.ok(screen.getByRole('dialog', { name: '物料资料与照片' }))
  await act(async () =>
    upload.resolve({ ok: false, json: async () => ({ error: '上传离线' }) }),
  )
  await screen.findByText('上传离线')
  assert.equal(input.files[0].name, '照片.png')
  assert.equal(posts, 1)
  close()
  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null))
})

const issue = {
  id: 'issue',
  title: '交付问题',
  number: 'ISSUE-1',
  description: '核对交付',
  severity: 'High',
  state: 'Open',
  ownerName: '技术',
  ownerId: 'technical',
  targetDate: '2026-10-15',
  version: 1,
  modifiedAt: '2026-09-15T00:00:00Z',
  relatedLabel: '整个项目',
  history: [],
  notes: [],
  transitions: [],
}
const meta = {
  actor: { id: 'technical', role: 'technical', name: '技术' },
  users: [{ id: 'technical', role: 'technical', name: '技术' }],
}
const project = { id: 'project', currentNpiStage: 'manufacturing', items: [] }
const common = (path) =>
  path.includes('/files/') ? allow : path.endsWith('/issues') ? [issue] : issue

test('issue attachment upload blocks issue edits and closing; issue writes disable attachment actions without hiding the selected file', async () => {
  const upload = deferred(),
    note = deferred()
  let uploads = 0,
    notes = 0
  const api = async (path, method = 'GET') => {
    if (method === 'POST') {
      if (path.endsWith('/notes')) {
        notes++
        return note.promise
      }
      uploads++
      return upload.promise
    }
    return common(path)
  }
  render(h(NpiIssues, { api, meta, project, onChanged: async () => {} }))
  fireEvent.click(await screen.findByText(issue.title))
  const input = await selectFile()
  submitFile(input)
  close()
  assert.ok(screen.getByRole('dialog', { name: issue.title }))
  assert.equal(button('记录进展').disabled, true)
  await act(async () => upload.resolve({ id: 'saved' }))
  await screen.findByText('资料已上传成功，无需重复上传。')
  await waitFor(() => assert.equal(button('记录进展').disabled, false))
  await selectFile()
  const message = screen.getByLabelText('补充处理记录')
  fireEvent.change(message, { target: { value: '协调完成' } })
  fireEvent.submit(message.closest('form'))
  assert.equal(input.matches(':disabled'), true)
  assert.equal(input.files[0].name, '照片.png')
  submitFile(input)
  assert.equal(uploads, 1)
  await act(async () => note.resolve({ ok: true }))
  await waitFor(() => assert.equal(input.matches(':disabled'), false))
  assert.equal(notes, 1)
  close()
  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null))
})
