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
const { NpiIssues } =
  await import('../packages/core/src/components/npi/NpiIssues.tsx')
const meta = {
  actor: { id: 'technical', role: 'technical', name: '技术' },
  users: [],
}
const project = { id: 'project', currentNpiStage: 'manufacturing' }
const item = {
  id: 'issue',
  number: 'ISS-1',
  title: '供应商交期协调',
  description: '核对交付计划',
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
const files = { files: [], canUpload: false, canArchive: false }
const common = async (path) => {
  if (path.includes('/files/')) return files
  if (path.endsWith('/issues')) return [item]
  if (path === '/issues/issue') return item
  throw new Error('Unexpected path ' + path)
}
try {
  await test('Failed first list load has an explicit retry and never appears as an empty issue list', async () => {
    let fail = true
    const api = async (path) => {
      if (path.endsWith('/issues') && fail) throw new Error('列表离线')
      return common(path)
    }
    render(h(NpiIssues, { api, meta, project, onChanged: async () => {} }))
    await screen.findByText(/问题刷新失败：列表离线/)
    assert.equal(screen.queryByText('暂无符合条件的项目问题。'), null)
    assert.equal(
      screen.getByRole('button', { name: '新建问题' }).disabled,
      true,
    )
    fail = false
    fireEvent.click(
      screen.getByRole('button', { name: '刷新问题', exact: true }),
    )
    await screen.findByText(item.title)
    assert.equal(screen.queryByRole('alert'), null)
    cleanup()
  })
  await test('Saved note clears once, refresh failure disables writes, and recovery sends GET only', async () => {
    let posts = 0,
      rejectPost = true,
      failDetail = false,
      gets = 0
    const api = async (path, method = 'GET', body) => {
      if (method === 'POST') {
        assert.equal(path, '/issues/issue/notes')
        assert.equal(body.message, '供应商已回复')
        posts++
        if (rejectPost) throw new Error('保存暂不可用')
        failDetail = true
        return { id: 'issue' }
      }
      if (path === '/issues/issue') {
        gets++
        if (failDetail) {
          failDetail = false
          throw new Error('详情暂不可用')
        }
      }
      return common(path)
    }
    render(h(NpiIssues, { api, meta, project, onChanged: async () => {} }))
    fireEvent.click(await screen.findByText(item.title))
    const input = await screen.findByLabelText('补充处理记录')
    fireEvent.change(input, { target: { value: '供应商已回复' } })
    fireEvent.submit(input.closest('form'))
    await screen.findByText(
      /未收到保存确认，填写内容已保留。可直接重试当前记录：保存暂不可用/,
    )
    assert.equal(input.value, '供应商已回复')
    rejectPost = false
    fireEvent.submit(input.closest('form'))
    await screen.findByText(/问题刷新失败：详情暂不可用/)
    assert.ok(screen.getByText('已保存成功，无需重复提交。'))
    assert.equal(input.value, '')
    assert.equal(input.closest('fieldset').disabled, true)
    assert.equal(
      screen.getByRole('button', { name: '记录进展' }).disabled,
      true,
    )
    fireEvent.submit(input.closest('form'))
    assert.equal(posts, 2)
    fireEvent.click(screen.getByRole('button', { name: '刷新问题详情' }))
    await waitFor(() => assert.equal(input.closest('fieldset').disabled, false))
    assert.equal(screen.queryByRole('alert'), null)
    assert.equal(posts, 2)
    assert.equal(gets, 3)
    cleanup()
  })
  await test('Parent summary refresh failure after a saved note is recoverable without another POST', async () => {
    let posts = 0,
      failParent = true,
      changes = 0
    const api = async (path, method = 'GET') => {
      if (method === 'POST') {
        posts++
        return { id: 'issue' }
      }
      return common(path)
    }
    const onChanged = async () => {
      changes++
      if (failParent) throw new Error('项目摘要离线')
    }
    render(h(NpiIssues, { api, meta, project, onChanged }))
    fireEvent.click(await screen.findByText(item.title))
    const input = await screen.findByLabelText('补充处理记录')
    fireEvent.change(input, { target: { value: '已协调' } })
    fireEvent.submit(input.closest('form'))
    await screen.findByText(/问题刷新失败：项目摘要离线/)
    assert.equal(input.value, '')
    failParent = false
    fireEvent.click(screen.getByRole('button', { name: '刷新问题详情' }))
    await waitFor(() => assert.equal(input.closest('fieldset').disabled, false))
    assert.equal(posts, 1)
    assert.equal(changes, 2)
    cleanup()
  })
  await test('New issue closes after confirmed creation and retries failed list refresh without creating twice', async () => {
    let posts = 0,
      failList = false
    const api = async (path, method = 'GET', body) => {
      if (method === 'POST') {
        assert.equal(path, '/projects/project/issues')
        assert.equal(body.title, '新协调问题')
        posts++
        failList = true
        return { id: 'created' }
      }
      if (path.endsWith('/bom/tree')) return { rows: [] }
      if (path.endsWith('/issues') && failList) {
        failList = false
        throw new Error('新建后列表离线')
      }
      return common(path)
    }
    render(
      h(NpiIssues, {
        api,
        meta: {
          ...meta,
          users: [{ id: 'technical', name: '技术', role: 'technical' }],
        },
        project: {
          ...project,
          items: [],
          technicalOwnerId: 'technical',
          requiredKitDate: '2026-10-15',
        },
        onChanged: async () => {},
      }),
    )
    await screen.findByText(item.title)
    fireEvent.click(screen.getByRole('button', { name: '新建问题' }))
    const title = await screen.findByLabelText('问题标题')
    fireEvent.change(title, { target: { value: '新协调问题' } })
    fireEvent.change(screen.getByLabelText('问题说明'), {
      target: { value: '需要协调供应商' },
    })
    fireEvent.submit(title.closest('form'))
    await screen.findByText(/问题刷新失败：新建后列表离线/)
    assert.equal(screen.queryByRole('dialog'), null)
    assert.ok(screen.getByText('已保存成功，无需重复提交。'))
    assert.equal(
      screen.getByRole('button', { name: '新建问题' }).disabled,
      true,
    )
    fireEvent.click(
      screen.getByRole('button', { name: '刷新问题', exact: true }),
    )
    await waitFor(() =>
      assert.equal(
        screen.getByRole('button', { name: '新建问题' }).disabled,
        false,
      ),
    )
    assert.equal(posts, 1)
    cleanup()
  })
  await test('Uncertain note response retries with the same key and a later intentional note gets a new key', async () => {
    const attempts = [],
      stored = new Map()
    const api = async (path, method = 'GET', body) => {
      if (method === 'POST') {
        assert.equal(path, '/issues/issue/notes')
        attempts.push(body)
        assert.match(body.requestId, /^[0-9a-f-]{36}$/)
        stored.set(body.requestId, body.message)
        if (attempts.length === 1) throw new Error('连接中断，未收到结果')
        return { id: 'issue' }
      }
      return common(path)
    }
    render(h(NpiIssues, { api, meta, project, onChanged: async () => {} }))
    fireEvent.click(await screen.findByText(item.title))
    const input = await screen.findByLabelText('补充处理记录')
    fireEvent.change(input, { target: { value: '已与供应商确认' } })
    fireEvent.submit(input.closest('form'))
    await screen.findByText(/连接中断，未收到结果/)
    assert.equal(input.value, '已与供应商确认')
    fireEvent.submit(input.closest('form'))
    await waitFor(() => assert.equal(input.closest('fieldset').disabled, false))
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].requestId, attempts[1].requestId)
    assert.equal(stored.size, 1)
    assert.equal(input.value, '')
    fireEvent.change(input, { target: { value: '已与供应商确认' } })
    fireEvent.submit(input.closest('form'))
    await waitFor(() => assert.equal(input.closest('fieldset').disabled, false))
    assert.equal(attempts.length, 3)
    assert.notEqual(attempts[1].requestId, attempts[2].requestId)
    assert.equal(stored.size, 2)
    cleanup()
  })
  await test('Switching projects discards the previous project delayed list response', async () => {
    let resolveOld
    const old = new Promise((resolve) => {
      resolveOld = resolve
    })
    const api = async (path) =>
      path === '/projects/project/issues'
        ? old
        : [{ ...item, id: 'next', title: '新项目问题' }]
    const props = { api, meta, project, onChanged: async () => {} }
    const view = render(h(NpiIssues, props))
    view.rerender(
      h(NpiIssues, { ...props, project: { ...project, id: 'next' } }),
    )
    await screen.findByText('新项目问题')
    const { act } = await import('@testing-library/react')
    await act(async () => {
      resolveOld([item])
      await old
    })
    assert.equal(screen.queryByText(item.title), null)
    assert.ok(screen.getByText('新项目问题'))
    cleanup()
  })
} finally {
  cleanup()
  dom.window.close()
}
