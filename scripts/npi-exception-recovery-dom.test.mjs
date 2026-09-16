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

dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
globalThis.React = await import('react')
const { NpiManufacturingException } = await import(
  process.env.NPI_EXCEPTION_SOURCE ||
    '../packages/core/src/components/npi/NpiManufacturingException.tsx'
)
const actor = { id: 'maker', role: 'manufacturing' }
const project = {
  id: 'p1',
  name: '样机',
  version: 2,
  currentNpiStage: 'manufacturing',
  manufacturingOwnerId: 'maker',
  activeBomImportId: 'bom1',
  requiredKitDate: '2026-10-10',
  items: [],
}
const rows = [
  {
    id: 'row1',
    materialCode: 'PART',
    materialName: '机壳',
    qty: '1',
    unit: '件',
    level: 1,
    rowNo: 2,
  },
]
const tracking = {
  id: 'track1',
  bomItemId: 'row1',
  ownerId: 'maker',
  ownerName: '制造',
  trackingType: 'material',
  version: 3,
  requiredDate: '2026-10-10',
  firstCommittedDate: '2026-10-08',
  currentCommittedDate: '2026-10-08',
  actualCompleteDate: null,
  affectsKit: true,
}
const change = (label, value) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
const button = (name) => screen.getByRole('button', { name, exact: true })
const click = (name) => fireEvent.click(button(name))
const setupCase = ({
  initial = project,
  initialRows = rows,
  readFail = false,
  save = async () => ({ id: 'track1' }),
  onSaved = async () => {},
  onClose = () => {},
} = {}) => {
  let data = structuredClone(initial),
    bomRows = structuredClone(initialRows),
    person = { ...actor },
    fail = readFail
  const writes = []
  const api = async (path, method = 'GET', body) => {
    if (method === 'POST') {
      writes.push(body)
      return save(body)
    }
    if (fail) throw Error('读取暂不可用')
    if (path === '/meta')
      return {
        actor: person,
        users: [{ id: data.manufacturingOwnerId, name: '现任制造' }],
      }
    if (path.endsWith('/p1')) return structuredClone(data)
    if (path.includes('/bom/tree')) return { rows: structuredClone(bomRows) }
    throw Error('Unexpected path ' + path)
  }
  const view = render(
    h(NpiManufacturingException, {
      projectId: 'p1',
      actorId: 'maker',
      api,
      onSaved,
      onClose,
    }),
  )
  return {
    view,
    writes,
    setProject: (next) => {
      data = next
    },
    setRows: (next) => {
      bomRows = next
    },
    setActor: (next) => {
      person = next
    },
    setFail: (value) => {
      fail = value
    },
  }
}
const choose = async () => {
  await waitFor(() =>
    assert.equal(button('选择PART 机壳 第2行').disabled, false),
  )
  click('选择PART 机壳 第2行')
}
const fill = () => {
  change('预计完成日期', '2026-10-12')
  change('异常原因', '机壳加工延迟')
}

test('known saved with failed refresh offers read-only retries and blocks repeated writes', async () => {
  let refreshes = 0,
    closes = 0
  const c = setupCase({
    onSaved: async () => {
      if (++refreshes < 3) throw Error('列表读取失败')
    },
    onClose: () => closes++,
  })
  await choose()
  fill()
  click('保存异常件')
  await waitFor(() => assert.ok(screen.getByRole('alert')))
  assert.equal(button('重试刷新列表').disabled, false)
  assert.match(screen.getByRole('alert').textContent, /已保存.*刷新失败/)
  assert.equal(closes, 0)
  assert.equal(c.writes.length, 1)
  assert.equal(screen.getByLabelText('预计完成日期').matches(':disabled'), true)
  click('重试刷新列表')
  await waitFor(() => assert.equal(refreshes, 2))
  await waitFor(() => assert.equal(button('重试刷新列表').disabled, false))
  click('重试刷新列表')
  await waitFor(() => assert.equal(closes, 1))
  assert.equal(c.writes.length, 1)
  assert.equal(refreshes, 3)
})

test('uncertain save locks resubmission until fresh BOM is explicitly reviewed and retains edited date/reason with updated untouched kit flag', async () => {
  let reject = true
  const c = setupCase({
    initial: { ...project, items: [tracking] },
    save: async () => {
      if (reject) throw Error('连接断开')
      return { id: 'track1' }
    },
  })
  await choose()
  fill()
  click('保存异常件')
  await waitFor(() =>
    assert.match(screen.getByRole('alert').textContent, /未确认/),
  )
  assert.equal(button('保存异常件').disabled, true)
  c.setProject({
    ...project,
    version: 7,
    items: [
      {
        ...tracking,
        version: 9,
        currentCommittedDate: '2026-10-11',
        affectsKit: false,
      },
    ],
  })
  click('重新载入BOM')
  await waitFor(() =>
    assert.ok(screen.getByRole('button', { name: '核对后载入最新BOM' })),
  )
  assert.equal(button('保存异常件').disabled, true)
  assert.equal(screen.getByLabelText('预计完成日期').value, '2026-10-12')
  click('核对后载入最新BOM')
  assert.equal(screen.getByLabelText('预计完成日期').value, '2026-10-12')
  assert.equal(screen.getByLabelText('异常原因').value, '机壳加工延迟')
  assert.equal(screen.getByLabelText('影响齐套').checked, false)
  reject = false
  click('保存异常件')
  await waitFor(() => assert.equal(c.writes.length, 2))
  assert.equal(c.writes[1].expectedVersion, 9)
  assert.equal(c.writes[1].expectedProjectVersion, 7)
})

