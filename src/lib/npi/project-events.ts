// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, desc, eq, gte, inArray, lt, notInArray, sql } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema/users'
import { npiEvents, npiTrackingItems } from '../db/schema/npi'
import { getActor, loadProject, uuidValue } from './service'
import { NpiError, dateValue } from './domain'
import { businessDayRange } from './activity'
import { eventGroups } from './event-labels'

export async function projectEvents(
  userId: string,
  id: string,
  input: Record<string, string | undefined> = {},
) {
  const limitText = input.limit ?? '25'
  if (
    !/^\d+$/.test(limitText) ||
    Number(limitText) < 1 ||
    Number(limitText) > 100
  )
    throw new NpiError('VALIDATION_ERROR', '每页条数须为1至100之间的整数')
  const limit = Number(limitText),
    before = input.before ? uuidValue(input.before) : null
  const category = input.category || 'all'
  if (!['all', 'other', ...Object.keys(eventGroups)].includes(category))
    throw new NpiError('VALIDATION_ERROR', '动态类型无效')
  const query = (input.q || '').trim()
  if (query.length > 200)
    throw new NpiError('VALIDATION_ERROR', '搜索内容不能超过200字')
  const from = input.from ? dateValue(input.from, '开始日期')! : null
  const to = input.to ? dateValue(input.to, '结束日期')! : null
  if (from && to && from > to)
    throw new NpiError('VALIDATION_ERROR', '开始日期不能晚于结束日期')
  return db.transaction(
    async (tx) => {
      const actor = await getActor(userId, tx)
      await loadProject(tx, id, actor)
      if (before) {
        const [cursor] = await tx
          .select({ id: npiEvents.id })
          .from(npiEvents)
          .where(and(eq(npiEvents.id, before), eq(npiEvents.programId, id)))
        if (!cursor)
          throw new NpiError(
            'INVALID_CURSOR',
            '动态页码已失效，请返回最新记录',
            400,
          )
      }
      const categoryActions =
        category in eventGroups
          ? eventGroups[category as keyof typeof eventGroups].actions
          : null
      const rows = await tx
        .select({
          event: npiEvents,
          actorName: users.name,
          objectName: npiTrackingItems.name,
        })
        .from(npiEvents)
        .innerJoin(users, eq(users.id, npiEvents.actorId))
        .leftJoin(
          npiTrackingItems,
          and(
            eq(sql`${npiTrackingItems.id}::text`, npiEvents.objectId),
            eq(npiTrackingItems.programId, id),
          ),
        )
        .where(
          and(
            eq(npiEvents.programId, id),
            // Read the cursor tuple in SQL to preserve PostgreSQL timestamp microseconds.
            before
              ? sql`(${npiEvents.createdAt}, ${npiEvents.id}) < (select created_at, id from npi_events where id = ${before}::uuid and program_id = ${id}::uuid)`
              : undefined,
            categoryActions
              ? inArray(npiEvents.action, [...categoryActions])
              : category === 'other'
                ? notInArray(
                    npiEvents.action,
                    Object.values(eventGroups).flatMap((g) => [...g.actions]),
                  )
                : undefined,
            from
              ? gte(npiEvents.createdAt, businessDayRange(from).start)
              : undefined,
            to ? lt(npiEvents.createdAt, businessDayRange(to).end) : undefined,
            query
              ? sql`strpos(lower(concat_ws(' ', ${users.name}, ${npiTrackingItems.name}, ${npiEvents.detail}::text)), lower(${query})) > 0`
              : undefined,
          ),
        )
        .orderBy(desc(npiEvents.createdAt), desc(npiEvents.id))
        .limit(limit + 1)
      const items = rows.slice(0, limit).map((row) => ({
        ...row.event,
        actorName: row.actorName || '未命名',
        objectName: row.objectName,
      }))
      return {
        projectId: id,
        items,
        nextCursor: rows.length > limit ? items.at(-1)!.id : null,
        limit,
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
export type ProjectEventsPage = Awaited<ReturnType<typeof projectEvents>>
export type ProjectEvent = ProjectEventsPage['items'][number]
