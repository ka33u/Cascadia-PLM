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
const { useState, act } = await import('react')
const source =
  process.env.NPI_MFG_COMPONENT_ROOT || '../packages/core/src/components/npi/'
const { NpiManufacturingReplyDialog } = await import(
  source + 'NpiManufacturingReplyDialog.tsx'
)
const { NpiManufacturingReply } = await import(
  source + 'NpiManufacturingReply.tsx'
)
const makeProject = (version = 1, dates = {}) => ({
  id: 'project-A',
  name: '测试制造项目',
  code: 'NPI-A',
  currentNpiStage: 'manufacturing',
  manufacturingOwnerId: 'mfg-A',
  plan: { version },
  items: ['process', 'tooling', 'kit', 'assembly'].map((type) => ({
    id: type + '-A',
    trackingType: type,
    sourceType: 'MANUFACTURING',
    requiredDate: '2026-10-15',
    currentCommittedDate: dates[type] || null,
    actualCompleteDate: null,
  })),
})
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function mount({
  initial = makeProject(),
  api,
  load,
  saved,
  inline = false,
  exception,
} = {}) {
  let project = initial,
    closed = 0
  function Harness() {
    const [p, setP] = useState(initial)
    const [open, setOpen] = useState(true)
    if (!open) return null
    return h(inline ? NpiManufacturingReply : NpiManufacturingReplyDialog, {
      project: p,
      api,
      readOnly: p.manufacturingOwnerId !== 'mfg-A',
      onReload: async () => {
        project = await load()
        setP(project)
        return project
      },
      onSaved: async () => {
        const next = await saved?.()
        if (next) {
          project = next
          setP(project)
        }
      },
      onClose: () => {
        closed++
        setOpen(false)
      },
      onException: exception,
    })
  }
  render(h(Harness))
  return { closed: () => closed, project: () => project }
}
const fill = (label, value) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
const save = () =>
  fireEvent.click(screen.getByRole('button', { name: '保存制造回复' }))

test('Known saved reply retries only refresh after two failures and keeps the dialog open', async () => {
  let puts = 0,
    refreshes = 0
  const view = mount({
    api: async () => {
      puts++
      return { version: 2 }
    },
    saved: async () => {
      refreshes++
      if (refreshes < 3) throw Error('清单读取失败')
      return makeProject(2, { process: '2026-10-10' })
    },
  })
  fill('工艺准备承诺日期', '2026-10-10')
  save()
  await screen.findByRole('button', { name: '重试刷新列表' })
  assert.equal(view.closed(), 0)
  assert.match(screen.getByRole('alert').textContent, /制造承诺已保存/)
  assert.equal(
    screen.getByLabelText('工艺准备承诺日期').matches(':disabled'),
    true,
  )
  fireEvent.click(screen.getByRole('button', { name: '重试刷新列表' }))
  await waitFor(() => assert.equal(refreshes, 2))
  await waitFor(() =>
    assert.equal(
      screen.getByRole('button', { name: '重试刷新列表' }).disabled,
      false,
    ),
  )
  fireEvent.click(screen.getByRole('button', { name: '重试刷新列表' }))
  await waitFor(() => assert.equal(view.closed(), 1))
  assert.equal(puts, 1)
  assert.equal(refreshes, 3)
})

test('Two synchronous submissions produce one PUT and hold close until save finishes', async () => {
  const held = deferred()
  let puts = 0
  const view = mount({
    api: async () => {
      puts++
      await held.promise
      return { version: 2 }
    },
    saved: async () => makeProject(2, { process: '2026-10-10' }),
  })
  fill('工艺准备承诺日期', '2026-10-10')
  const form = screen.getByLabelText('工艺准备承诺日期').closest('form')
  act(() => {
    fireEvent.submit(form)
    fireEvent.submit(form)
  })
  assert.equal(puts, 1)
  fireEvent.keyDown(document, { key: 'Escape' })
  assert.equal(view.closed(), 0)
  assert.equal(
    screen.getByRole('button', { name: '取消' }).matches(':disabled'),
    true,
  )
  await act(async () => held.resolve())
  await waitFor(() => assert.equal(view.closed(), 1))
})

test('Unknown response requires a fresh read and does not resubmit a committed date', async () => {
  let puts = 0,
    reads = 0
  mount({
    api: async () => {
      puts++
      throw Error('响应丢失')
    },
    load: async () => {
      reads++
      return makeProject(2, { process: '2026-10-10' })
    },
  })
  fill('工艺准备承诺日期', '2026-10-10')
  save()
  await screen.findByRole('alert')
  assert.equal(
    screen.getByRole('button', { name: '保存制造回复' }).matches(':disabled'),
    true,
  )
  fireEvent.click(screen.getByRole('button', { name: '刷新最新计划' }))
  await screen.findByRole('button', { name: '载入最新计划' })
  fireEvent.click(screen.getByRole('button', { name: '载入最新计划' }))
  save()
  await waitFor(() =>
    assert.match(screen.getByRole('status').textContent, /没有需要保存/),
  )
  assert.equal(puts, 1)
  assert.equal(reads, 1)
})