test('reload merges untouched date and keeps changed kit flag; BOM replacement never silently selects same-code new row', async () => {
  const c = setupCase({ initial: { ...project, items: [tracking] } })
  await choose()
  change('异常原因', '保留原因')
  fireEvent.click(screen.getByLabelText('影响齐套'))
  c.setProject({
    ...project,
    items: [{ ...tracking, version: 4, currentCommittedDate: '2026-10-11' }],
  })
  click('重新载入BOM')
  await waitFor(() =>
    assert.ok(screen.getByRole('button', { name: '核对后载入最新BOM' })),
  )
  click('核对后载入最新BOM')
  assert.equal(screen.getByLabelText('预计完成日期').value, '2026-10-11')
  assert.equal(screen.getByLabelText('影响齐套').checked, false)
  c.setProject({ ...project, version: 3, activeBomImportId: 'bom2' })
  c.setRows([{ ...rows[0], id: 'new-row' }])
  click('重新载入BOM')
  await waitFor(() =>
    assert.ok(screen.getByRole('button', { name: '核对后载入最新BOM' })),
  )
  assert.ok(screen.getByText(/原选中物料不在当前BOM/))
  click('核对后载入最新BOM')
  assert.equal(button('保存异常件').disabled, true)
  assert.equal(
    button('选择PART 机壳 第2行').getAttribute('aria-pressed'),
    'false',
  )
  assert.equal(screen.getByLabelText('异常原因').value, '保留原因')
  click('选择PART 机壳 第2行')
  assert.equal(screen.getByLabelText('异常原因').value, '')
  assert.equal(c.writes.length, 0)
})

test('failed reread, completed item, completed project, changed actor and transferred responsibility cannot unlock stale save', async () => {
  const c = setupCase({ initial: { ...project, items: [tracking] } })
  await choose()
  fill()
  c.setFail(true)
  click('重新载入BOM')
  await waitFor(() => assert.ok(screen.getByRole('alert')))
  assert.equal(button('保存异常件').disabled, true)
  c.setFail(false)
  c.setProject({
    ...project,
    items: [{ ...tracking, actualCompleteDate: '2026-10-10' }],
  })
  click('重新载入BOM')
  await waitFor(() =>
    assert.ok(screen.getByRole('button', { name: '核对后载入最新BOM' })),
  )
  click('核对后载入最新BOM')
  assert.equal(button('保存异常件').disabled, true)
  c.setProject({ ...project, manufacturingOwnerId: 'new-maker' })
  click('重新载入BOM')
  await waitFor(() =>
    assert.ok(screen.getByRole('button', { name: '核对后载入最新BOM' })),
  )
  assert.equal(button('核对后载入最新BOM').disabled, true)
  assert.equal(button('保存异常件').disabled, true)
  c.setProject({ ...project, currentNpiStage: 'completed' })
  click('重新载入BOM')
  await waitFor(() =>
    assert.ok(screen.getByRole('button', { name: '核对后载入最新BOM' })),
  )
  assert.equal(button('核对后载入最新BOM').disabled, true)
  c.setProject(project)
  c.setActor({ id: 'different', role: 'admin' })
  click('重新载入BOM')
  await waitFor(() =>
    assert.match(screen.getByRole('alert').textContent, /登录账号已改变/),
  )
  assert.equal(button('保存异常件').disabled, true)
  assert.equal(c.writes.length, 0)
})

test('pending write blocks close and double submit; late completion after unmount calls neither refresh nor close', async () => {
  let release,
    refreshes = 0,
    closes = 0
  const c = setupCase({
    save: () =>
      new Promise((resolve) => {
        release = resolve
      }),
    onSaved: async () => {
      refreshes++
    },
    onClose: () => closes++,
  })
  await choose()
  fill()
  const form = button('保存异常件').closest('form')
  fireEvent.submit(form)
  fireEvent.submit(form)
  fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
  click('取消')
  assert.equal(c.writes.length, 1)
  assert.equal(closes, 0)
  c.view.unmount()
  release({ id: 'track1' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(refreshes, 0)
  assert.equal(closes, 0)
})

test('an empty BOM can reload after import; a 25-row BOM supports full search and page selection', async () => {
  const many = Array.from({ length: 25 }, (_, n) => ({
    ...rows[0],
    id: 'r' + n,
    materialCode: 'P' + n,
    rowNo: n + 2,
  }))
  const c = setupCase({ initialRows: many })
  await waitFor(() =>
    assert.ok(screen.getByRole('navigation', { name: '异常件BOM分页' })),
  )
  click('末页')
  assert.equal(screen.getAllByRole('button', { name: /^选择P/ }).length, 5)
  change('搜索异常件BOM', 'P0')
  assert.equal(screen.getAllByRole('button', { name: /^选择P/ }).length, 1)
  assert.equal(
    screen.queryByRole('navigation', { name: '异常件BOM分页' }),
    null,
  )
  c.view.unmount()
  const d = setupCase({ initial: { ...project, activeBomImportId: null } })
  await waitFor(() => assert.ok(screen.getByText(/当前没有BOM/)))
  d.setProject(project)
  click('重新载入BOM')
  await waitFor(() =>
    assert.ok(screen.getByRole('button', { name: '核对后载入最新BOM' })),
  )
  click('核对后载入最新BOM')
  await choose()
  assert.equal(button('保存异常件').disabled, false)
})

test('initial read failure stays recoverable without selecting stale data', async () => {
  const c = setupCase({ readFail: true })
  await waitFor(() => assert.ok(screen.getByRole('alert')))
  assert.equal(button('保存异常件').disabled, true)
  c.setFail(false)
  click('重新载入BOM')
  await waitFor(() =>
    assert.ok(screen.getByRole('button', { name: '核对后载入最新BOM' })),
  )
  click('核对后载入最新BOM')
  await choose()
  assert.equal(button('保存异常件').disabled, false)
})
