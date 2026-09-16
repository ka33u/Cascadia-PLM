// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Boxes,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Database,
  Factory,
  FileSpreadsheet,
  FolderKanban,
  History,
  LayoutDashboard,
  Plus,
  RefreshCw,
  ShoppingCart,
  SlidersHorizontal,
  Upload,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/Tabs'
import { profileFields } from '../../lib/npi/project-profile'
import {
  bomReferenceLabel,
  trackingIdentity,
} from '../../lib/npi/tracking-reference'
import { defaultTemplate } from '../../lib/npi/bom'
import { stages } from '../../lib/npi/domain'
import { NpiBomDrafts } from './NpiBomDrafts'
import { NpiImportTemplateEditor } from './NpiImportTemplateEditor'
import { NpiMotherConfirmation } from './NpiMotherConfirmation'
import { NpiIssues } from './NpiIssues'
import { NpiBottleneck, bottleneckLabel } from './NpiBottleneck'
import { predictionNote } from './prediction-note'
import { NpiFiles } from './NpiFiles'
import { useNpiFileOperation } from './useNpiFileOperation'
import { NpiSettings } from './NpiSettings'
import { moduleInfo, navigationFor } from './navigation'
import {
  NpiPreparationBoard,
  NpiProjectLibrary,
  NpiReports,
} from './NpiModuleViews'
import { NpiProjectOverview, dateGap } from './NpiProjectOverview'
import { NpiKitMaterials } from './NpiKitMaterials'
import { NpiProcurementWorkbench } from './NpiProcurementWorkbench'
import { NpiProcurementReplyDialog } from './NpiProcurementReplyDialog'
import { NpiTrackingHistory } from './NpiTrackingHistory'
import { NpiExternalMaterial } from './NpiExternalMaterial'
import { NpiPagination, usePagination } from './NpiPagination'
import { NpiManufacturingReply } from './NpiManufacturingReply'
import { NpiManufacturingReplyDialog } from './NpiManufacturingReplyDialog'
import { NpiManufacturingCompletionDialog } from './NpiManufacturingCompletionDialog'
import { NpiProjectHistory } from './NpiProjectHistory'
import { NpiManufacturingException } from './NpiManufacturingException'
import { NpiProjectDashboard } from './NpiProjectDashboard'
import { NpiProjectChange } from './NpiProjectChange'
import { NpiProjectInheritance } from './NpiProjectInheritance'
import type { ModuleId } from './navigation'
import type { TemplateDraft } from './NpiImportTemplateEditor'
import type { MotherInput } from './NpiMotherConfirmation'
import type { BomDraft } from '../../lib/npi/bom-draft-service'
import type {
  NpiDashboard,
  NpiMetadata,
  NpiReconciliation,
  NpiTracking,
  ProjectDetail,
} from '../../lib/npi/service'
import type { BomDifference, BomPreview, BomRow } from '../../lib/npi/bom'
import type { FormEvent, ReactNode } from 'react'
import './npi.css'

const moduleIcons = {
  dashboard: LayoutDashboard,
  projects: FolderKanban,
  bom: FileSpreadsheet,
  manufacturing: Factory,
  purchasing: ShoppingCart,
  procurement: ShoppingCart,
  reports: BarChart3,
  data: Database,
  settings: SlidersHorizontal,
}

const statusNames: Record<string, string> = {
  pending_reply: '待回复',
  normal: '正常',
  risk: '风险',
  overdue: '逾期',
  completed: '完成',
}
const stageNames: Record<string, string> = {
  design: '设计中',
  manufacturing: '制造准备',
  prototype: '样机制作',
  test: '样机试验',
  completed: '完成',
}
const roleNames: Record<string, string> = {
  admin: '管理员',
  technical: '技术负责人',
  manufacturing: '制造负责人',
  procurement: '采购',
  supervisor: '主管',
}
const sourceNames: Record<string, string> = {
  MANUFACTURING: '制造节点',
  ERP_BOM: 'ERP BOM',
  EXTERNAL: 'BOM外物料',
}
type Field = {
  key: string
  label: string
  type?: string
  value?: string | number | boolean
  options?: Array<{ value: string; label: string }>
  required?: boolean
  maxLength?: number
  inputMode?: 'text' | 'decimal' | 'numeric'
}
type Modal = {
  title: string
  help?: string
  path: string
  method?: string
  fields: Array<Field>
  fixed?: Record<string, unknown>
  transform?: (data: Record<string, unknown>) => Record<string, unknown>
}
const Badge = ({ status }: { status: string }) => (
  <span className={`npi-badge npi-${status}`}>
    {statusNames[status] || status}
  </span>
)
const DateText = ({ value }: { value?: string | null }) => (
  <span className={value ? 'npi-date' : 'npi-muted'}>{value || '—'}</span>
)
const businessToday = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
const emptyBomRows: Array<BomRow> = []
const emptyValidation: BomPreview['validation'] = []

const compactBomQuery = '(max-width: 760px)'
const subscribeCompactBom = (notify: () => void) => {
  const media = window.matchMedia(compactBomQuery)
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}
const compactBomSnapshot = () => window.matchMedia(compactBomQuery).matches
const desktopBomSnapshot = () => false

