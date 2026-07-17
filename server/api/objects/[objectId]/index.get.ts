import { eq } from 'drizzle-orm'

import {
  parseObjectId,
  presentStoredObject,
} from '~~/server/services/cloudflare/r2-object-catalog'
import { requireAdminSession } from '~~/server/utils/auth'
import { tables, useDB } from '~~/server/utils/db'

export default eventHandler(async (event) => {
  await requireAdminSession(event)

  const objectId = parseObjectId(getRouterParam(event, 'objectId'))
  const object = await useDB(event)
    .select()
    .from(tables.objects)
    .where(eq(tables.objects.id, objectId))
    .get()

  if (!object) {
    throw createError({ statusCode: 404, statusMessage: 'Object not found' })
  }

  return { object: presentStoredObject(object) }
})
