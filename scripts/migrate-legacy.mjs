import 'dotenv/config'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute, extname } from 'node:path'
import postgres from 'postgres'

// One-time, read-only importer. The running application has no legacy dependency.
export async function migrateLegacy({
  sourceUrl,
  targetUrl,
  sourceFiles,
  targetFiles,
}) {
  if (!sourceUrl || !targetUrl)
    throw new Error('必须显式提供 LEGACY_DATABASE_URL 和 DATABASE_URL')
  const a = new URL(sourceUrl),
    b = new URL(targetUrl)
  if (a.host === b.host && a.pathname === b.pathname)
    throw new Error('迁移目标必须是另一个空数据库')
  const source = postgres(sourceUrl, { max: 1 }),
    target = postgres(targetUrl, { max: 1 })
  const counts = {}
  let committed = false
  const jsonFields = new Set([
    'attributes',
    'config',
    'preview',
    'mother',
    'template_snapshot',
    'row',
    'detail',
  ])
  try {
    await source.begin(
      'isolation level repeatable read read only',
      async (old) => {
        await target.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(73421001)`
          for (const table of [
            'users',
            'projects',
            'npi_attachments',
            'npi_import_templates',
          ])
            if ((await tx.unsafe(`select 1 from ${table} limit 1`)).length)
              throw new Error(
                '目标数据库已有数据，迁移未执行；请使用已迁移表结构但尚未初始化的空数据库',
              )
          async function insert(table, rows) {
            counts[table] = rows.length
            for (let i = 0; i < rows.length; i += 200) {
              const batch = rows
                .slice(i, i + 200)
                .map((row) =>
                  Object.fromEntries(
                    Object.entries(row).map(([key, value]) => [
                      key,
                      jsonFields.has(key) && value !== null
                        ? tx.json(value)
                        : value,
                    ]),
                  ),
                )
              await tx`insert into ${tx(table)} ${tx(batch, Object.keys(batch[0]))}`
            }
          }
          const people =
            await old`select id,lower(email) as email,coalesce(nullif(name,''),email) as name,password_hash,active,failed_login_attempts as failed_attempts,locked_until,created_at from users`
          await insert(
            'users',
            people.map((u) => ({
              ...u,
              must_change_password: true,
              version: 1,
              updated_at: u.created_at,
            })),
          )
          const roles =
            await old`select u.id as user_id,case when exists(select 1 from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=u.id and r.name='Administrator') then 'admin' else n.role end as role from users u left join npi_user_roles n on n.user_id=u.id`
          await insert(
            'npi_user_roles',
            roles.filter((r) => r.role),
          )
          const projects =
            await old`select p.id,p.code,p.name,p.customer,p.description,coalesce(p.attributes,'{}'::jsonb) as attributes,p.target_end_date,p.created_by,p.updated_by,p.created_at,p.updated_at from programs p join npi_projects n on n.program_id=p.id`
          await insert('projects', projects)
          const details = await old`select * from npi_projects`
          await insert(
            'npi_projects',
            details.map((p) => ({ ...p, active_bom_import_id: null })),
          )
          for (const table of ['npi_import_templates', 'npi_bom_imports'])
            await insert(table, await old.unsafe(`select * from ${table}`))
          const bom = await old`select * from npi_bom_items order by level,id`
          await insert('npi_bom_items', bom)
          for (const table of [
            'npi_manufacturing_plan',
            'npi_tracking_items',
            'npi_promise_history',
            'npi_events',
          ])
            await insert(table, await old.unsafe(`select * from ${table}`))
          const previews =
            await old`select * from npi_bom_previews order by created_at,id`
          await insert(
            'npi_bom_previews',
            previews.map((p) => ({ ...p, draft_source_id: null })),
          )
          for (const p of previews)
            if (p.draft_source_id)
              await tx`update npi_bom_previews set draft_source_id=${p.draft_source_id} where id=${p.id}`
          for (const p of details)
            if (p.active_bom_import_id)
              await tx`update npi_projects set active_bom_import_id=${p.active_bom_import_id} where program_id=${p.program_id}`
          const issues =
            await old`select l.item_id as id,l.program_id,l.target_date,l.tracking_item_id,l.bom_item_id,l.version,i.item_number as number,coalesce(i.name,i.item_number) as title,coalesce(q.description,'') as description,coalesce(q.severity,'Medium') as severity,i.state,q.assigned_to as owner_id,i.created_by,i.created_at,i.modified_at from npi_issue_links l join items i on i.id=l.item_id join issues q on q.item_id=i.id where not i.is_deleted and q.program_id=l.program_id`
          if (
            issues.length !==
            (await old`select count(*)::int as n from npi_issue_links`)[0].n
          )
            throw new Error('旧问题存在删除或归属不一致记录，已停止迁移')
          await insert('npi_issues', issues)
          const history =
            await old`select h.id,w.item_id as issue_id,h.from_state,coalesce(h.to_state,'Open') as to_state,coalesce(h.comments,'') as comments,coalesce(h.actor_id,i.created_by) as actor_id,h.timestamp from workflow_history h join workflow_instances w on w.id=h.instance_id join npi_issue_links l on l.item_id=w.item_id join items i on i.id=w.item_id`
          await insert('npi_issue_history', history)
          const attachments =
            await old`select l.*,v.original_file_name as name,coalesce(i.name,v.original_file_name) as title,v.file_size as size,v.mime_type,v.file_hash,v.storage_path,v.deleted_at,i.is_deleted from npi_file_links l join vault_files v on v.id=l.file_id join items i on i.id=l.document_id join documents d on d.item_id=i.id where d.file_id=v.id and v.item_id=i.id`
          if (
            attachments.length !==
            (await old`select count(*)::int as n from npi_file_links`)[0].n
          )
            throw new Error('旧附件关联不完整，已停止迁移')
          const files = []
          for (const file of attachments) {
            if (
              !sourceFiles ||
              !targetFiles ||
              file.deleted_at ||
              file.is_deleted
            )
              throw new Error('旧附件已删除或未配置附件目录，已停止迁移')
            const root = await realpath(sourceFiles),
              path = await realpath(resolve(root, file.storage_path)),
              rel = relative(root, path)
            if (rel.startsWith('..') || isAbsolute(rel))
              throw new Error('旧附件路径越界')
            const bytes = await readFile(path),
              hash = createHash('sha256').update(bytes).digest('hex')
            if (bytes.length !== file.size || hash !== file.file_hash)
              throw new Error('旧附件大小或校验和不匹配，已停止迁移')
            const extension = extname(file.name).toLowerCase()
            if (
              ![
                '.pdf',
                '.png',
                '.jpg',
                '.jpeg',
                '.webp',
                '.docx',
                '.xlsx',
              ].includes(extension)
            )
              throw new Error('旧附件类型不受支持')
            const storageKey = file.id + extension
            await mkdir(targetFiles, { recursive: true, mode: 0o700 })
            const destination = resolve(targetFiles, storageKey)
            try {
              await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
            } catch (error) {
              if (error.code !== 'EEXIST') throw error
              if (
                createHash('sha256')
                  .update(await readFile(destination))
                  .digest('hex') !== hash
              )
                throw new Error('目标附件目录有冲突文件')
            }
            files.push({
              id: file.id,
              program_id: file.program_id,
              tracking_item_id: file.tracking_item_id,
              issue_id: file.issue_id,
              name: file.name,
              title: file.title,
              size: file.size,
              mime_type: file.mime_type,
              file_hash: hash,
              storage_key: storageKey,
              category: file.category,
              request_id: file.request_id,
              request_hash: file.request_hash,
              uploaded_by: file.uploaded_by,
              created_at: file.created_at,
              archived_at: file.archived_at,
              archived_by: file.archived_by,
              archive_reason: file.archive_reason,
            })
          }
          await insert('npi_attachments', files)
          const audit =
            await old`select id,user_id,event_type,metadata,timestamp from auth_events`
          await insert(
            'account_events',
            audit.map((e) => ({
              id: e.id,
              actor_id: e.user_id,
              target_id: e.user_id,
              action: e.event_type,
              detail: { legacyEvent: true, ...(e.metadata || {}) },
              created_at: e.timestamp,
            })),
          )
          for (const [table, count] of Object.entries(counts))
            if (
              (await tx.unsafe(`select count(*)::int as n from ${table}`))[0]
                .n !== count
            )
              throw new Error('迁移记录数核对失败：' + table)
        })
        committed = true
      },
    )
    return {
      committed,
      counts,
      sessionsMigrated: false,
      passwordChangeRequired: true,
    }
  } finally {
    await source.end()
    await target.end()
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  const result = await migrateLegacy({
    sourceUrl: process.env.LEGACY_DATABASE_URL,
    targetUrl: process.env.DATABASE_URL,
    sourceFiles: process.env.LEGACY_ATTACHMENT_ROOT,
    targetFiles: resolve(
      process.env.ATTACHMENT_ROOT || './runtime/attachments',
    ),
  })
  console.log(JSON.stringify(result, null, 2))
}
