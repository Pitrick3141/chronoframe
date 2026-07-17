import { count, desc, eq } from 'drizzle-orm'
import { z } from 'zod'

import { presentStoredObject } from '~~/server/services/cloudflare/r2-object-catalog'
import { requireAdminSession } from '~~/server/utils/auth'
import { tables, useDB } from '~~/server/utils/db'

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['pending', 'ready', 'deleting']).optional(),
})

export default eventHandler(async (event) => {
  await requireAdminSession(event)

  const query = await getValidatedQuery(event, querySchema.parse)
  const db = useDB(event)
  const filter = query.status
    ? eq(tables.objects.status, query.status)
    : undefined
  const offset = (query.page - 1) * query.limit

  const totalRow = await db
    .select({ value: count() })
    .from(tables.objects)
    .where(filter)
    .get()
  const rows = await db
    .select()
    .from(tables.objects)
    .where(filter)
    .orderBy(desc(tables.objects.createdAt), desc(tables.objects.id))
    .limit(query.limit)
    .offset(offset)

  const total = Number(totalRow?.value ?? 0)
  return {
    items: rows.map(presentStoredObject),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  }
})