export function NpiWorkspace() {
  const compactBom = useSyncExternalStore(
    subscribeCompactBom,
    compactBomSnapshot,
    desktopBomSnapshot,
  )

  const [meta, setMeta] = useState<NpiMetadata | null>(null),
    [dashboard, setDashboard] = useState<NpiDashboard | null>(null)
  const [purchases, setPurchases] = useState<Array<NpiTracking>>([]),
    [project, setProject] = useState<ProjectDetail | null>(null)
  const [view, setView] = useState<ModuleId | 'project'>('dashboard'),
    [returnView, setReturnView] = useState<ModuleId>('projects'),
    [search, setSearch] = useState(''),
    [tab, setTab] = useState('overview')
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false)
  const [templateEditor, setTemplateEditor] = useState<TemplateDraft | null>(
    null,
  )
  const [exceptionOpen, setExceptionOpen] = useState(false)
  const [manufacturingReplyOpen, setManufacturingReplyOpen] = useState(false)
  const [manufacturingCompletionOpen, setManufacturingCompletionOpen] =
    useState(false)
  const projectRequest = useRef(0)
  const bomRequest = useRef(0)
  const [bomLoading, setBomLoading] = useState<string | null>(null)
  const [externalOpen, setExternalOpen] = useState(false)
  const [modal, setModal] = useState<Modal | null>(null),
    [modalError, setModalError] = useState('')
  const [reconciliation, setReconciliation] =
    useState<NpiReconciliation | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [bom, setBom] = useState<Array<BomRow>>([]),
    [bomVersion, setBomVersion] = useState(''),
    [bomMode, setBomMode] = useState('auto')
  const [preview, setPreview] = useState<
      | (BomPreview & {
          previewToken: string | null
          sourceName?: string
          draftId?: string
        })
      | null
    >(null),
    [uploadFile, setUploadFile] = useState<File | null>(null),
    [templateId, setTemplateId] = useState('')
  const [bomConfirmation, setBomConfirmation] = useState(false)
  const [completedImport, setCompletedImport] = useState('')
  const [draftRevision, setDraftRevision] = useState(0)
  const [procurementReply, setProcurementReply] = useState<{
    item: NpiTracking
    complete: boolean
  } | null>(null)
  const [fileItem, setFileItem] = useState<NpiTracking | null>(null)
  const fileOperation = useNpiFileOperation(fileItem?.id || null)
  const [historyItem, setHistoryItem] = useState<NpiTracking | null>(null),
    [diff, setDiff] = useState<Array<BomDifference> | null>(null)
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null)
  const [navigationRevision, setNavigationRevision] = useState(0)
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [navigationRevision])
  const focusedItem = project?.items.find((i) => i.id === focusedItemId)
  useEffect(() => {
    if (!focusedItemId || view !== 'project') return
    const frame = requestAnimationFrame(() => {
      document
        .querySelector(`[data-npi-item="${focusedItemId}"]`)
        ?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusedItemId, view, tab])
  const bomMap = useMemo(() => new Map(bom.map((r) => [r.id, r])), [bom])
  const parentIds = useMemo(
    () => new Set(bom.map((r) => r.parentId).filter(Boolean)),
    [bom],
  )
  const trackingByBom = useMemo(
    () =>
      new Map(
        (project?.items || [])
          .filter((i) => i.bomItemId)
          .map((i) => [i.bomItemId, i]),
      ),
    [project?.items],
  )
  const effectiveBomMode =
    bomMode === 'auto'
      ? compactBom && !search.trim()
        ? 'abnormal'
        : 'all'
      : bomMode
  const visibleBom = useMemo(
    () =>
      bom.filter((r) => {
        if (!search.trim() && effectiveBomMode === 'all') {
          let parent = r.parentId
          while (parent) {
            if (collapsed.has(parent)) return false
            parent = bomMap.get(parent)?.parentId || null
          }
        }
        const t = trackingByBom.get(r.id)
        return (
          `${r.materialCode} ${r.materialName}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()) &&
          (effectiveBomMode === 'all' ||
            (effectiveBomMode === 'first' && r.level === 1) ||
            (effectiveBomMode === 'tracking' && t?.trackingEnabled) ||
            (effectiveBomMode === 'suggested' &&
              r.suggestedTracking &&
              !(t?.trackingEnabled || t?.affectsKit)) ||
            (effectiveBomMode === 'untracked' &&
              !(t?.trackingEnabled || t?.affectsKit)) ||
            (effectiveBomMode === 'abnormal' &&
              t &&
              (t.trackingEnabled || t.affectsKit) &&
              ['pending_reply', 'risk', 'overdue'].includes(t.status)))
        )
      }),
    [bom, search, collapsed, bomMap, effectiveBomMode, trackingByBom],
  )
  const bomPageStart = useRef<HTMLDivElement>(null)
  const previewPageStart = useRef<HTMLDivElement>(null)
  const validationPageStart = useRef<HTMLDetailsElement>(null)
  const bomPage = usePagination(visibleBom, 100, bomPageStart)
  const previewPage = usePagination(
    preview?.previewRows || emptyBomRows,
    100,
    previewPageStart,
  )
  const validationPage = usePagination(
    preview?.validation || emptyValidation,
    100,
    validationPageStart,
  )
  const actorId = useRef<string | null>(null),
    pending = useRef(false),
    projectId = useRef<string | null>(null)
  const api = useCallback(
    async <T,>(path: string, method = 'GET', data?: unknown): Promise<T> => {
      const headers: Record<string, string> = {}
      if (method !== 'GET') {
        headers['X-NPI-Actor'] = actorId.current || ''
        if (!(data instanceof FormData))
          headers['Content-Type'] = 'application/json'
      }
      const response = await fetch(`/api/v1/npi${path}`, {
        method,
        headers,
        body:
          data === undefined
            ? undefined
            : data instanceof FormData
              ? data
              : JSON.stringify(data),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok)
        throw Object.assign(
          new Error(
            body?.error ||
              (response.status >= 500
                ? '提交结果待核对，请刷新确认，勿重复提交'
                : '请求失败'),
          ),
          { status: response.status },
        )
      if (!body) throw new Error('未收到有效结果，请刷新核对')
      return body as T
    },
    [],
  )
  const refresh = useCallback(
    async (configurationOnly = false) => {
      const refreshRevision = projectRequest.current
      let currentProjectRead: (() => boolean) | undefined
      setLoading(true)
      setError('')
      try {
        const next = await api<NpiMetadata>('/meta')
        if (actorId.current && actorId.current !== next.actor.id)
          throw new Error('登录账号已改变，请整页刷新并核对未保存内容')
        const firstLoad = !actorId.current
        actorId.current = next.actor.id
        if (firstLoad && next.actor.role === 'manufacturing')
          setView('manufacturing')
        setMeta(next)
        const loadProjects = !configurationOnly || next.actor.role !== 'admin'
        if (next.actor.role === 'procurement') {
          const result = await api<{ items: Array<NpiTracking> }>(
            '/workbench/procurement',
          )
          setPurchases(result.items)
          setView('procurement')
        } else if (loadProjects)
          setDashboard(await api<NpiDashboard>('/dashboard'))
        if (loadProjects && projectId.current) {
          const id = projectId.current,
            revision = projectRequest.current
          currentProjectRead = () =>
            projectId.current === id && projectRequest.current === revision
          const [nextProject, nextReconciliation] = await Promise.all([
            api<ProjectDetail>(`/projects/${id}`),
            api<NpiReconciliation>(`/projects/${id}/bom/reconciliation`),
          ])
          if (currentProjectRead()) {
            setProject(nextProject)
            setReconciliation(nextReconciliation)
          }
        }
      } catch (e) {
        if (!currentProjectRead || currentProjectRead())
          setError(e instanceof Error ? e.message : '读取失败')
      } finally {
        if (refreshRevision === projectRequest.current) setLoading(false)
      }
    },
    [api],
  )
  useEffect(() => {
    void refresh()
  }, [refresh])
  const openProject = async (
    id: string,
    itemId?: string,
    initialTab = 'overview',
    manufacturingAction: 'reply' | 'complete' | null = null,
  ) => {
    const request = ++projectRequest.current
    setBomLoading(null)
    setLoading(true)
    setError('')
    try {
      const p = await api<ProjectDetail>(`/projects/${id}`)
      const bomData =
        initialTab === 'bom'
          ? await Promise.all([
              api<{ rows: Array<BomRow> }>(
                `/projects/${id}/bom/tree${p.activeBomImportId ? `?importId=${p.activeBomImportId}` : ''}`,
              ),
              api<NpiReconciliation>(`/projects/${id}/bom/reconciliation`),
            ])
          : null
      if (request !== projectRequest.current) return
      if (view !== 'project') setReturnView(view)
      projectId.current = id
      setProject(p)
      setReconciliation(bomData?.[1] || null)
      setDiff(null)
      setPreview(null)
      setBomConfirmation(false)
      setCompletedImport('')
      setUploadFile(null)
      setBom(bomData?.[0].rows || [])
      setCollapsed(new Set())
      setBomMode('auto')
      setBomVersion(p.activeBomImportId || '')
      const target = p.items.find((i) => i.id === itemId)
      if (!target) setNavigationRevision((n) => n + 1)
      setFocusedItemId(target?.id || null)
      setTab(
        target
          ? target.sourceType === 'MANUFACTURING'
            ? 'manufacturing'
            : 'kit'
          : initialTab,
      )
      if (itemId && !target) setNotice('目标物料已变化，请在项目中核对最新记录')
      setSearch('')
      setView('project')
      setManufacturingCompletionOpen(
        manufacturingAction === 'complete' &&
          p.currentNpiStage !== 'completed' &&
          (meta?.actor.role === 'admin' ||
            (['technical', 'manufacturing'].includes(meta?.actor.role || '') &&
              meta?.actor.id === p.manufacturingOwnerId)),
      )
      setManufacturingReplyOpen(
        manufacturingAction === 'reply' &&
          p.currentNpiStage !== 'completed' &&
          (meta?.actor.role === 'admin' ||
            (['technical', 'manufacturing'].includes(meta?.actor.role || '') &&
              meta?.actor.id === p.manufacturingOwnerId)),
      )
    } catch (e) {
      if (request === projectRequest.current) setError(String(e))
    } finally {
      if (request === projectRequest.current) setLoading(false)
    }
  }
  const openModal = (m: Modal) => {
    setModalError('')
    setModal(m)
  }
  const people = (roles?: Array<string>) =>
    (meta?.users ?? [])
      .filter(
        (u) =>
          !roles ||
          roles.includes(u.role || '') ||
          (u.id === meta?.actor.id && meta.actor.role === 'admin'),
      )
      .map((u) => ({
        value: u.id,
        label: `${u.name || u.email} · ${roleNames[u.role || ''] || '管理员'}`,
      }))
  const selectOwner = (
    key = 'ownerId',
    label = '回复责任人',
    roles?: Array<string>,
    value?: string,
  ): Field => ({
    key,
    label,
    type: 'select',
    options: people(roles),
    value,
    required: true,
  })
  const showCreate = () =>
    openModal({
      title: '新建新品项目',
      help: '名称、型号、负责人和要求日期必填；客户、电机参数和说明可以稍后补充。',
      path: '/projects',
      fields: [
        { key: 'name', label: '新品名称', required: true },
        { key: 'motorModel', label: '电机型号', required: true },
        { key: 'code', label: '项目编号（留空自动生成）' },
        selectOwner(
          'technicalOwnerId',
          '技术负责人',
          ['technical'],
          meta?.actor.role === 'technical' ? meta.actor.id : undefined,
        ),
        selectOwner('manufacturingOwnerId', '制造负责人', ['manufacturing']),
        {
          key: 'requiredKitDate',
          label: '要求齐套日期',
          type: 'date',
          required: true,
        },
        {
          key: 'prototypeRequiredDate',
          label: '样机要求日期',
          type: 'date',
          required: true,
        },
        ...profileFields.map((field) => ({
          key: field.key,
          label: field.label,
          type: field.kind === 'textarea' ? 'textarea' : 'text',
          maxLength: field.max,
          inputMode:
            field.kind === 'decimal'
              ? ('decimal' as const)
              : field.kind === 'integer'
                ? ('numeric' as const)
                : ('text' as const),
        })),
      ],
    })
  const showExternal = () => setExternalOpen(true)
  const showPromise = (item: NpiTracking) =>
    meta?.actor.role === 'procurement'
      ? setProcurementReply({ item, complete: false })
      : openModal({
          title: item.currentCommittedDate ? '修改承诺日期' : '回复承诺日期',
          help: `${trackingIdentity(item)} · 要求 ${item.requiredDate} · 首次承诺 ${item.firstCommittedDate || '尚未回复'}`,
          path: `/tracking/${item.id}/promise`,
          fixed: { expectedVersion: item.version },
          fields: [
            {
              key: 'committedDate',
              label: '当前承诺日期',
              type: 'date',
              value: item.currentCommittedDate || item.requiredDate,
              required: true,
            },
            {
              key: 'reason',
              label: item.currentCommittedDate
                ? '变更原因（必填）'
                : '回复说明',
              type: 'textarea',
              required: !!item.currentCommittedDate,
            },
            { key: 'supplier', label: '供应商', value: item.supplier },
            {
              key: 'remark',
              label: '备注',
              value: item.remark,
              type: 'textarea',
            },
          ],
        })
  const showComplete = (item: NpiTracking) =>
    meta?.actor.role === 'procurement'
      ? setProcurementReply({ item, complete: true })
      : openModal({
          title: item.trackingType === 'purchase' ? '确认到货' : '确认完成',
          help: trackingIdentity(item),
          path: `/tracking/${item.id}/complete`,
          fixed: { expectedVersion: item.version },
          fields: [
            {
              key: 'actualCompleteDate',
              label: '实际完成日期',
              type: 'date',
              value: businessToday(),
              required: true,
            },
            {
              key: 'remark',
              label: '验收或完成说明',
              type: 'textarea',
              value: item.remark,
            },
          ],
        })
  const showPlanAdjustment = (item: NpiTracking) =>
    openModal({
      title: '调整物料计划',
      help: `${trackingIdentity(item)} · 历史承诺保持不变；交接后待办和资料访问转交新责任人。`,
      path: `/tracking/${item.id}/plan`,
      method: 'PATCH',
      fixed: { expectedVersion: item.version },
      fields: [
        ...(item.sourceType === 'MANUFACTURING'
          ? []
          : [
              selectOwner(
                'ownerId',
                '回复责任人',
                item.trackingType === 'purchase'
                  ? ['procurement']
                  : ['technical', 'manufacturing'],
                item.ownerId,
              ),
            ]),
        {
          key: 'requiredDate',
          label: '调整后的要求日期',
          type: 'date',
          value: item.requiredDate,
          required: true,
        },
        { key: 'reason', label: '调整原因', type: 'textarea', required: true },
      ],
    })
  const showCompletionCorrection = (item: NpiTracking) =>
    openModal({
      title: '更正实际完成日期',
      help: `${trackingIdentity(item)} · 原日期 ${item.actualCompleteDate}。更正保留原始记录，不撤销完成状态。`,
      path: `/tracking/${item.id}/completion-correction`,
      fixed: { expectedVersion: item.version },
      fields: [
        {
          key: 'actualCompleteDate',
          label: '更正后的实际完成日期',
          type: 'date',
          value: item.actualCompleteDate || '',
          required: true,
        },
        { key: 'reason', label: '更正原因', type: 'textarea', required: true },
      ],
    })
  const showTracking = (row: BomRow) => {
    if (!project) return
    const existing = project.items.find((i) => i.bomItemId === row.id)
    openModal({
      title: existing ? '调整物料跟踪' : '设为重点跟踪',
      help: `${row.materialCode} · ${row.materialName}${row.trackingSuggestion?.reasons.length ? ' · 建议依据：' + row.trackingSuggestion.reasons.join('；') : ''}。由负责人确认责任人、要求日期和齐套影响后保存。`,
      path: `/bom-items/${row.id}/tracking`,
      method: 'PATCH',
      fixed: { expectedVersion: existing?.version ?? 0 },
      fields: [
        selectOwner(
          'ownerId',
          '回复责任人',
          ['procurement', 'manufacturing', 'technical'],
          existing?.ownerId || project.manufacturingOwnerId,
        ),
        {
          key: 'requiredDate',
          label: '要求日期',
          type: 'date',
          value: existing?.requiredDate || project.requiredKitDate,
          required: true,
        },
        {
          key: 'trackingEnabled',
          label: '重点跟踪',
          type: 'checkbox',
          value: existing?.trackingEnabled ?? true,
        },
        {
          key: 'affectsKit',
          label: '影响齐套',
          type: 'checkbox',
          value: existing?.affectsKit ?? true,
        },
        {
          key: 'reason',
          label: '调整原因（取消跟踪或齐套影响时必填）',
          type: 'textarea',
        },
      ],
    })
  }
  const showReconciliation = (
    row: NpiReconciliation['items'][number],
    action: 'migrate' | 'retire',
  ) => {
    if (!project || !reconciliation) return
    openModal({
      title: action === 'migrate' ? '关联新版BOM物料' : '停止旧版物料跟踪',
      help:
        action === 'migrate'
          ? '核对位置、数量和规格。关联后保留原责任人、要求日期及全部承诺，采用新版物料信息。数量变化后请责任人再次核对承诺。'
          : '停止后不再参与待回复、风险统计和齐套预测。原物料、承诺与本次复核原因继续保留。',
      path: `/projects/${project.id}/bom/reconciliation`,
      fixed: {
        action,
        trackingItemId: row.item.id,
        expectedVersion: row.item.version,
        expectedProjectVersion: reconciliation.projectVersion,
        activeImportId: reconciliation.activeImportId,
      },
      fields: [
        ...(action === 'migrate'
          ? [
              {
                key: 'targetBomItemId',
                label: '新版位置 / 数量 / 规格',
                type: 'select',
                required: true,
                value: row.suggestedId || '',
                options: [
                  { value: '', label: '请选择已核对的位置' },
                  ...row.candidates
                    .filter((c) => !c.occupied)
                    .map((c) => ({
                      value: c.id,
                      label: `${c.path} · ${c.qty} ${c.unit} · ${c.specification || '无规格'}`,
                    })),
                ],
              },
            ]
          : []),
        {
          key: 'reason',
          label: '换版复核原因',
          type: 'textarea',
          required: true,
        },
      ],
    })
  }
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!modal || pending.current) return
    pending.current = true
    setBusy(true)
    setModalError('')
    const fd = new FormData(e.currentTarget)
    let data: Record<string, unknown> = { ...modal.fixed }
    for (const f of modal.fields)
      data[f.key] = f.type === 'checkbox' ? fd.has(f.key) : fd.get(f.key)
    try {
      if (modal.transform) data = modal.transform(data)
      await api(modal.path, modal.method || 'POST', data)
      setNotice('已保存')
      await refresh(modal.path === '/roles')
      setModal(null)
    } catch (submitError) {
      setModalError(
        submitError instanceof Error
          ? submitError.message
          : '提交失败，填写内容已保留',
      )
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const projectScope = (id: string) => {
    const revision = projectRequest.current
    return () => projectId.current === id && projectRequest.current === revision
  }
  const reloadManufacturingPlan = async () => {
    if (!project) throw new Error('请先打开项目')
    const current = projectScope(project.id)
    const [nextProject, nextMeta] = await Promise.all([
      api<ProjectDetail>(`/projects/${project.id}`),
      api<NpiMetadata>('/meta'),
    ])
    if (nextMeta.actor.id !== actorId.current)
      throw new Error('登录账号已改变，请整页刷新核对。')
    if (!current()) throw new Error('项目已改变，请返回后重新打开。')
    setMeta(nextMeta)
    setProject(nextProject)
    return nextProject
  }
  const refreshManufacturingReply = async () => {
    if (!project) throw new Error('请先打开项目')
    const current = projectScope(project.id)
    const [nextProject, nextDashboard, nextMeta] = await Promise.all([
      api<ProjectDetail>(`/projects/${project.id}`),
      api<NpiDashboard>('/dashboard'),
      api<NpiMetadata>('/meta'),
    ])
    if (nextMeta.actor.id !== actorId.current)
      throw new Error('登录账号已改变，请整页刷新核对。')
    if (!current()) throw new Error('项目已改变，请返回后重新打开。')
    setMeta(nextMeta)
    setProject(nextProject)
    setDashboard(nextDashboard)
    setNotice('制造承诺已保存，齐套预测和任务状态已更新')
  }
  const loadBom = async (id: string) => {
    if (!project) return
    const inProject = projectScope(project.id),
      request = ++bomRequest.current
    const current = () => inProject() && request === bomRequest.current
    setError('')
    setBomLoading(id)
    setDiff(null)
    try {
      const [result, review] = await Promise.all([
        api<{ rows: Array<BomRow> }>(
          `/projects/${project.id}/bom/tree${id ? `?importId=${id}` : ''}`,
        ),
        api<NpiReconciliation>(`/projects/${project.id}/bom/reconciliation`),
      ])
      if (!current()) return
      setReconciliation(review)
      setBom(result.rows)
      setCollapsed(new Set())
      setBomVersion(id)
    } catch (e) {
      if (current()) setError(String(e))
    } finally {
      if (current()) setBomLoading(null)
    }
  }
  const parseUpload = async () => {
    if (!project || !uploadFile || pending.current) return
    const current = projectScope(project.id)
    pending.current = true
    setBusy(true)
    setError('')
    setPreview(null)
    setBomConfirmation(false)
    setCompletedImport('')
    try {
      const form = new FormData()
      form.set('file', uploadFile)
      if (templateId) form.set('templateId', templateId)
      const result = await api<NonNullable<typeof preview>>(
        `/projects/${project.id}/bom/import-preview`,
        'POST',
        form,
      )
      if (current()) setPreview(result)
    } catch (e) {
      if (current()) setError(String(e))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const confirmPreviewMother = async (input: MotherInput) => {
    if (!project || !preview || pending.current)
      throw new Error('请等待当前操作完成')
    const current = projectScope(project.id)
    pending.current = true
    setBusy(true)
    try {
      let result: NonNullable<typeof preview>
      if (preview.draftId) {
        result = await api(
          `/projects/${project.id}/bom/drafts/${preview.draftId}/resume`,
          'POST',
          { templateId: preview.templateId, motherConfirmation: input },
        )
      } else {
        if (!uploadFile) throw new Error('请重新选择原始Excel文件')
        const form = new FormData()
        form.set('file', uploadFile)
        form.set('templateId', preview.templateId)
        form.set('motherConfirmation', JSON.stringify(input))
        result = await api(
          `/projects/${project.id}/bom/import-preview`,
          'POST',
          form,
        )
      }
      if (current()) {
        setPreview(result)
        setBomConfirmation(false)
      }
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const saveDraft = async () => {
    if (!project || !preview?.previewToken || pending.current) return
    const current = projectScope(project.id)
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await api(`/projects/${project.id}/bom/drafts`, 'POST', {
        previewToken: preview.previewToken,
      })
      setNotice(
        `「${project.name}」BOM草稿已保存，可从“我的BOM草稿”恢复；尚未生成正式版本`,
      )
      if (current()) {
        setPreview(null)
        setUploadFile(null)
        setBomConfirmation(false)
        setDraftRevision((n) => n + 1)
      }
    } catch (e) {
      setError(`「${project.name}」草稿保存未完成：${String(e)}`)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const draftAction = async (draft: BomDraft, action: 'resume' | 'discard') => {
    if (!project || pending.current) return
    const current = projectScope(project.id)
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api<NonNullable<typeof preview>>(
        `/projects/${project.id}/bom/drafts/${draft.id}/${action}`,
        'POST',
        action === 'resume' ? { templateId: templateId || undefined } : {},
      )
      if (action === 'discard') setNotice(`「${project.name}」草稿已移除`)
      if (!current()) return
      if (action === 'resume') {
        setPreview(result)
        setUploadFile(null)
        setBomConfirmation(false)
        setCompletedImport('')
        setNotice(
          '已从原始Excel重新解析草稿，请核对当前模板和校验结果后确认导入',
        )
      } else if (preview?.draftId === draft.id) {
        setPreview(null)
        setBomConfirmation(false)
      }
      setDraftRevision((n) => n + 1)
    } catch (e) {
      if (current() || action === 'discard')
        setError(`「${project.name}」草稿操作未完成：${String(e)}`)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const importPreview = async () => {
    if (!project || !preview?.previewToken || pending.current) return
    const current = projectScope(project.id)
    pending.current = true
    setBusy(true)
    setError('')
    let imported = false
    try {
      const result = await api<{ importId: string }>(
        `/projects/${project.id}/bom/import`,
        'POST',
        { previewToken: preview.previewToken, activate: true },
      )
      imported = true
      setNotice(`「${project.name}」BOM新版本已保存，旧版及原有承诺继续保留`)
      if (current()) {
        setPreview(null)
        setUploadFile(null)
      }
      await refresh()
      if (!current()) return
      await loadBom(result.importId)
      if (!current()) return
      setCompletedImport(result.importId)
      setDraftRevision((n) => n + 1)
      setBomConfirmation(false)
    } catch (e) {
      setError(
        `「${project.name}」${imported ? 'BOM已保存，但页面读取失败，请刷新核对' : '导入结果待核对，请刷新项目确认'}：${String(e)}`,
      )
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const showTemplate = (template?: TemplateDraft) =>
    setTemplateEditor(
      template || {
        config: {
          ...defaultTemplate,
          id: `erp-${crypto.randomUUID()}`,
          name: '新ERP模板',
        },
        version: 0,
        enabled: true,
      },
    )
  const canManage =
    meta?.actor.role === 'admin' ||
    (!!project &&
      [project.technicalOwnerId, project.manufacturingOwnerId].includes(
        meta?.actor.id || '',
      ) &&
      ['technical', 'manufacturing'].includes(meta?.actor.role || ''))
  const canAdjustPlan = canManage || meta?.actor.role === 'supervisor'
  const canReply = (i: NpiTracking) =>
    (i.trackingEnabled || i.affectsKit) &&
    !i.actualCompleteDate &&
    project?.currentNpiStage !== 'completed' &&
    (meta?.actor.role === 'admin' ||
      (i.ownerId === meta?.actor.id &&
        (i.trackingType === 'purchase'
          ? meta.actor.role === 'procurement'
          : ['technical', 'manufacturing'].includes(meta.actor.role))))
  const trackingTable = (items: Array<NpiTracking>) => (
    <div className="npi-table-scroll">
      <table className="npi-table npi-tracking-table">
        <thead>
          <tr>
            <th>物料 / 节点</th>
            <th>回复责任人</th>
            <th>要求日期</th>
            <th>首次承诺</th>
            <th>当前承诺</th>
            <th>实际完成</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr
              key={i.id}
              data-npi-item={i.id}
              className={
                focusedItemId === i.id ? 'npi-focused-item' : undefined
              }
            >
              <td data-label="物料 / 节点">
                <strong>{i.name}</strong>
                {view === 'project' &&
                  project &&
                  bottleneckLabel(project.kit, i.id) && (
                    <span
                      className="npi-badge npi-pending_reply"
                      aria-label="齐套瓶颈标记"
                    >
                      {bottleneckLabel(project.kit, i.id)}
                    </span>
                  )}
                {i.bomReference && (
                  <>
                    <small>物料编码：{i.bomReference.materialCode}</small>
                    <small>{bomReferenceLabel(i.bomReference)}</small>
                  </>
                )}
                <small>
                  {[i.projectCode, i.projectName, sourceNames[i.sourceType]]
                    .filter(Boolean)
                    .join(' · ')}
                  {i.affectsKit ? ' · 影响齐套' : ''}
                  {i.trackingEnabled ? ' · 重点' : ''}
                </small>
                <small>{i.specification}</small>
                {i.sourceType !== 'MANUFACTURING' && (
                  <small>
                    {i.sourceType === 'ERP_BOM' ? 'BOM基本用量：' : '数量：'}
                    {i.qty.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}{' '}
                    {i.unit}
                  </small>
                )}
              </td>
              <td data-label="回复责任人">{i.ownerName || meta?.actor.name}</td>
              <td data-label="要求日期">
                <DateText value={i.requiredDate} />
              </td>
              <td data-label="首次承诺">
                <DateText value={i.firstCommittedDate} />
              </td>
              <td data-label="当前承诺">
                <DateText value={i.currentCommittedDate} />
                {i.currentCommittedDate && (
                  <small
                    className={
                      dateGap(i.currentCommittedDate, i.requiredDate)! > 0
                        ? 'npi-warning-text'
                        : ''
                    }
                  >
                    {dateGap(i.currentCommittedDate, i.requiredDate)! > 0
                      ? `较要求晚 ${dateGap(i.currentCommittedDate, i.requiredDate)} 天`
                      : dateGap(i.currentCommittedDate, i.requiredDate)! < 0
                        ? `较要求早 ${-dateGap(i.currentCommittedDate, i.requiredDate)!} 天`
                        : '与要求同日'}
                  </small>
                )}
                <small>
                  {typeof i.changeCount === 'number'
                    ? `改期 ${i.changeCount} 次`
                    : ''}
                </small>
              </td>
              <td data-label="实际完成">
                <DateText value={i.actualCompleteDate} />
              </td>
              <td data-label="状态">
                <Badge status={i.status} />
              </td>
              <td data-label="操作">
                <div className="npi-row-actions">
                  <button
                    aria-label={`${i.name}附件资料`}
                    onClick={() => setFileItem(i)}
                  >
                    附件
                  </button>
                  {canReply(i) && (
                    <>
                      <button onClick={() => showPromise(i)}>
                        {i.currentCommittedDate ? '改期' : '回复'}
                      </button>
                      <button onClick={() => showComplete(i)}>
                        {i.trackingType === 'purchase' ? '到货' : '完成'}
                      </button>
                    </>
                  )}
                  {project &&
                    canAdjustPlan &&
                    project.currentNpiStage !== 'completed' &&
                    (i.trackingEnabled || i.affectsKit) &&
                    (i.actualCompleteDate ? (
                      canManage && (
                        <button onClick={() => showCompletionCorrection(i)}>
                          更正日期
                        </button>
                      )
                    ) : (
                      <button onClick={() => showPlanAdjustment(i)}>
                        调整计划
                      </button>
                    ))}
                  {(project || view === 'procurement') && (
                    <button
                      aria-label={`${i.name}承诺历史`}
                      onClick={() => setHistoryItem(i)}
                    >
                      <History size={16} />
                      历史
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <Empty
          title="当前没有符合条件的事项"
          detail="添加重点物料或调整筛选后，这里会显示要求、承诺与实际日期。"
        />
      )}
    </div>
  )
  const navigate = (next: ModuleId) => {
    projectRequest.current++
    setBomLoading(null)
    setLoading(false)
    setManufacturingReplyOpen(false)
    setManufacturingCompletionOpen(false)
    setNavigationRevision((n) => n + 1)
    setView(next)
    setFocusedItemId(null)
    setSearch('')
    setProject(null)
    projectId.current = null
    setError('')
  }
  return (
    <div className="npi-app">
      <aside className="npi-sidebar">
        <a href="/npi" className="npi-brand">
          <span>
            <Boxes size={26} />
          </span>
          <div>
            CASCADIA<small>新品制造协同</small>
          </div>
        </a>
        <div className="npi-nav-label">NPI 工作空间</div>
        <nav aria-label="主导航">
          {(meta ? navigationFor(meta.actor.role) : []).map((id) => {
            const Icon = moduleIcons[id]
            const active = (view === 'project' ? returnView : view) === id
            return (
              <button
                key={id}
                className={active ? 'active' : ''}
                aria-current={active ? 'page' : undefined}
                onClick={() => navigate(id)}
              >
                <Icon size={19} />
                {moduleInfo[id].label}
              </button>
            )
          })}
        </nav>
        <div className="npi-sidebar-bottom">
          <span>制造统筹 · 承诺可追溯</span>
          <a href="/">
            Cascadia 系统管理 <ChevronRight size={15} />
          </a>
          <div className="npi-person">
            <span>{meta?.actor.name.slice(0, 1) || 'C'}</span>
            <div>
              {meta?.actor.name || '正在连接'}
              <small>{roleNames[meta?.actor.role || '']}</small>
            </div>
          </div>
        </div>
      </aside>
      <main className="npi-main">
        <header className="npi-topbar">
          <span>
            工作空间 <ChevronRight size={14} />{' '}
            {view === 'project' ? (
              <>
                {moduleInfo[returnView].label} <ChevronRight size={14} />{' '}
                {project?.name}
              </>
            ) : (
              moduleInfo[view].label
            )}
          </span>
          <button
            className="npi-button secondary"
            disabled={loading}
            onClick={() => void refresh(view === 'settings' || view === 'data')}
          >
            <RefreshCw size={16} className={loading ? 'npi-spin' : ''} />
            刷新
          </button>
        </header>
        <div className="npi-content">
          {error && (
            <div role="alert" className="npi-message error">
              <AlertTriangle size={18} />
              {error}
              <a href="/login?redirect=%2Fnpi">重新登录</a>
            </div>
          )}
          {notice && (
            <div role="status" className="npi-message success">
              <CheckCircle2 size={18} />
              {notice}
              <button onClick={() => setNotice('')}>关闭</button>
            </div>
          )}
          {!meta && (
            <Empty
              title={loading ? '正在读取新品工作空间…' : '暂时无法读取工作空间'}
              detail="请使用管理员已分配NPI岗位的账号登录。"
            />
          )}
          {meta &&
            view !== 'project' &&
            view !== 'settings' &&
            view !== 'data' && (
              <div className="npi-heading">
                <div>
                  <div className="npi-eyebrow">NEW PRODUCT INTRODUCTION</div>
                  <h1>{moduleInfo[view].title}</h1>
                  <p>{moduleInfo[view].description}</p>
                </div>
                {['admin', 'technical'].includes(meta.actor.role) &&
                  ['dashboard', 'projects', 'bom'].includes(view) && (
                    <button className="npi-button" onClick={showCreate}>
                      <Plus size={18} />
                      新建新品
                    </button>
                  )}
              </div>
            )}
          {meta &&
            !dashboard &&
            !['project', 'data', 'settings', 'procurement'].includes(view) &&
            loading && (
              <p role="status" className="npi-module-empty">
                正在读取业务数据…
              </p>
            )}
          {meta && view === 'dashboard' && dashboard && (
            <NpiProjectDashboard
              key={view}
              dashboard={dashboard}
              actor={meta.actor}
              view={view}
              onOpen={(id, itemId) => void openProject(id, itemId)}
              onCreate={showCreate}
            />
          )}
          {meta && dashboard && (view === 'projects' || view === 'bom') && (
            <NpiProjectLibrary
              key={view}
              dashboard={dashboard}
              mode={view}
              onOpen={(id, nextTab, itemId) =>
                void openProject(id, itemId, nextTab)
              }
            />
          )}
          {meta &&
            dashboard &&
            (view === 'manufacturing' || view === 'purchasing') && (
              <NpiPreparationBoard
                key={view}
                dashboard={dashboard}
                actor={meta.actor}
                users={meta.users}
                mode={view}
                onComplete={(id) =>
                  void openProject(id, undefined, 'manufacturing', 'complete')
                }
                onReply={(id) =>
                  void openProject(id, undefined, 'manufacturing', 'reply')
                }
                onOpen={(id, nextTab, itemId) =>
                  void openProject(id, itemId, nextTab)
                }
              />
            )}
          {meta && dashboard && view === 'reports' && (
            <NpiReports
              dashboard={dashboard}
              onOpen={(id, nextTab, itemId) =>
                void openProject(id, itemId, nextTab)
              }
            />
          )}
          {view === 'procurement' && (
            <NpiProcurementWorkbench
              items={purchases}
              today={businessToday()}
              renderTable={trackingTable}
            />
          )}
          {view === 'procurement' && meta && (
            <NpiIssues api={api} meta={meta} onChanged={refresh} />
          )}
          {view === 'project' && project && (
            <>
              <button className="npi-back" onClick={() => navigate(returnView)}>
                <ArrowLeft size={16} />
                返回{moduleInfo[returnView].label}
              </button>
              <div className="npi-project-summary">
                <div className="npi-heading">
                  <div>
                    <div className="npi-eyebrow">{project.code}</div>
                    <h1>
                      {project.name} <Badge status={project.riskStatus} />
                    </h1>
                    <p>
                      {project.motorModel} · 样机要求{' '}
                      {project.prototypeRequiredDate}
                    </p>
                    {meta?.actor.role === 'supervisor' &&
                      project.currentNpiStage !== 'completed' && (
                        <p className="npi-muted">
                          主管可调整项目及物料计划，修改须说明原因。承诺回复与完成确认由责任人办理。
                        </p>
                      )}
                  </div>
                  {meta &&
                    project.currentNpiStage !== 'completed' &&
                    (['admin', 'supervisor'].includes(meta.actor.role) ||
                      (meta.actor.role === 'technical' &&
                        meta.actor.id === project.technicalOwnerId)) && (
                      <NpiProjectChange
                        api={api}
                        meta={meta}
                        project={project}
                        onChanged={async (canContinue) => {
                          if (!canContinue) navigate('dashboard')
                          setNotice('项目变更已保存')
                          await refresh()
                        }}
                      />
                    )}
                  {meta &&
                    (meta.actor.role === 'admin' ||
                      (meta.actor.role === 'technical' &&
                        meta.actor.id === project.technicalOwnerId)) && (
                      <NpiProjectInheritance
                        api={api}
                        meta={meta}
                        project={project}
                        onCreated={async (id, canContinue) => {
                          setNotice(
                            '已从相似项目新建，请核对BOM及物料要求日期并安排负责人回复',
                          )
                          await refresh()
                          if (canContinue) await openProject(id)
                          else navigate('dashboard')
                        }}
                      />
                    )}
                  {canManage && project.currentNpiStage !== 'completed' && (
                    <button
                      className="npi-button secondary"
                      onClick={() => {
                        const next =
                          stages[stages.indexOf(project.currentNpiStage) + 1]
                        openModal({
                          title: `推进至${stageNames[next!]}`,
                          help:
                            next === 'completed' &&
                            project.items.some(
                              (i) =>
                                (i.affectsKit ||
                                  i.sourceType === 'MANUFACTURING') &&
                                !i.actualCompleteDate,
                            )
                              ? `以下项目尚未完成，请先确认：${project.items
                                  .filter(
                                    (i) =>
                                      (i.affectsKit ||
                                        i.sourceType === 'MANUFACTURING') &&
                                      !i.actualCompleteDate,
                                  )
                                  .map((i) => i.name)
                                  .join('、')}`
                              : '阶段推进会留下操作记录。项目完成前需确认制造节点和关键物料全部完成。',
                          path: `/projects/${project.id}/stage`,
                          method: 'PATCH',
                          fixed: {
                            expectedVersion: project.version,
                            currentNpiStage: next,
                          },
                          fields:
                            next === 'manufacturing'
                              ? [
                                  {
                                    key: 'drawingCompleteDate',
                                    label: '图纸实际完成日期',
                                    type: 'date',
                                    value: businessToday(),
                                    required: true,
                                  },
                                ]
                              : [],
                        })
                      }}
                    >
                      推进阶段 <ChevronRight size={16} />
                    </button>
                  )}
                </div>
                <dl className="npi-project-facts">
                  {[
                    [
                      '技术负责人',
                      meta?.users.find((u) => u.id === project.technicalOwnerId)
                        ?.name || '未命名',
                    ],
                    [
                      '制造负责人',
                      meta?.users.find(
                        (u) => u.id === project.manufacturingOwnerId,
                      )?.name || '未命名',
                    ],
                    ['当前阶段', stageNames[project.currentNpiStage]],
                    ['要求齐套', project.requiredKitDate],
                    [
                      '制造承诺齐套',
                      project.kit.manufacturingCommittedKitDate || '待回复',
                    ],
                    [
                      '系统预测齐套',
                      project.kit.predictedKitDate ||
                        (project.kit.allRelevantCompleted
                          ? '已齐备'
                          : '待回复'),
                    ],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>
                        {value}
                        {label === '系统预测齐套' &&
                          !project.kit.predictionComplete && (
                            <small
                              className="npi-warning-text"
                              style={{
                                display: 'block',
                                marginTop: 4,
                                fontWeight: 400,
                              }}
                            >
                              {predictionNote(project.kit)}
                            </small>
                          )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
              {tab === 'overview' && (
                <div className="npi-timeline">
                  {stages.map((s, i) => (
                    <div
                      key={s}
                      className={
                        i <= stages.indexOf(project.currentNpiStage)
                          ? 'reached'
                          : ''
                      }
                    >
                      <span>{i + 1}</span>
                      {stageNames[s]}
                    </div>
                  ))}
                </div>
              )}
              {focusedItem && (
                <div
                  className="npi-message"
                  role="status"
                  aria-label="事项定位"
                >
                  <span>
                    已定位：{focusedItem.name} · {focusedItem.ownerName}。
                    {!focusedItem.trackingEnabled && !focusedItem.affectsKit
                      ? '此项已停止跟踪，保留历史记录。'
                      : ''}
                  </span>
                  <button
                    className="npi-button secondary"
                    onClick={() => setFocusedItemId(null)}
                  >
                    取消定位
                  </button>
                </div>
              )}
              <Tabs
                value={tab}
                onValueChange={(v) => {
                  setTab(v)
                  if (v === 'bom')
                    void loadBom(bomVersion || project.activeBomImportId || '')
                }}
              >
                <TabsList className="npi-tabs">
                  <TabsTrigger value="overview">概览</TabsTrigger>
                  <TabsTrigger value="manufacturing">制造准备</TabsTrigger>
                  <TabsTrigger value="kit">样机齐套</TabsTrigger>
                  <TabsTrigger value="bom">ERP BOM</TabsTrigger>
                  <TabsTrigger value="issues">
                    项目问题{' '}
                    {project.openIssueCount
                      ? `(${project.openIssueCount})`
                      : ''}
                  </TabsTrigger>
                  <TabsTrigger value="files">项目资料</TabsTrigger>
                  <TabsTrigger value="history">承诺与动态</TabsTrigger>
                </TabsList>
                <TabsContent value="overview">
                  {meta && (
                    <NpiProjectOverview
                      key={project.id}
                      project={project}
                      meta={meta}
                      api={api}
                      onLocate={(id, type) => {
                        setFocusedItemId(id)
                        setTab(
                          type === 'manufacturing_node'
                            ? 'manufacturing'
                            : 'kit',
                        )
                      }}
                      onTab={(next) => {
                        setTab(next)
                        if (next === 'bom')
                          void loadBom(
                            bomVersion || project.activeBomImportId || '',
                          )
                      }}
                    />
                  )}
                </TabsContent>
                <TabsContent value="kit">
                  <div className="npi-kit-dates">
                    <DateCard
                      label="要求齐套"
                      value={project.requiredKitDate}
                      icon={<CalendarClock size={20} />}
                    />
                    <DateCard
                      label="制造承诺齐套"
                      value={project.kit.manufacturingCommittedKitDate}
                      emptyLabel={
                        project.currentNpiStage === 'completed' ||
                        project.items.some(
                          (i) =>
                            i.trackingType === 'kit' && i.actualCompleteDate,
                        )
                          ? '未记录承诺'
                          : '待回复'
                      }
                      icon={<Factory size={20} />}
                    />
                    <DateCard
                      label="系统预测齐套"
                      value={project.kit.predictedKitDate}
                      emptyLabel={
                        project.kit.allRelevantCompleted &&
                        project.kit.predictionComplete
                          ? '已完成，无需预测'
                          : '待回复'
                      }
                      icon={<Boxes size={20} />}
                      note={
                        predictionNote(project.kit) ||
                        (project.kit.allRelevantCompleted
                          ? '相关物料与准备节点均已完成'
                          : '根据关键物料、工艺和工装承诺计算')
                      }
                    />
                  </div>
                  {project.kit.alerts.map((a) => (
                    <div key={a.code} className="npi-alert">
                      <AlertTriangle size={18} />
                      {a.message}
                    </div>
                  ))}
                  <NpiBottleneck
                    kit={project.kit}
                    onLocate={(id, type) => {
                      setFocusedItemId(id)
                      setTab(
                        type === 'manufacturing_node' ? 'manufacturing' : 'kit',
                      )
                    }}
                  />
                  <NpiKitMaterials
                    key={project.id}
                    project={project}
                    focusedItemId={focusedItemId}
                    onClearFocus={() => setFocusedItemId(null)}
                    canManage={canManage}
                    onExternal={showExternal}
                    onBom={(mode = 'all') => {
                      setFocusedItemId(null)
                      setTab('bom')
                      setBomMode(mode)
                      setSearch('')
                      void loadBom(project.activeBomImportId || '')
                    }}
                    renderTable={trackingTable}
                  />
                  <NpiManufacturingReply
                    key={project.id}
                    project={project}
                    api={api}
                    onSaved={refreshManufacturingReply}
                    onReload={reloadManufacturingPlan}
                    onException={() => setExceptionOpen(true)}
                    readOnly={
                      project.currentNpiStage === 'completed' ||
                      !(
                        meta?.actor.role === 'admin' ||
                        (['technical', 'manufacturing'].includes(
                          meta?.actor.role || '',
                        ) &&
                          meta?.actor.id === project.manufacturingOwnerId)
                      )
                    }
                  />
                </TabsContent>
                <TabsContent value="manufacturing">
                  <section className="npi-panel">
                    <div className="npi-panel-title">
                      <div>
                        <h2>制造准备四节点</h2>
                        <p>制造负责人集中回复；工艺与工装参与齐套预测。</p>
                      </div>
                      {(meta?.actor.role === 'admin' ||
                        (['technical', 'manufacturing'].includes(
                          meta?.actor.role || '',
                        ) &&
                          meta?.actor.id === project.manufacturingOwnerId)) &&
                        project.currentNpiStage !== 'completed' && (
                          <div className="npi-actions">
                            <button
                              className="npi-button secondary"
                              onClick={() => setExceptionOpen(true)}
                            >
                              添加异常件
                            </button>
                            <button
                              className="npi-button"
                              onClick={() => setManufacturingReplyOpen(true)}
                            >
                              集中回复
                            </button>
                            {project.items.some(
                              (i) =>
                                i.sourceType === 'MANUFACTURING' &&
                                !i.actualCompleteDate,
                            ) && (
                              <button
                                className="npi-button secondary"
                                onClick={() =>
                                  setManufacturingCompletionOpen(true)
                                }
                              >
                                集中确认完成
                              </button>
                            )}
                          </div>
                        )}
                    </div>
                    {trackingTable(
                      project.items.filter(
                        (i) => i.sourceType === 'MANUFACTURING',
                      ),
                    )}
                  </section>
                  <section className="npi-panel" aria-label="制造异常物料">
                    <div className="npi-panel-title">
                      <div>
                        <h2>制造异常物料</h2>
                        <p>
                          待回复、风险和逾期的制造物料；正常项可在样机齐套查看。
                        </p>
                      </div>
                    </div>
                    {trackingTable(
                      project.items.filter(
                        (i) =>
                          i.sourceType === 'ERP_BOM' &&
                          i.ownerId === project.manufacturingOwnerId &&
                          (i.trackingEnabled || i.affectsKit) &&
                          ['pending_reply', 'risk', 'overdue'].includes(
                            i.status,
                          ),
                      ),
                    )}
                  </section>
                  <section className="npi-panel">
                    <div className="npi-panel-title">
                      <h2>制造承诺历史</h2>
                      <button
                        className="npi-project-link"
                        onClick={() => setTab('history')}
                      >
                        全部承诺与动态 ↗
                      </button>
                    </div>
                    {project.history
                      .filter((h) =>
                        project.items.some(
                          (i) =>
                            i.id === h.objectId &&
                            i.sourceType === 'MANUFACTURING',
                        ),
                      )
                      .slice(-6)
                      .reverse()
                      .map((h) => (
                        <div className="npi-history" key={h.id}>
                          <History size={17} />
                          <div>
                            <strong>
                              {
                                project.items.find((i) => i.id === h.objectId)
                                  ?.name
                              }{' '}
                              · {h.oldCommittedDate || '首次回复'} →{' '}
                              {h.newCommittedDate}
                            </strong>
                            <p>{h.reason}</p>
                            <small>
                              {h.actorName} ·{' '}
                              {new Date(h.changedAt).toLocaleString('zh-CN', {
                                timeZone: 'Asia/Shanghai',
                              })}
                            </small>
                          </div>
                        </div>
                      ))}
                    {!project.history.some((h) =>
                      project.items.some(
                        (i) =>
                          i.id === h.objectId &&
                          i.sourceType === 'MANUFACTURING',
                      ),
                    ) && (
                      <p className="npi-list-summary">
                        暂无制造承诺记录，回复后自动形成时间线。
                      </p>
                    )}
                  </section>
                </TabsContent>
                <TabsContent value="bom">
                  <section className="npi-panel">
                    <ol className="npi-import-steps" aria-label="BOM导入步骤">
                      {['上传文件', '数据预览', '解析确认', '导入完成'].map(
                        (label, index) => {
                          const step = completedImport
                            ? 3
                            : preview
                              ? bomConfirmation
                                ? 2
                                : 1
                              : 0
                          return (
                            <li
                              key={label}
                              className={index <= step ? 'reached' : ''}
                              aria-current={index === step ? 'step' : undefined}
                            >
                              <span>{index + 1}</span>
                              {label}
                            </li>
                          )
                        },
                      )}
                    </ol>
                    {completedImport && (
                      <div className="npi-import-success" role="status">
                        <CheckCircle2 size={20} />
                        <div>
                          <strong>BOM新版本导入完成</strong>
                          <p>
                            原始Excel和历史版本已保留，可继续设置重点跟踪物料。
                          </p>
                        </div>
                      </div>
                    )}
                    <div className="npi-panel-title">
                      <h2>ERP 多阶BOM</h2>
                      <select
                        aria-label="BOM版本"
                        value={bomLoading ?? bomVersion}
                        disabled={busy}
                        onChange={(e) => void loadBom(e.target.value)}
                      >
                        {!project.imports.length && (
                          <option value="">尚未导入</option>
                        )}
                        {project.imports.map((i) => (
                          <option value={i.id} key={i.id}>
                            V{i.versionNo} · {i.rowCount}项{' '}
                            {i.id === project.activeBomImportId
                              ? '（当前）'
                              : '（历史）'}
                          </option>
                        ))}
                      </select>
                    </div>
                    {['admin', 'technical'].includes(meta?.actor.role || '') &&
                      project.currentNpiStage !== 'completed' && (
                        <div className="npi-upload">
                          <FileSpreadsheet size={28} />
                          <div>
                            <strong>导入ERP导出的原始Excel</strong>
                            <p>
                              上传 → 解析预览 →
                              确认新版本；不覆盖旧BOM及承诺历史。
                            </p>
                            <input
                              type="file"
                              aria-label="上传ERP BOM"
                              disabled={busy}
                              accept=".xlsx"
                              onChange={(e) => {
                                setUploadFile(e.target.files?.[0] || null)
                                setPreview(null)
                                setBomConfirmation(false)
                                setCompletedImport('')
                              }}
                            />
                            <select
                              aria-label="导入模板"
                              disabled={busy}
                              value={templateId}
                              onChange={(e) => {
                                setTemplateId(e.target.value)
                                setPreview(null)
                                setBomConfirmation(false)
                                setCompletedImport('')
                              }}
                            >
                              <option value="">自动识别模板</option>
                              {meta?.templates
                                .filter((t) => t.enabled)
                                .map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.name}
                                  </option>
                                ))}
                            </select>
                          </div>
                          <button
                            className="npi-button"
                            disabled={!uploadFile || busy}
                            onClick={() => void parseUpload()}
                          >
                            <Upload size={16} />
                            {busy ? '处理中…' : '解析预览'}
                          </button>
                        </div>
                      )}
                    {['admin', 'technical'].includes(meta?.actor.role || '') &&
                      project.currentNpiStage !== 'completed' && (
                        <NpiBomDrafts
                          api={api}
                          projectId={project.id}
                          revision={draftRevision}
                          busy={busy}
                          onResume={(draft) => draftAction(draft, 'resume')}
                          onDiscard={(draft) => draftAction(draft, 'discard')}
                        />
                      )}
                    {reconciliation && reconciliation.items.length > 0 && (
                      <div
                        className="npi-preview"
                        data-testid="bom-reconciliation"
                      >
                        <h3>
                          BOM换版待复核 · {reconciliation.items.length} 项
                        </h3>
                        <p>
                          旧跟踪和承诺仍有效。请技术负责人核对新版位置及数量后关联；已移除的物料可说明原因后停止跟踪。
                        </p>
                        {reconciliation.items.map((r) => (
                          <div className="npi-review-item" key={r.item.id}>
                            <strong>
                              {r.oldRow.materialName} · {r.oldRow.materialCode}
                            </strong>
                            <p>
                              原位置：{r.oldPath} · 原数量 {r.item.qty}{' '}
                              {r.item.unit}
                            </p>
                            <p>
                              {r.suggestedId
                                ? `建议关联：${r.candidates.find((c) => c.id === r.suggestedId)?.path}`
                                : r.candidates.length
                                  ? '存在多个位置或目标已跟踪，请人工核对'
                                  : '当前版本已无此编码'}
                            </p>
                            <div className="npi-actions">
                              {['admin', 'technical'].includes(
                                meta?.actor.role || '',
                              ) &&
                                project.currentNpiStage !== 'completed' && (
                                  <>
                                    <button
                                      className="npi-button secondary"
                                      disabled={
                                        busy ||
                                        !r.candidates.some((c) => !c.occupied)
                                      }
                                      onClick={() =>
                                        showReconciliation(r, 'migrate')
                                      }
                                    >
                                      关联新版
                                    </button>
                                    <button
                                      className="npi-button secondary"
                                      disabled={busy}
                                      onClick={() =>
                                        showReconciliation(r, 'retire')
                                      }
                                    >
                                      停止旧跟踪
                                    </button>
                                  </>
                                )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {preview && (
                      <div className="npi-preview">
                        <h3>
                          {bomConfirmation ? '解析确认' : '数据预览'} ·{' '}
                          {preview.mother.code}
                        </h3>
                        <div className="npi-import-metadata">
                          <span>
                            文件：{preview.sourceName || uploadFile?.name}
                          </span>
                          <span>工作表：{preview.sheetName}</span>
                          <span>
                            模板：
                            {preview.templateSnapshot?.name ||
                              preview.templateId}
                          </span>
                          <span>上传人：{meta?.actor.name}</span>
                          <span>
                            母件规格：{preview.mother.spec || '未提供'}
                          </span>
                        </div>
                        {bomConfirmation && (
                          <div className="npi-import-success">
                            <CheckCircle2 size={18} />
                            <span>
                              请核对母件、数量与校验信息。确认后生成新版本，旧BOM与承诺记录继续保留。
                            </span>
                          </div>
                        )}
                        <p>
                          {preview.mother.name} · {preview.summary.rows} 项 ·
                          最大 {preview.summary.maxLevel} 级 · 一级{' '}
                          {preview.summary.level1Count} 项 · 错误{' '}
                          {preview.summary.errors} · 警告{' '}
                          {preview.summary.warnings}
                        </p>
                        <NpiMotherConfirmation
                          preview={preview}
                          busy={busy}
                          onConfirm={confirmPreviewMother}
                        />
                        <details ref={validationPageStart}>
                          <summary>
                            查看校验信息（{preview.validation.length}）
                          </summary>
                          {validationPage.items.map((v, i) => (
                            <p
                              key={i}
                              className={
                                v.severity === 'ERROR' ? 'npi-error-text' : ''
                              }
                            >
                              第{v.rowNo}行 · {v.severity} · {v.message}
                            </p>
                          ))}
                          <NpiPagination
                            label="校验信息分页"
                            {...validationPage}
                            disabled={busy}
                          />
                        </details>
                        <div
                          className="npi-preview-scroll"
                          ref={previewPageStart}
                        >
                          <table className="npi-table" aria-label="BOM导入预览">
                            <thead>
                              <tr>
                                <th>层级</th>
                                <th>物料编码</th>
                                <th>名称</th>
                                <th>规格</th>
                                <th>数量</th>
                                <th>供应类型</th>
                                <th>跟踪建议</th>
                                <th>领料部门</th>
                                <th>仓库</th>
                              </tr>
                            </thead>
                            <tbody>
                              {previewPage.items.map((r) => (
                                <tr key={r.id}>
                                  <td>{r.level}</td>
                                  <td>{r.materialCode}</td>
                                  <td>{r.materialName}</td>
                                  <td>{r.specification}</td>
                                  <td>
                                    {r.qty} {r.unit}
                                  </td>
                                  <td>{r.supplyType}</td>
                                  <td>
                                    {r.trackingSuggestion?.reasons.join('；') ||
                                      (r.suggestedTracking
                                        ? '历史建议，需人工复核'
                                        : '由负责人判断')}
                                  </td>
                                  <td>{r.issueDepartment}</td>
                                  <td>{r.warehouse}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <NpiPagination
                          label="导入预览分页"
                          {...previewPage}
                          disabled={busy}
                        />
                        <div className="npi-actions">
                          {bomConfirmation && (
                            <button
                              className="npi-button secondary"
                              disabled={busy}
                              onClick={() => setBomConfirmation(false)}
                            >
                              上一步：数据预览
                            </button>
                          )}
                          <button
                            className="npi-button secondary"
                            disabled={busy}
                            onClick={() => {
                              setPreview(null)
                              setBomConfirmation(false)
                            }}
                          >
                            取消预览
                          </button>
                          <button
                            className="npi-button secondary"
                            disabled={
                              busy ||
                              !preview.previewToken ||
                              !!preview.summary.errors
                            }
                            onClick={() => void saveDraft()}
                          >
                            保存为草稿
                          </button>
                          <button
                            className="npi-button"
                            disabled={
                              !preview.previewToken ||
                              !!preview.summary.errors ||
                              busy
                            }
                            onClick={() =>
                              bomConfirmation
                                ? void importPreview()
                                : setBomConfirmation(true)
                            }
                          >
                            {bomConfirmation
                              ? '确认导入为新版本'
                              : '下一步：解析确认'}
                          </button>
                        </div>
                      </div>
                    )}
                    {bomLoading !== null && (
                      <p role="status" className="npi-list-summary">
                        正在读取所选BOM版本…
                      </p>
                    )}
                    <div hidden={bomLoading !== null} aria-label="BOM版本内容">
                      <p className="npi-muted">
                        跟踪建议依据模板映射的物料属性生成，确认前不计入待回复或齐套。没有属性时请人工判断，采购类型和仓库名称不代表新规格或长周期。任意层级均可手动设为重点。
                      </p>
                      <div className="npi-panel-title">
                        <div className="npi-filters">
                          {[
                            ['all', '完整BOM'],
                            ['first', '只看一级'],
                            ['untracked', '未跟踪'],
                            ['suggested', '建议待确认'],
                            ['tracking', '重点跟踪'],
                            ['abnormal', '异常物料'],
                          ].map(([k, label]) => (
                            <button
                              key={k}
                              className={effectiveBomMode === k ? 'active' : ''}
                              aria-pressed={effectiveBomMode === k}
                              onClick={() => setBomMode(k!)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <input
                          aria-label="搜索BOM"
                          type="search"
                          placeholder="搜索编码 / 名称"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </div>
                      {compactBom && bomMode === 'auto' && (
                        <p className="npi-bom-hint" role="status">
                          {search.trim()
                            ? `正在搜索全部BOM，共${visibleBom.length}项结果；清空后返回异常物料。`
                            : '手机默认显示异常物料；搜索可查全部BOM，也可点击“完整BOM”展开。'}
                        </p>
                      )}
                      <NpiPagination
                        label="BOM明细顶部翻页"
                        {...bomPage}
                        disabled={loading || busy}
                      />
                      <div className="npi-table-scroll" ref={bomPageStart}>
                        <table
                          className="npi-table npi-tracking-table npi-bom-table"
                          aria-label="完整BOM明细"
                        >
                          <thead>
                            <tr>
                              <th>层级 / 物料名称</th>
                              <th>物料编码</th>
                              <th>规格</th>
                              <th>数量</th>
                              <th>供应 / 部门</th>
                              <th>仓库</th>
                              <th>状态 / 责任人</th>
                              <th>跟踪</th>
                            </tr>
                          </thead>
                          <tbody>
                            {bomPage.items.map((r) => {
                              const t = trackingByBom.get(r.id)
                              return (
                                <tr key={r.id}>
                                  <td data-label="层级 / 物料名称">
                                    <div
                                      className="npi-tree-name"
                                      style={{
                                        paddingLeft: compactBom
                                          ? 0
                                          : Math.min(r.level - 1, 10) * 18,
                                      }}
                                    >
                                      {parentIds.has(r.id) ? (
                                        <button
                                          className="npi-tree-toggle"
                                          aria-label={`${collapsed.has(r.id) ? '展开' : '收起'}${r.materialName}`}
                                          aria-expanded={!collapsed.has(r.id)}
                                          onClick={() =>
                                            setCollapsed((previous) => {
                                              const next = new Set(previous)
                                              if (next.has(r.id))
                                                next.delete(r.id)
                                              else next.add(r.id)
                                              return next
                                            })
                                          }
                                        >
                                          {collapsed.has(r.id) ? '▸' : '▾'}
                                        </button>
                                      ) : (
                                        <span>└</span>
                                      )}
                                      <span>{r.level}级</span>
                                      <strong>{r.materialName}</strong>
                                    </div>
                                    {r.parentId && (
                                      <small className="npi-bom-parent">
                                        上级：
                                        {bomMap.get(r.parentId)?.materialName ||
                                          '—'}{' '}
                                        ·{' '}
                                        {bomMap.get(r.parentId)?.materialCode ||
                                          '—'}
                                      </small>
                                    )}
                                  </td>
                                  <td data-label="物料编码">
                                    <span className="npi-bom-value">
                                      {r.materialCode}
                                    </span>
                                  </td>
                                  <td data-label="规格">
                                    <span className="npi-bom-value">
                                      {r.specification || '—'}
                                    </span>
                                  </td>
                                  <td data-label="数量">
                                    <span className="npi-bom-value">
                                      {r.qty} {r.unit}
                                    </span>
                                  </td>
                                  <td data-label="供应 / 部门">
                                    <div className="npi-bom-value">
                                      {r.supplyType || '—'}
                                      <small>{r.issueDepartment || '—'}</small>
                                    </div>
                                  </td>
                                  <td data-label="仓库">
                                    <span className="npi-bom-value">
                                      {r.warehouse || '—'}
                                    </span>
                                  </td>
                                  <td data-label="状态 / 责任人">
                                    <div className="npi-bom-value">
                                      {t &&
                                      (t.trackingEnabled || t.affectsKit) ? (
                                        <>
                                          <Badge status={t.status} />
                                          <small>{t.ownerName}</small>
                                        </>
                                      ) : (
                                        <span className="npi-muted">
                                          未跟踪
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td data-label="跟踪">
                                    {r.suggestedTracking && (
                                      <small className="npi-muted">
                                        {r.trackingSuggestion?.reasons.join(
                                          '；',
                                        ) || '历史建议，需人工复核'}
                                      </small>
                                    )}

                                    {canManage &&
                                    project.currentNpiStage !== 'completed' &&
                                    (t ||
                                      bomVersion ===
                                        project.activeBomImportId) ? (
                                      <button
                                        className="npi-link"
                                        onClick={() => showTracking(r)}
                                      >
                                        {t
                                          ? t.trackingEnabled
                                            ? '重点跟踪 ✓'
                                            : '调整跟踪'
                                          : r.suggestedTracking
                                            ? '建议跟踪 +'
                                            : '设为重点 +'}
                                      </button>
                                    ) : t ? (
                                      '已跟踪'
                                    ) : (
                                      '—'
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                        {!visibleBom.length && (
                          <Empty
                            title={
                              bom.length
                                ? compactBom &&
                                  bomMode === 'auto' &&
                                  !search.trim()
                                  ? '当前没有异常BOM物料'
                                  : '没有符合筛选的BOM物料'
                                : '尚无BOM明细'
                            }
                            detail={
                              bom.length
                                ? compactBom &&
                                  bomMode === 'auto' &&
                                  !search.trim()
                                  ? '可搜索编码或名称查看任意物料，也可切换完整BOM。'
                                  : '请调整搜索或筛选条件，也可展开已收起的上级物料。'
                                : '先上传ERP多阶BOM，再从任意层级选出关键物料。'
                            }
                          />
                        )}
                      </div>
                      <NpiPagination
                        label="BOM明细分页"
                        {...bomPage}
                        disabled={loading || busy}
                      />
                      {bomVersion && (
                        <div className="npi-actions">
                          <a
                            className="npi-button secondary"
                            href={`/api/v1/npi/projects/${project.id}/bom/${bomVersion}/source`}
                          >
                            下载此版本原始Excel
                          </a>
                          {project.imports.length > 1 && (
                            <button
                              className="npi-button secondary"
                              onClick={() => {
                                const index = project.imports.findIndex(
                                  (i) => i.id === bomVersion,
                                )
                                const previous = project.imports[index + 1]
                                if (!previous) {
                                  setError('此版本没有更早版本')
                                  return
                                }
                                const inProject = projectScope(project.id),
                                  request = bomRequest.current
                                const current = () =>
                                  inProject() && request === bomRequest.current
                                void api<typeof diff>(
                                  `/projects/${project.id}/bom/diff?before=${previous.id}&after=${bomVersion}`,
                                )
                                  .then((result) => {
                                    if (current()) setDiff(result)
                                  })
                                  .catch((e) => {
                                    if (current()) setError(String(e))
                                  })
                              }}
                            >
                              与上一版本比较
                            </button>
                          )}
                        </div>
                      )}
                      {diff && (
                        <div className="npi-preview">
                          <h3>版本差异</h3>
                          {diff
                            .filter((d) => d.type !== 'UNCHANGED')
                            .map((d, i) => (
                              <p key={i}>
                                {
                                  (
                                    {
                                      ADDED: '新增',
                                      REMOVED: '移除',
                                      QTY_CHANGED: '数量变化',
                                      MOVED: '位置移动',
                                    } as Record<string, string>
                                  )[d.type]
                                }{' '}
                                · {(d.after || d.before)?.materialCode} ·{' '}
                                {d.before?.qty || '—'} → {d.after?.qty || '—'}
                                <small className="npi-diff-path">
                                  {d.beforePath || '—'} → {d.afterPath || '—'}
                                </small>
                              </p>
                            ))}
                          {diff.every((d) => d.type === 'UNCHANGED') && (
                            <p>未发现新增、移除、数量或位置变化。</p>
                          )}
                        </div>
                      )}
                    </div>
                  </section>
                </TabsContent>
                <TabsContent value="issues">
                  {meta && (
                    <NpiIssues
                      api={api}
                      meta={meta}
                      project={project}
                      onChanged={refresh}
                    />
                  )}
                </TabsContent>
                <TabsContent value="files">
                  <section className="npi-panel">
                    <NpiFiles
                      key={project.id}
                      api={api}
                      scope={{ kind: 'project', id: project.id }}
                      readOnly={project.currentNpiStage === 'completed'}
                    />
                  </section>
                </TabsContent>
                <TabsContent value="history">
                  <NpiProjectHistory
                    key={project.id}
                    project={project}
                    api={api}
                  >
                    {project.items.some(
                      (i) => !i.trackingEnabled && !i.affectsKit,
                    ) && (
                      <details>
                        <summary>已停止跟踪的历史物料</summary>
                        {trackingTable(
                          project.items.filter(
                            (i) => !i.trackingEnabled && !i.affectsKit,
                          ),
                        )}
                      </details>
                    )}
                  </NpiProjectHistory>
                </TabsContent>
              </Tabs>
            </>
          )}
          {meta?.actor.role === 'admin' &&
            (view === 'settings' || view === 'data') && (
              <NpiSettings
                key={view}
                section={view === 'data' ? 'templates' : 'users'}
                meta={meta}
                roleNames={roleNames}
                onTemplate={showTemplate}
                onRole={(u) =>
                  openModal({
                    title: `分配岗位 · ${u.name || u.email}`,
                    path: '/roles',
                    method: 'PUT',
                    fixed: { userId: u.id },
                    fields: [
                      {
                        key: 'role',
                        label: 'NPI岗位',
                        type: 'select',
                        value: u.role || 'technical',
                        options: Object.entries(roleNames).map(
                          ([value, label]) => ({ value, label }),
                        ),
                      },
                    ],
                  })
                }
              />
            )}
        </div>
      </main>
      {manufacturingCompletionOpen && project && meta && (
        <NpiManufacturingCompletionDialog
          key={project.id}
          project={project}
          actor={meta.actor}
          api={api}
          onClose={() => setManufacturingCompletionOpen(false)}
          onSaved={async () => {
            const id = project.id,
              revision = projectRequest.current
            const [nextProject, nextDashboard] = await Promise.all([
              api<ProjectDetail>(`/projects/${id}`),
              api<NpiDashboard>('/dashboard'),
            ])
            if (projectId.current !== id || projectRequest.current !== revision)
              return
            setProject(nextProject)
            setDashboard(nextDashboard)
            setNotice('制造完成记录已保存，齐套与任务状态已更新')
          }}
        />
      )}
      {manufacturingReplyOpen && project && (
        <NpiManufacturingReplyDialog
          key={project.id}
          project={project}
          api={api}
          readOnly={
            project.currentNpiStage === 'completed' ||
            !(
              meta?.actor.role === 'admin' ||
              (['technical', 'manufacturing'].includes(
                meta?.actor.role || '',
              ) &&
                meta?.actor.id === project.manufacturingOwnerId)
            )
          }
          onClose={() => setManufacturingReplyOpen(false)}
          onReload={reloadManufacturingPlan}
          onSaved={refreshManufacturingReply}
        />
      )}
      {exceptionOpen && project && meta && (
        <NpiManufacturingException
          key={`${project.id}:${meta.actor.id}`}
          projectId={project.id}
          actorId={meta.actor.id}
          api={api}
          onClose={() => setExceptionOpen(false)}
          onSaved={async (itemId) => {
            const id = project.id,
              current = projectScope(id),
              expectedActor = meta.actor.id
            const [nextProject, nextDashboard, nextMeta] = await Promise.all([
              api<ProjectDetail>(`/projects/${id}`),
              api<NpiDashboard>('/dashboard'),
              api<NpiMetadata>('/meta'),
            ])
            if (
              nextMeta.actor.id !== expectedActor ||
              actorId.current !== expectedActor
            )
              throw new Error('登录账号已改变，请整页刷新核对。')
            if (!current()) throw new Error('项目已改变，请返回后重新打开。')
            if (!nextProject.items.some((i) => i.id === itemId))
              throw new Error('最新清单尚未包含已保存物料，请重试刷新。')
            setMeta(nextMeta)
            setProject(nextProject)
            setDashboard(nextDashboard)
            setNotice('制造异常件已保存，齐套预测和任务状态已更新')
          }}
        />
      )}
      {templateEditor && (
        <NpiImportTemplateEditor
          template={templateEditor}
          api={api}
          onClose={() => setTemplateEditor(null)}
          onSaved={async () => {
            setNotice('BOM导入模板已保存')
            await refresh(true)
          }}
        />
      )}
      {externalOpen && project && meta && (
        <NpiExternalMaterial
          key={`${project.id}-${meta.actor.id}`}
          project={project}
          meta={meta}
          api={api}
          onClose={() => setExternalOpen(false)}
          onOpenFiles={setFileItem}
          onSaved={async (created) => {
            const current = projectScope(project.id)
            const [nextProject, nextDashboard, nextMeta] = await Promise.all([
              api<ProjectDetail>(`/projects/${project.id}`),
              api<NpiDashboard>('/dashboard'),
              api<NpiMetadata>('/meta'),
            ])
            if (nextMeta.actor.id !== actorId.current)
              throw new Error('登录账号已改变，请整页刷新核对。')
            if (!current()) throw new Error('项目已改变，请返回后重新打开。')
            const item = nextProject.items.find(
              (i) => i.id === created.id && i.sourceType === 'EXTERNAL',
            )
            if (!item)
              throw new Error('新增物料尚未出现在最新清单，请重试刷新。')
            setMeta(nextMeta)
            setProject(nextProject)
            setDashboard(nextDashboard)
            setNotice('BOM外物料已新增，责任人的待回复任务和齐套预测已更新')
            return item
          }}
        />
      )}
      <Dialog
        open={!!modal}
        onOpenChange={(open) => {
          if (!open && !busy) setModal(null)
        }}
      >
        <DialogContent className="npi-modal">
          <DialogTitle>{modal?.title}</DialogTitle>
          <DialogDescription style={{ overflowWrap: 'anywhere' }}>
            {modal?.help ||
              '保存后会更新记录；版本冲突时请保留输入并核对最新内容。'}
          </DialogDescription>
          {modal && (
            <form key={`${modal.path}-${modal.title}`} onSubmit={submit}>
              <div className="npi-form-grid">
                {modal.fields.map((f) => (
                  <label
                    key={f.key}
                    className={f.type === 'textarea' ? 'wide' : ''}
                  >
                    {f.type !== 'checkbox' && <span>{f.label}</span>}
                    {f.type === 'select' ? (
                      <select
                        aria-label={f.label}
                        name={f.key}
                        required={f.required}
                        defaultValue={String(f.value || '')}
                      >
                        <option value="" disabled>
                          请选择
                        </option>
                        {f.options?.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : f.type === 'textarea' ? (
                      <textarea
                        name={f.key}
                        defaultValue={String(f.value || '')}
                        required={f.required}
                        rows={f.key === 'config' ? 18 : 3}
                        maxLength={f.maxLength}
                      />
                    ) : f.type === 'checkbox' ? (
                      <span className="npi-checkbox">
                        <input
                          name={f.key}
                          type="checkbox"
                          defaultChecked={!!f.value}
                        />
                        {f.label}
                      </span>
                    ) : (
                      <input
                        name={f.key}
                        type={f.type || 'text'}
                        maxLength={f.maxLength}
                        inputMode={f.inputMode}
                        defaultValue={String(f.value ?? '')}
                        required={f.required}
                      />
                    )}
                  </label>
                ))}
              </div>
              {modalError && (
                <p role="alert" className="npi-message error">
                  {modalError}
                </p>
              )}
              <div className="npi-actions">
                <button
                  type="button"
                  className="npi-button secondary"
                  disabled={busy}
                  onClick={() => setModal(null)}
                >
                  取消
                </button>
                <button type="submit" className="npi-button" disabled={busy}>
                  {busy ? '正在保存…' : '保存'}
                </button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!fileItem}
        onOpenChange={(open) => {
          if (!open && !fileOperation.isBusy()) setFileItem(null)
        }}
      >
        <DialogContent
          className="npi-modal npi-file-operation-dialog"
          data-saving={fileOperation.busy}
          style={{ maxWidth: 780 }}
        >
          <DialogTitle>{fileItem?.name} · 附件资料</DialogTitle>
          <DialogDescription>技术文件、供应商说明和到货照片</DialogDescription>
          {fileItem && (
            <NpiFiles
              key={fileItem.id}
              api={api}
              scope={{ kind: 'tracking', id: fileItem.id }}
              readOnly={project?.currentNpiStage === 'completed'}
              buyer={meta?.actor.role === 'procurement'}
              onBusyChange={fileOperation.onBusyChange}
            />
          )}
        </DialogContent>
      </Dialog>
      {procurementReply && meta && (
        <NpiProcurementReplyDialog
          key={procurementReply.item.id + String(procurementReply.complete)}
          item={procurementReply.item}
          complete={procurementReply.complete}
          actorId={meta.actor.id}
          today={businessToday()}
          api={api}
          onClose={() => setProcurementReply(null)}
          onOpenFiles={() => {
            setFileItem(procurementReply.item)
            setProcurementReply(null)
          }}
          onSaved={async () => {
            const next = await api<{
              actorId: string
              items: Array<NpiTracking>
            }>('/workbench/procurement')
            if (next.actorId !== meta.actor.id)
              throw new Error('登录账号已改变，请整页刷新核对。')
            setPurchases(next.items)
            setError('')
            setNotice(
              procurementReply.complete
                ? '到货日期已保存，可从附件补充到货资料'
                : '采购承诺已保存',
            )
          }}
        />
      )}
      {historyItem && (
        <NpiTrackingHistory
          key={historyItem.id}
          itemId={historyItem.id}
          api={api}
          onClose={() => setHistoryItem(null)}
        />
      )}
    </div>
  )
}
function Empty({
  title,
  detail,
  action,
}: {
  title: string
  detail: string
  action?: ReactNode
}) {
  return (
    <div className="npi-empty">
      <Boxes size={34} />
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  )
}
function DateCard({
  emptyLabel = '待回复',
  label,
  value,
  icon,
  note,
}: {
  label: string
  emptyLabel?: string
  value?: string | null
  icon: ReactNode
  note?: string
}) {
  return (
    <div className="npi-date-card">
      <div>
        {label}
        {icon}
      </div>
      <strong>{value || emptyLabel}</strong>
      <small>{note || ' '}</small>
    </div>
  )
}