test('Conflict review preserves edited dates and reasons, updates untouched nodes and locks completed nodes', async () => {
  const initial = makeProject(1, { process: '2026-10-10' }),
    next = makeProject(2, {
      process: '2026-10-11',
      tooling: '2026-10-09',
      kit: '2026-10-15',
    })
  next.items.find((i) => i.trackingType === 'kit').actualCompleteDate =
    '2026-09-15'
  const writes = []
  const view = mount({
    initial,
    api: async (_path, _method, data) => {
      writes.push(data)
      if (writes.length === 1) throw Error('版本冲突')
      return { version: 3 }
    },
    load: async () => next,
    saved: async () =>
      makeProject(3, {
        process: '2026-10-12',
        tooling: '2026-10-09',
        kit: '2026-10-15',
      }),
  })
  fill('工艺准备承诺日期', '2026-10-12')
  fill('工艺准备改期原因', '评审后调整')
  fill('零部件齐套承诺日期', '2026-10-17')
  save()
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: '刷新最新计划' }))
  await screen.findByRole('button', { name: '载入最新计划' })
  fireEvent.click(screen.getByRole('button', { name: '载入最新计划' }))
  assert.equal(screen.getByLabelText('工艺准备承诺日期').value, '2026-10-12')
  assert.equal(screen.getByLabelText('工艺准备改期原因').value, '评审后调整')
  assert.equal(screen.getByLabelText('工装准备承诺日期').value, '2026-10-09')
  assert.equal(screen.getByLabelText('零部件齐套承诺日期').value, '2026-10-15')
  assert.equal(screen.getByLabelText('零部件齐套承诺日期').disabled, true)
  save()
  await waitFor(() => assert.equal(view.closed(), 1))
  assert.deepEqual(writes[1], {
    expectedVersion: 2,
    processCommitted: '2026-10-12',
    changeReasons: { processCommitted: '评审后调整' },
  })
})

test('Failed read blocks writes and refreshed ownership removes editing permission', async () => {
  let puts = 0,
    reads = 0
  const held = deferred()
  const view = mount({
    api: async () => {
      puts++
      throw Error('未知结果')
    },
    load: async () => {
      reads++
      if (reads === 1) throw Error('读取失败')
      await held.promise
      return { ...makeProject(), manufacturingOwnerId: 'mfg-B' }
    },
  })
  fill('工艺准备承诺日期', '2026-10-10')
  save()
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: '刷新最新计划' }))
  await waitFor(() =>
    assert.match(screen.getByRole('alert').textContent, /读取失败/),
  )
  assert.equal(
    screen.getByRole('button', { name: '保存制造回复' }).disabled,
    true,
  )
  fireEvent.click(screen.getByRole('button', { name: '刷新最新计划' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  assert.equal(view.closed(), 0)
  await act(async () => held.resolve())
  await screen.findByText('由项目制造负责人回复')
  assert.equal(
    screen.getByLabelText('工艺准备承诺日期').matches(':disabled'),
    true,
  )
  assert.equal(puts, 1)
})

test('Inline reply restores editing after refresh-only recovery and pauses the exception action', async () => {
  let puts = 0,
    refreshes = 0,
    exceptions = 0
  const held = deferred()
  mount({
    inline: true,
    api: async () => {
      puts++
      return { version: puts + 1 }
    },
    saved: async () => {
      refreshes++
      if (refreshes === 1) throw Error('汇总失败')
      await held.promise
      return makeProject(2, { process: '2026-10-10' })
    },
    exception: () => exceptions++,
  })
  fill('工艺准备承诺日期', '2026-10-10')
  save()
  await screen.findByRole('button', { name: '重试刷新列表' })
  assert.equal(
    screen.getByRole('button', { name: '添加异常件' }).disabled,
    true,
  )
  fireEvent.click(screen.getByRole('button', { name: '重试刷新列表' }))
  await act(async () => held.resolve())
  await waitFor(() =>
    assert.equal(
      screen.getByLabelText('工艺准备承诺日期').matches(':disabled'),
      false,
    ),
  )
  assert.equal(screen.getByLabelText('工艺准备承诺日期').value, '2026-10-10')
  assert.equal(screen.queryByRole('button', { name: '重试刷新列表' }), null)
  assert.equal(puts, 1)
  assert.equal(refreshes, 2)
  assert.equal(exceptions, 0)
})
