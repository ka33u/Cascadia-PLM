// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  inheritProject,
  previewInheritance,
} from '../../lib/npi/project-inheritance'
import * as drafts from '../../lib/npi/bom-draft-service'
import {
  applyProjectChange,
  previewProjectChange,
} from '../../lib/npi/project-change-service'
import { validateRequestSession } from '../../lib/auth/server'
import { NpiError } from '../../lib/npi/domain'
import * as npi from '../../lib/npi/service'
import { projectEvents } from '../../lib/npi/project-events'
import * as issue from '../../lib/npi/issue-service'
import * as files from '../../lib/npi/file-service'

const app = new Hono<{ Variables: { userId: string } }>()
app.use(
  '*',
  bodyLimit({
    maxSize: 6 * 1024 * 1024,
    onError: (c) =>
      c.json({ code: 'INVALID_BOM_FORMAT', error: '请求文件过大' }, 413),
  }),
)
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('X-Content-Type-Options', 'nosniff')
  // Session-only until a distinct NPI API-key scope is defined.
  if (c.req.header('authorization'))
    return c.json(
      { code: 'AUTH_REQUIRED', error: 'NPI当前仅支持系统会话登录' },
      401,
    )
  const session = await validateRequestSession(c.req.raw)
  if (!session)
    return c.json({ code: 'AUTH_REQUIRED', error: '请先登录系统' }, 401)
  if (session.user.mustChangePassword)
    return c.json(
      { code: 'PASSWORD_CHANGE_REQUIRED', error: '请先修改初始密码' },
      403,
    )
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin')
    const allowed = new Set(
      [new URL(c.req.url).origin, process.env.BASE_URL].filter(Boolean),
    )
    if (
      !origin ||
      !allowed.has(origin) ||
      c.req.header('sec-fetch-site') === 'cross-site'
    )
      return c.json(
        { code: 'NPI_PERMISSION_DENIED', error: '请从本系统页面提交' },
        403,
      )
    if (c.req.header('x-npi-actor') !== session.user.id)
      return c.json(
        {
          code: 'ACTOR_CONTEXT_CHANGED',
          error: '当前登录账号已改变，请刷新页面后核对',
        },
        409,
      )
  }
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    !c.req.header('content-type')?.startsWith('multipart/form-data')
  ) {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json(
        { code: 'VALIDATION_ERROR', error: '请求正文必须是JSON对象' },
        422,
      )
  }
  c.set('userId', session.user.id)
  await next()
})
app.onError((error, c) => {
  if (error instanceof NpiError)
    return c.json(
      { code: error.code, error: error.message },
      error.status as 400 | 403 | 404 | 409 | 422 | 503,
    )
  if (error instanceof SyntaxError)
    return c.json({ code: 'VALIDATION_ERROR', error: '请求格式无效' }, 400)
  // PostgreSQL unique conflicts can race with the readable pre-check.
  type UniqueError = { code?: string; constraint_name?: string }
  const pg = error as Error & UniqueError & { cause?: UniqueError }
  const conflict =
    pg.code === '23505' ? pg : pg.cause?.code === '23505' ? pg.cause : null
  if (conflict) {
    if (conflict.constraint_name === 'projects_code_unique')
      return c.json(
        { code: 'DUPLICATE_PROJECT_CODE', error: '项目编号已存在' },
        409,
      )
    return c.json(
      { code: 'VERSION_CONFLICT', error: '编号或版本已存在，请刷新核对' },
      409,
    )
  }
  console.error('[NPI]', error)
  return c.json(
    {
      code: 'INTERNAL_ERROR',
      error: '服务暂时不可用；提交结果请刷新核对，勿重复提交',
    },
    500,
  )
})
app.get('/files/:kind/:targetId', async (c) =>
  c.json(
    await files.listFiles(
      c.get('userId'),
      files.fileScope(c.req.param('kind'), c.req.param('targetId')),
    ),
  ),
)
app.post('/files/:kind/:targetId', async (c) => {
  const data = await c.req.formData(),
    file = data.get('file')
  if (!(file instanceof File)) throw new NpiError('INVALID_FILE', '请选择文件')
  return c.json(
    await files.uploadFile(
      c.get('userId'),
      files.fileScope(c.req.param('kind'), c.req.param('targetId')),
      file,
      Object.fromEntries(data),
    ),
    201,
  )
})
app.get('/file-content/:id', async (c) => {
  const f = await files.downloadFile(c.get('userId'), c.req.param('id'))
  const inline =
    c.req.query('inline') === '1' &&
    ['image/png', 'image/jpeg', 'image/webp'].includes(f.mimeType)
  return new Response(new Uint8Array(f.bytes), {
    headers: {
      'Content-Type': f.mimeType,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="npi-file"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    },
  })
})
app.post('/file-archive/:id', async (c) =>
  c.json(
    await files.archiveFile(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.get('/meta', async (c) => c.json(await npi.metadata(c.get('userId'))))
app.get('/dashboard', async (c) => c.json(await npi.dashboard(c.get('userId'))))
app.get('/projects', async (c) => c.json(await npi.dashboard(c.get('userId'))))
app.post('/projects', async (c) =>
  c.json(await npi.createProject(c.get('userId'), await c.req.json()), 201),
)
app.get('/projects/:id/events', async (c) =>
  c.json(
    await projectEvents(c.get('userId'), c.req.param('id'), c.req.query()),
  ),
)
app.get('/projects/:id', async (c) =>
  c.json(await npi.projectDetail(c.get('userId'), c.req.param('id'))),
)
app.post('/projects/:id/inheritance-preview', async (c) =>
  c.json(
    await previewInheritance(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.post('/projects/:id/inherit', async (c) =>
  c.json(
    await inheritProject(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
    201,
  ),
)
app.post('/projects/:id/change-preview', async (c) =>
  c.json(
    await previewProjectChange(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.patch('/projects/:id/plan', async (c) =>
  c.json(
    await applyProjectChange(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.patch('/projects/:id/stage', async (c) =>
  c.json(
    await npi.changeStage(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.get('/projects/:id/kit-status', async (c) =>
  c.json((await npi.projectDetail(c.get('userId'), c.req.param('id'))).kit),
)
app.put('/projects/:id/manufacturing-plan', async (c) =>
  c.json(
    await npi.manufacturingPlan(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.post('/projects/:id/manufacturing-completion', async (c) =>
  c.json(
    await npi.completeManufacturing(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.post('/projects/:id/external-items', async (c) =>
  c.json(
    await npi.addExternal(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
    201,
  ),
)
app.get('/tracking/:id/history', async (c) =>
  c.json(await npi.trackingHistory(c.get('userId'), c.req.param('id'))),
)
app.post('/tracking/:id/promise', async (c) =>
  c.json(
    await npi.updatePromise(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.patch('/tracking/:id/plan', async (c) =>
  c.json(
    await npi.adjustTrackingPlan(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.post('/tracking/:id/completion-correction', async (c) =>
  c.json(
    await npi.correctCompletion(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.post('/tracking/:id/complete', async (c) =>
  c.json(
    await npi.completeItem(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.get('/workbench/procurement', async (c) =>
  c.json(await npi.procurement(c.get('userId'))),
)
app.get('/workbench/materials', async (c) =>
  c.json(await npi.assignedMaterials(c.get('userId'))),
)
app.get('/workbench/manufacturing', async (c) =>
  c.json(await npi.dashboard(c.get('userId'))),
)
app.post('/projects/:id/bom/import-preview', async (c) => {
  const body = await c.req.formData(),
    file = body.get('file'),
    template = body.get('templateId')
  if (!(file instanceof File))
    throw new NpiError('INVALID_BOM_FORMAT', '请选择Excel文件', 400)
  const rawConfirmation = body.get('motherConfirmation')
  let motherConfirmation: unknown
  if (rawConfirmation !== null) {
    if (typeof rawConfirmation !== 'string')
      throw new NpiError('VALIDATION_ERROR', '母件确认内容须为JSON文本')
    try {
      motherConfirmation = JSON.parse(rawConfirmation)
    } catch {
      throw new NpiError('VALIDATION_ERROR', '母件确认内容须为有效JSON')
    }
  }
  return c.json(
    await npi.createPreview(
      c.get('userId'),
      c.req.param('id'),
      file,
      typeof template === 'string' && template ? template : undefined,
      motherConfirmation,
    ),
  )
})
app.get('/projects/:id/bom/drafts', async (c) =>
  c.json(await drafts.listBomDrafts(c.get('userId'), c.req.param('id'))),
)
app.post('/projects/:id/bom/drafts', async (c) =>
  c.json(
    await drafts.saveBomDraft(
      c.get('userId'),
      c.req.param('id'),
      (await c.req.json()).previewToken,
    ),
  ),
)
app.post('/projects/:id/bom/drafts/:draftId/resume', async (c) => {
  const input = await c.req.json()
  if (input.templateId !== undefined && typeof input.templateId !== 'string')
    throw new NpiError('VALIDATION_ERROR', '模板编号须为文本')
  return c.json(
    await drafts.resumeBomDraft(
      c.get('userId'),
      c.req.param('id'),
      c.req.param('draftId'),
      input.templateId,
      input.motherConfirmation,
    ),
  )
})
app.post('/projects/:id/bom/drafts/:draftId/discard', async (c) =>
  c.json(
    await drafts.discardBomDraft(
      c.get('userId'),
      c.req.param('id'),
      c.req.param('draftId'),
    ),
  ),
)
app.post('/projects/:id/bom/import', async (c) =>
  c.json(
    await npi.confirmImport(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
    201,
  ),
)
app.get('/projects/:id/bom/tree', async (c) => {
  const values = c.req.queries('trackingOnly') ?? []
  if (
    values.length > 1 ||
    (values.length === 1 && !['true', 'false'].includes(values[0]!))
  )
    throw new NpiError('VALIDATION_ERROR', 'trackingOnly须为true或false')
  return c.json(
    await npi.getBom(
      c.get('userId'),
      c.req.param('id'),
      c.req.query('importId'),
      values[0] === 'true',
    ),
  )
})
app.get('/projects/:id/bom/reconciliation', async (c) =>
  c.json(await npi.getReconciliation(c.get('userId'), c.req.param('id'))),
)
app.post('/projects/:id/bom/reconciliation', async (c) =>
  c.json(
    await npi.reconcileTracking(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.get('/projects/:id/bom/diff', async (c) =>
  c.json(
    await npi.getDiff(
      c.get('userId'),
      c.req.param('id'),
      c.req.query('before') || '',
      c.req.query('after') || '',
    ),
  ),
)
app.get('/projects/:id/bom/:importId/source', async (c) => {
  const file = await npi.sourceFile(
    c.get('userId'),
    c.req.param('id'),
    c.req.param('importId'),
  )
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="erp-bom.xlsx"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})
app.patch('/bom-items/:id/tracking', async (c) =>
  c.json(
    await npi.setTracking(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.post('/projects/:id/manufacturing-exceptions', async (c) =>
  c.json(
    await npi.reportManufacturingException(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.put('/templates', async (c) =>
  c.json(await npi.saveTemplate(c.get('userId'), await c.req.json())),
)
app.put('/roles', async (c) =>
  c.json(await npi.setRole(c.get('userId'), await c.req.json())),
)
app.get('/projects/:id/issues', async (c) =>
  c.json(await issue.listIssues(c.get('userId'), c.req.param('id'))),
)
app.post('/projects/:id/issues', async (c) =>
  c.json(
    await issue.createIssue(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
    201,
  ),
)
app.get('/workbench/issues', async (c) =>
  c.json(await issue.listIssues(c.get('userId'))),
)
app.get('/issues/:id', async (c) =>
  c.json(await issue.issueDetail(c.get('userId'), c.req.param('id'))),
)
app.patch('/issues/:id', async (c) =>
  c.json(
    await issue.updateIssue(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
app.post('/issues/:id/notes', async (c) =>
  c.json(
    await issue.addIssueNote(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
    201,
  ),
)
app.post('/issues/:id/transition', async (c) =>
  c.json(
    await issue.transitionIssue(
      c.get('userId'),
      c.req.param('id'),
      await c.req.json(),
    ),
  ),
)
export default app
