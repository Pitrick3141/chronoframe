import { and, eq } from 'drizzle-orm'

import {
  objectKeyForId,
  parseObjectId,
} from '~~/server/services/cloudflare/r2-object-catalog'
import { r2 } from '~~/server/services/cloudflare/r2'
import { requireAdminSession } from '~~/server/utils/auth'
import { tables, useDB } from '~~/server/utils/db'
import { logger } from '~~/server/utils/logger'

export default eventHandler(async (event) => {
  await requireAdminSession(event)

  const objectId = parseObjectId(getRouterParam(event, 'objectId'))
  const expectedKey = objectKeyForId(objectId)
  const db = useDB(event)
  let object = await db
    .select({
      r2Key: tables.objects.r2Key,
      status: tables.objects.status,
    })
    .from(tables.objects)
    .where(eq(tables.objects.id, objectId))
    .get()

  // Re-read after a failed compare-and-set so a concurrent finalize can only
  // move pending -> ready, never race past the deleting tombstone.
  let claimAttempts = 0
  while (object && object.status !== 'deleting' && claimAttempts < 3) {
    if (object.r2Key !== expectedKey) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Object metadata contains an invalid R2 key',
      })
    }

    const claimed = await db
      .update(tables.objects)
      .set({ status: 'deleting', updatedAt: new Date() })
      .where(
        and(
          eq(tables.objects.id, objectId),
          eq(tables.objects.r2Key, expectedKey),
          eq(tables.objects.status, object.status),
        ),
      )
      .returning({
        r2Key: tables.objects.r2Key,
        status: tables.objects.status,
      })
      .get()

    if (claimed) {
      object = claimed
      break
    }

    object = await db
      .select({
        r2Key: tables.objects.r2Key,
        status: tables.objects.status,
      })
      .from(tables.objects)
      .where(eq(tables.objects.id, objectId))
      .get()
    claimAttempts += 1
  }

  if (object && object.r2Key !== expectedKey) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Object metadata contains an invalid R2 key',
    })
  }
  if (object && object.status !== 'deleting') {
    throw createError({
      statusCode: 409,
      statusMessage: 'Object state changed while deletion was starting',
    })
  }

  const wasTracked = Boolean(object)

  try {
    // R2 delete is successful when the key is already absent. The key is
    // deterministic, so this remains safe and retryable after the D1 row is
    // gone as well.
    await r2.delete(expectedKey)
  } catch (error) {
    logger.chrono.error('R2 object deletion failed:', error)
    throw createError({
      statusCode: 502,
      statusMessage: 'R2 object deletion failed; retry the deleting object',
    })
  }

  await db
    .delete(tables.objects)
    .where(
      and(
        eq(tables.objects.id, objectId),
        eq(tables.objects.r2Key, expectedKey),
        eq(tables.objects.status, 'deleting'),
      ),
    )
    .run()

  return {
    deleted: true,
    objectId,
    key: expectedKey,
    wasTracked,
  }
})
