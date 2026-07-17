import { and, eq } from 'drizzle-orm'
import { createError, type H3Event } from 'h3'

import { tables, useDB } from './db'

function objectNotFound(): never {
  throw createError({ statusCode: 404, statusMessage: 'Object not found' })
}

/**
 * Resolve a route key through the D1 object catalog before allowing an R2 read.
 *
 * The catalog is the authorization boundary: callers must use the exact R2 key
 * of a finalized row. Pending/deleting rows and guessed bucket keys are
 * intentionally indistinguishable from missing objects.
 */
export async function requireReadyR2ObjectKey(
  event: H3Event,
  rawKey: string | undefined,
): Promise<string> {
  if (!rawKey) objectNotFound()

  let key: string
  try {
    key = decodeURIComponent(rawKey)
  } catch {
    objectNotFound()
  }

  if (
    !key ||
    key.length > 1024 ||
    key.startsWith('/') ||
    key.includes('\0') ||
    key.split('/').includes('..')
  ) {
    objectNotFound()
  }

  const object = await useDB(event)
    .select({ r2Key: tables.objects.r2Key })
    .from(tables.objects)
    .where(
      and(
        eq(tables.objects.r2Key, key),
        eq(tables.objects.status, 'ready'),
      ),
    )
    .get()

  if (!object) objectNotFound()
  return object.r2Key
}
