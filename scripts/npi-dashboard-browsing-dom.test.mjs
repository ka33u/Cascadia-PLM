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
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
test.afterEach(() => cleanup())
const { NpiProjectDashboard } =
  await import('../packages/core/src/components/npi/NpiProjectDashboard.tsx')
const actor = { id: 'supervisor', role: 'supervisor' }
const make = (prefix, count, status) =>
  Array.from({ length: count }, (_, i) => {
    const id = prefix + String(i + 1).padStart(3, '0')
    return {
      id,
      name: id,
      code: id,
      motorModel: 'MODEL-' + id,
      manufacturingOwnerId: 'mfg',
      currentNpiStage: 'manufacturing',
      prototypeRequiredDate: '2026-10-20',
      riskStatus: status,
      items: [
        {
          id: 'item-' + id,
          name: '事项-' + id,
          ownerName: '制造员',
          requiredDate: '2026-10-15',
          currentCommittedDate:
            status === 'pending_reply' ? null : '2026-10-10',
          actualCompleteDate: null,
          trackingType: 'process',
          trackingEnabled: true,
          affectsKit: true,
          status,
        },
      ],
      kit: {
        pendingReplyCount: status === 'pending_reply' ? 1 : 0,
        riskCount: status === 'risk' ? 1 : 0,
        predictionComplete: status !== 'pending_reply',
        manufacturingCommittedKitDate: null,
        predictedKitDate: null,
        alerts: [],
        bottleneck: null,
      },
    }
  })
const projects = [
  ...make('P', 53, 'pending_reply'),
  ...make('O', 27, 'overdue'),
  ...make('R', 26, 'risk'),
  ...make('N', 26, 'normal'),
]
const dashboard = (rows = projects) => ({
  projects: rows,
  todayActivity: {
    day: '2026-10-11',
    newOverdue: [],
    promiseChanges: [],
    completions: [],
  },
})
const show = (rows = projects, onOpen = () => {}) =>
  render(
    h(NpiProjectDashboard, {
      dashboard: dashboard(rows),
      actor,
      view: 'dashboard',
      onOpen,
      onCreate: () => {},
    }),
  )
const region = (name) => within(screen.getByRole('region', { name }))
const pager = (name) => within(screen.getByRole('navigation', { name }))
const click = (scope, name) =>
  fireEvent.click(scope.getByRole('button', { name, exact: true }))
const rowsOf = (scope) =>
  scope.getAllByRole('button').filter((e) => e.hasAttribute('data-brief-id'))
const input = (name, value) =>
  fireEvent.change(screen.getByLabelText(name), { target: { value } })

test('project and normal groups page independently; filters search all rows and keep KPI scope', () => {
  show()
  assert.equal(
    within(screen.getByRole('table', { name: '项目结果' })).getAllByRole('row')
      .length,
    26,
  )
  assert.equal(screen.queryByRole('table', { name: '正常项目' }), null)
  click(pager('项目概览顶部翻页'), '下一页')
  const page2Ids = [
    ...screen
      .getByRole('table', { name: '项目结果' })
      .querySelectorAll('[data-project-id]'),
  ].map((e) => e.dataset.projectId)
  fireEvent.click(screen.getByRole('button', { name: /正常项目（26）/ }))
  click(pager('正常项目顶部翻页'), '末页')
  assert.equal(
    within(screen.getByRole('table', { name: '正常项目' })).getAllByRole('row')
      .length,
    2,
  )
  assert.deepEqual(
    [
      ...screen
        .getByRole('table', { name: '项目结果' })
        .querySelectorAll('[data-project-id]'),
    ].map((e) => e.dataset.projectId),
    page2Ids,
  )
  click(pager('项目概览顶部翻页'), '下一页')
  assert.match(
    screen.getByRole('navigation', { name: '正常项目顶部翻页' }).textContent,
    /第2\/2页/,
  )
  input('搜索项目', 'P053')
  assert.equal(
    within(screen.getByRole('table', { name: '项目结果' })).getAllByRole('row')
      .length,
    2,
  )
  assert.match(
    screen.getByRole('table', { name: '项目结果' }).textContent,
    /P053/,
  )
  assert.match(
    screen.getByRole('group', { name: '项目指标' }).textContent,
    /在研新品132/,
  )
  assert.equal(
    screen.queryByRole('navigation', { name: '项目概览顶部翻页' }),
    null,
  )
  click(
    within(screen.getByRole('group', { name: '项目指标' })),
    '逾期项目27查看项目',
  )
  assert.equal(screen.getByLabelText('搜索项目').value, '')
  assert.match(
    screen.getByRole('navigation', { name: '项目概览顶部翻页' }).textContent,
    /第1\/2页/,
  )
})

