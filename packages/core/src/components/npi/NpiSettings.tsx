// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useRef, useState } from 'react'
import { FileSpreadsheet, Plus } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/Tabs'
import { nodeNames } from '../../lib/npi/domain'
import { NpiPagination, usePagination } from './NpiPagination'
import { moduleInfo, stageLabels } from './navigation'
import type { NpiMetadata } from '../../lib/npi/service'

type Template = NpiMetadata['templates'][number]
type User = NpiMetadata['users'][number]
const compare = (a: string, b: string) =>
  a.localeCompare(b, 'zh-CN', { numeric: true })
export function NpiSettings({
  meta,
  roleNames,
  onTemplate,
  onRole,
  section = 'all',
}: {
  section?: 'all' | 'templates' | 'users'
  meta: NpiMetadata
  roleNames: Record<string, string>
  onTemplate: (template?: Template) => void
  onRole: (user: User) => void
}) {
  const [templateQuery, setTemplateQuery] = useState('')
  const [templateStatus, setTemplateStatus] = useState('all')
  const [userQuery, setUserQuery] = useState('')
  const [userRole, setUserRole] = useState('all')
  const templateStart = useRef<HTMLDivElement>(null)
  const userStart = useRef<HTMLDivElement>(null)
  const templates = useMemo(() => {
    const query = templateQuery.trim().toLowerCase()
    return meta.templates
      .filter(
        (t) =>
          (templateStatus === 'all' ||
            (templateStatus === 'enabled' ? t.enabled : !t.enabled)) &&
          `${t.name} ${t.config.sheetName} ${t.id}`
            .toLowerCase()
            .includes(query),
      )
      .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
  }, [meta.templates, templateQuery, templateStatus])
  const users = useMemo(() => {
    const query = userQuery.trim().toLowerCase()
    return meta.users
      .map((u) => ({
        ...u,
        effectiveRole:
          u.role || (u.id === meta.actor.id ? meta.actor.role : ''),
      }))
      .filter(
        (u) =>
          (userRole === 'all' ||
            (userRole === 'unassigned'
              ? !u.effectiveRole
              : u.effectiveRole === userRole)) &&
          `${u.name || ''} ${u.email}`.toLowerCase().includes(query),
      )
      .sort(
        (a, b) =>
          compare(a.name || a.email, b.name || b.email) ||
          compare(a.email, b.email) ||
          compare(a.id, b.id),
      )
  }, [meta.users, meta.actor.id, meta.actor.role, userQuery, userRole])
  const templatePage = usePagination(templates, 10, templateStart)
  const userPage = usePagination(users, 20, userStart)
  return (
    <>
      <div className="npi-heading">
        <div>
          <h1>
            {section === 'all'
              ? '模板与岗位'
              : section === 'templates'
                ? '基础数据'
                : '系统设置'}
          </h1>
          <p>
            {section === 'all'
              ? '维护ERP导入格式和NPI业务岗位。'
              : moduleInfo[section === 'templates' ? 'data' : 'settings']
                  .description}
          </p>
        </div>
        {section !== 'users' && (
          <button className="npi-button" onClick={() => onTemplate()}>
            <Plus size={17} />
            新建导入模板
          </button>
        )}
      </div>
      <Tabs defaultValue={section === 'users' ? 'users' : 'templates'}>
        {section === 'all' && (
          <TabsList aria-label="配置分类">
            <TabsTrigger value="templates">导入模板</TabsTrigger>
            <TabsTrigger value="users">业务岗位</TabsTrigger>
          </TabsList>
        )}
        <TabsContent value="templates">
          <section className="npi-panel" aria-label="导入模板管理">
            <div className="npi-panel-title">
              <h2>BOM导入模板</h2>
              <span>
                筛选 {templates.length} / 共 {meta.templates.length} 个
              </span>
            </div>
            <div className="npi-settings-filters">
              <label>
                查找模板
                <input
                  type="search"
                  aria-label="搜索导入模板"
                  placeholder="名称 / 工作表 / 模板编号"
                  maxLength={200}
                  value={templateQuery}
                  onChange={(e) => setTemplateQuery(e.target.value)}
                />
              </label>
              <label>
                模板状态
                <select
                  aria-label="筛选模板状态"
                  value={templateStatus}
                  onChange={(e) => setTemplateStatus(e.target.value)}
                >
                  <option value="all">全部状态</option>
                  <option value="enabled">已启用</option>
                  <option value="disabled">已停用</option>
                </select>
              </label>
              <button
                className="npi-button secondary"
                onClick={() => {
                  setTemplateQuery('')
                  setTemplateStatus('all')
                }}
              >
                清除模板筛选
              </button>
            </div>
            <div ref={templateStart}>
              {templatePage.items.map((t) => (
                <div className="npi-settings-row" key={t.id}>
                  <FileSpreadsheet size={24} />
                  <div>
                    <strong>{t.name}</strong>
                    <small>
                      {t.config.sheetName} · 表头第{t.config.headerRow}行 ·
                      数据第{t.config.dataStartRow}行 · V{t.version} ·{' '}
                      {t.enabled ? '已启用' : '已停用'}
                    </small>
                  </div>
                  <button
                    className="npi-button secondary"
                    onClick={() => onTemplate(t)}
                  >
                    编辑映射
                  </button>
                </div>
              ))}
              {!templates.length && (
                <p className="npi-settings-empty">
                  没有匹配的导入模板，请调整搜索或状态筛选。
                </p>
              )}
            </div>
            <NpiPagination label="导入模板分页" {...templatePage} />
          </section>
          {section === 'templates' && (
            <section className="npi-panel" aria-label="业务基础定义">
              <div className="npi-panel-title">
                <h2>业务基础定义</h2>
                <span>当前业务规则</span>
              </div>
              <dl className="npi-definition-list">
                <div>
                  <dt>项目阶段</dt>
                  <dd>{Object.values(stageLabels).join(' → ')}</dd>
                </div>
                <div>
                  <dt>制造四节点</dt>
                  <dd>{Object.values(nodeNames).join('、')}</dd>
                </div>
                <div>
                  <dt>物料完成口径</dt>
                  <dd>按跟踪物料的实际完成情况统计；未跟踪BOM物料单列。</dd>
                </div>
                <div>
                  <dt>齐套预测</dt>
                  <dd>
                    按影响齐套事项的承诺日期计算；待回复与换版待复核会标记预测不完整。
                  </dd>
                </div>
              </dl>
            </section>
          )}
        </TabsContent>
        <TabsContent value="users">
          <section className="npi-panel" aria-label="业务岗位管理">
            <div className="npi-panel-title">
              <h2>NPI业务岗位</h2>
              <a href="/admin/users">管理系统用户</a>
            </div>
            <p className="npi-settings-note">
              仅列出启用的系统用户。新增或停用账号请进入“管理系统用户”。筛选{' '}
              {users.length} / 共 {meta.users.length} 人。
            </p>
            <div className="npi-settings-filters">
              <label>
                查找人员
                <input
                  type="search"
                  aria-label="搜索岗位人员"
                  placeholder="姓名 / 邮箱"
                  maxLength={200}
                  value={userQuery}
                  onChange={(e) => setUserQuery(e.target.value)}
                />
              </label>
              <label>
                业务岗位
                <select
                  aria-label="筛选NPI岗位"
                  value={userRole}
                  onChange={(e) => setUserRole(e.target.value)}
                >
                  <option value="all">全部岗位</option>
                  <option value="unassigned">未分配</option>
                  {Object.entries(roleNames).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="npi-button secondary"
                onClick={() => {
                  setUserQuery('')
                  setUserRole('all')
                }}
              >
                清除人员筛选
              </button>
            </div>
            <div ref={userStart}>
              {userPage.items.map((u) => (
                <div className="npi-settings-row" key={u.id}>
                  <div>
                    <strong>{u.name || u.email}</strong>
                    <small>{u.email}</small>
                  </div>
                  <span>{roleNames[u.effectiveRole] || '未分配'}</span>
                  <button
                    className="npi-button secondary"
                    onClick={() => onRole(u)}
                  >
                    分配岗位
                  </button>
                </div>
              ))}
              {!users.length && (
                <p className="npi-settings-empty">
                  没有匹配的人员，请调整搜索或岗位筛选。
                </p>
              )}
            </div>
            <NpiPagination label="业务岗位分页" {...userPage} />
          </section>
        </TabsContent>
      </Tabs>
    </>
  )
}
