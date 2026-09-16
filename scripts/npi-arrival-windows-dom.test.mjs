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

dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { NpiProcurementWorkbench } =
  await import('../packages/core/src/components/npi/NpiProcurementWorkbench.tsx')
const { NpiPreparationBoard } =
  await import('../packages/core/src/components/npi/NpiModuleViews.tsx')
const { arrivalRange, matchesArrivalWindow } =
  await import('../packages/core/src/lib/npi/procurement-arrival.ts')
const day = '2026-12-28'
const date = (n) =>
  new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10)
const item = (id, offset, extra = {}) => ({
  id,
  name: id,
  programId: 'project',
  projectCode: 'P-1',
  projectName: '新品电机',
  ownerId: 'buyer1',
  ownerName: '同名采购',
  sourceType: 'EXTERNAL',
  trackingType: 'purchase',
  trackingEnabled: true,
  affectsKit: true,
  status: 'normal',
  requiredDate: date(30),
  currentCommittedDate: offset == null ? null : date(offset),
  actualCompleteDate: null,
  firstCommittedDate: date(25),
  changeCount: 1,
  ...extra,
})
const sample = [
  item('晚风险', 7, { status: 'risk', requiredDate: date(1) }),
  item('明日', 1),
  item('今日', 0),
  item('八日', 8),
  item('十四日', 14),
  item('十五日', 15),
  item('过期', -1, { status: 'overdue' }),
  item('已到货', 0, { actualCompleteDate: day, status: 'completed' }),
  item('待回复', null, { status: 'pending_reply' }),
  item('其他采购', 0, { ownerId: 'buyer2' }),
]
const personal = (items) =>
  render(
    h(NpiProcurementWorkbench, {
      items,
      today: day,
      renderTable: (rows) =>
        h(
          'ol',
          { 'aria-label': '测试物料' },
          rows.map((i) => h('li', { key: i.id }, i.name)),
        ),
    }),
  )
const selected = (label, value) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
const names = () =>
  within(screen.getByRole('list', { name: '测试物料' }))
    .getAllByRole('listitem')
    .map((el) => el.textContent)
const board = (items = sample, props = {}) =>
  render(
    h(NpiPreparationBoard, {
      dashboard: {
        projects: [
          {
            id: 'project',
            name: '新品电机',
            code: 'P-1',
            motorModel: 'M1',
            currentNpiStage: 'manufacturing',
            manufacturingOwnerId: 'maker',
            items,
          },
        ],
        todayActivity: { day },
      },
      actor: { id: 'manager', role: 'supervisor' },
      users: [
        { id: 'buyer1', name: '同名采购', email: 'one@example.invalid' },
        { id: 'buyer2', name: '同名采购', email: 'two@example.invalid' },
      ],
      mode: 'purchasing',
      onOpen: () => {},
      onReply: () => {
        throw Error('readonly')
      },
      onComplete: () => {
        throw Error('readonly')
      },
      ...props,
    }),
  )
const taskNames = () =>
  [...document.querySelectorAll('tbody tr')].map(
    (el) => el.querySelector('strong').textContent,
  )

test('arrival windows include today and cutoff across month/year/leap boundaries; exclude past, uncommitted and arrived records', () => {
  assert.deepEqual(arrivalRange(day, 'today'), { from: day, to: day })
  assert.deepEqual(arrivalRange(day, '7'), { from: day, to: '2027-01-04' })
  assert.deepEqual(arrivalRange('2028-02-23', '7'), {
    from: '2028-02-23',
    to: '2028-03-01',
  })
  assert.deepEqual(
    sample.filter((i) => matchesArrivalWindow(i, day, '7')).map((i) => i.id),
    ['晚风险', '明日', '今日', '其他采购'],
  )
  assert.deepEqual(
    sample.filter((i) => matchesArrivalWindow(i, day, '14')).map((i) => i.id),
    ['晚风险', '明日', '今日', '八日', '十四日', '其他采购'],
  )
  assert.equal(
    sample.filter((i) => matchesArrivalWindow(i, day, 'all')).length,
    sample.length,
  )
})

test('personal list orders by current arrival date before risk and required date and switches today/7/14 without counting arrived items', () => {
  personal(sample.filter((i) => i.ownerId === 'buyer1'))
  assert.equal(names()[0], '过期')
  selected('采购筛选', '7')
  assert.deepEqual(names(), ['今日', '明日', '晚风险'])
  assert.ok(screen.getByText(/2026-12-28 至 2027-01-04/))
  selected('采购筛选', 'today')
  assert.deepEqual(names(), ['今日'])
  selected('采购筛选', '14')
  assert.deepEqual(names(), ['今日', '明日', '晚风险', '八日', '十四日'])
  selected('采购筛选', 'completed')
  assert.deepEqual(names(), ['已到货'])
})