test('all todo and warning records are reachable; searches cover hidden pages and include overdue-only cases', () => {
  const opens = []
  show(projects, (...args) => opens.push(args))
  const todos = region('今日待办'),
    warnings = region('风险预警')
  assert.equal(rowsOf(todos).length, 5)
  assert.equal(rowsOf(warnings).length, 5)
  click(todos, '查看全部待办')
  assert.equal(rowsOf(todos).length, 25)
  click(pager('今日待办顶部翻页'), '末页')
  assert.equal(rowsOf(todos).length, 5)
  input('今日待办搜索', 'P053')
  assert.equal(rowsOf(todos).length, 1)
  fireEvent.click(rowsOf(todos)[0])
  assert.deepEqual(opens.pop(), ['P053', 'item-P053'])
  input('今日待办状态', 'overdue')
  assert.equal(todos.queryByText(/事项-P053/), null)
  assert.match(todos.getByText(/没有符合条件/).textContent, /没有符合条件/)
  input('今日待办搜索', '')
  assert.equal(rowsOf(todos).length, 25)
  click(pager('今日待办顶部翻页'), '末页')
  assert.equal(rowsOf(todos).length, 2)
  click(warnings, '查看全部预警')
  click(pager('风险预警顶部翻页'), '末页')
  assert.equal(rowsOf(warnings).length, 3)
  assert.equal(rowsOf(todos).length, 2)
  input('风险预警搜索', 'O027')
  assert.equal(rowsOf(warnings).length, 1)
  fireEvent.click(rowsOf(warnings)[0])
  assert.deepEqual(opens.pop(), ['O027', undefined])
  assert.match(rowsOf(warnings)[0].textContent, /逾期未完成/)
  input('风险预警状态', 'risk')
  assert.equal(rowsOf(warnings).length, 0)
  click(warnings, '收起预警')
  assert.equal(rowsOf(warnings).length, 5)
  click(warnings, '查看全部预警')
  assert.equal(screen.getByLabelText('风险预警搜索').value, '')
  assert.match(
    screen.getByRole('navigation', { name: '风险预警顶部翻页' }).textContent,
    /第1\/3页/,
  )
})

test('refresh clamps all list pages; retired, completed and finished-project tasks never appear', () => {
  const omitted = make('X', 4, 'overdue')
  omitted[0].items[0].trackingEnabled = false
  omitted[0].items[0].affectsKit = false
  omitted[1].items[0].actualCompleteDate = '2026-10-10'
  omitted[2].currentNpiStage = 'completed'
  omitted[2].riskStatus = 'completed'
  omitted[3].items[0].status = 'normal'
  omitted[3].riskStatus = 'normal'
  const result = show([...projects, ...omitted])
  const todos = region('今日待办')
  click(todos, '查看全部待办')
  input('今日待办搜索', 'X')
  assert.equal(rowsOf(todos).length, 0)
  input('今日待办搜索', '')
  click(pager('今日待办顶部翻页'), '末页')
  click(pager('项目概览顶部翻页'), '末页')
  result.rerender(
    h(NpiProjectDashboard, {
      dashboard: dashboard(projects.slice(0, 3)),
      actor,
      view: 'dashboard',
      onOpen: () => {},
      onCreate: () => {},
    }),
  )
  assert.equal(rowsOf(todos).length, 3)
  assert.equal(
    within(screen.getByRole('table', { name: '项目结果' })).getAllByRole('row')
      .length,
    4,
  )
  assert.equal(
    screen.queryByRole('navigation', { name: '今日待办顶部翻页' }),
    null,
  )
})