test('personal arrival selection and search reset paging while search spans the complete selected window', () => {
  personal(
    Array.from({ length: 31 }, (_, n) =>
      item('件' + String(n).padStart(2, '0'), n === 30 ? 0 : 7),
    ),
  )
  fireEvent.click(
    within(screen.getByRole('navigation', { name: '采购清单分页' })).getByRole(
      'button',
      { name: '末页' },
    ),
  )
  assert.equal(names().length, 6)
  selected('采购筛选', '7')
  assert.equal(names().length, 25)
  assert.equal(names()[0], '件30')
  assert.match(
    screen.getByRole('navigation', { name: '采购清单分页' }).textContent,
    /第1\/2页/,
  )
  selected('搜索我的采购件', '件29')
  assert.deepEqual(names(), ['件29'])
  assert.equal(screen.queryByRole('navigation', { name: '采购清单分页' }), null)
  fireEvent.click(screen.getByRole('button', { name: '重置筛选' }))
  assert.equal(screen.getByLabelText('采购筛选').value, 'all')
  assert.equal(names().length, 25)
})

test('manager combines exact owner identity, arrival, status and query; clear purchase conditions retains status/query and readonly drilldown', () => {
  const opened = []
  board(sample, { onOpen: (...args) => opened.push(args) })
  const owners = screen.getByLabelText('采购责任人筛选')
  assert.match(owners.textContent, /one@example.invalid/)
  assert.match(owners.textContent, /two@example.invalid/)
  selected('采购到货范围', '7')
  selected('采购责任人筛选', 'buyer1')
  assert.deepEqual(taskNames(), ['今日', '明日', '晚风险'])
  const counts = document.querySelector('.npi-module-counts')
  assert.match(counts.textContent, /风险 1/)
  assert.match(counts.textContent, /已完成 0/)
  selected('业务任务状态', 'risk')
  assert.deepEqual(taskNames(), ['晚风险'])
  selected('业务任务搜索', '晚风险')
  fireEvent.click(screen.getByRole('button', { name: '清除采购条件' }))
  assert.equal(screen.getByLabelText('业务任务状态').value, 'risk')
  assert.equal(screen.getByLabelText('业务任务搜索').value, '晚风险')
  assert.equal(owners.value, 'all')
  assert.equal(screen.getByLabelText('采购到货范围').value, 'all')
  fireEvent.click(screen.getByRole('button', { name: '查看采购物料 ↗' }))
  assert.deepEqual(opened, [['project', 'kit', '晚风险']])
  assert.equal(screen.queryByRole('button', { name: '确认完成' }), null)
  selected('业务任务搜索', '')
  selected('业务任务状态', 'all')
  selected('采购责任人筛选', 'buyer2')
  selected('采购到货范围', 'today')
  assert.deepEqual(taskNames(), ['其他采购'])
  fireEvent.click(screen.getByLabelText('仅本人负责'))
  assert.deepEqual(taskNames(), [])
})

test('manager window changes reset the page and current payload refresh removes newly completed items', () => {
  const items = Array.from({ length: 30 }, (_, n) =>
    item('件' + String(n).padStart(2, '0'), n === 29 ? 0 : 7),
  )
  const props = {
    dashboard: {
      projects: [
        {
          id: 'project',
          name: '新品电机',
          code: 'P-1',
          currentNpiStage: 'manufacturing',
          items,
        },
      ],
      todayActivity: { day },
    },
    actor: { id: 'manager', role: 'supervisor' },
    mode: 'purchasing',
    onOpen: () => {},
    onReply: () => {},
    onComplete: () => {},
  }
  const view = render(h(NpiPreparationBoard, props))
  fireEvent.click(
    within(screen.getByRole('navigation', { name: '业务任务分页' })).getByRole(
      'button',
      { name: '末页' },
    ),
  )
  assert.equal(taskNames().length, 5)
  selected('采购到货范围', 'today')
  assert.deepEqual(taskNames(), ['件29'])
  assert.equal(screen.queryByRole('navigation', { name: '业务任务分页' }), null)
  view.rerender(
    h(NpiPreparationBoard, {
      ...props,
      dashboard: {
        ...props.dashboard,
        projects: [
          {
            ...props.dashboard.projects[0],
            items: items.map((i) => ({
              ...i,
              actualCompleteDate: day,
              status: 'completed',
            })),
          },
        ],
      },
    }),
  )
  assert.deepEqual(taskNames(), [])
  assert.equal(screen.getByLabelText('采购到货范围').value, 'today')
})

test('manufacturing node board retains node/risk behavior without purchase filters', () => {
  board(
    [
      item('制造节点', 7, {
        sourceType: 'MANUFACTURING',
        trackingType: 'drawing',
        ownerId: 'maker',
      }),
    ],
    { mode: 'manufacturing' },
  )
  assert.equal(screen.queryByLabelText('采购责任人筛选'), null)
  assert.equal(screen.queryByLabelText('采购到货范围'), null)
  assert.ok(screen.getByLabelText('制造节点筛选'))
  assert.deepEqual(taskNames(), ['制造节点'])
  assert.ok(screen.getByRole('button', { name: '查看制造准备 ↗' }))
})
