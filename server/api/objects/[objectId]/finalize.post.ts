import { and, eq } from 'drizzle-orm'

import {
  objectKeyForId,
  parseObjectId,
  presentStoredObject,
  requireNonMediaContentType,
} from '~~/server/services/cloudflare/r2-object-catalog'
import { r2 } from '~~/server/services/cloudflare/r2'
import { requireAdminSession } from '~~/server/utils/auth'
import { tables, useDB } from '~~/server/utils/db'

export default eventHandler(async (event) => {
  await requireAdminSession(event)

  const objectId = parseObjectId(getRouterParam(event, 'objectId'))
  const expectedKey = objectKeyForId(objectId)
  const db = useDB(event)
  const object = await db
    .select()
    .from(tables.objects)
    .where(eq(tables.objects.id, objectId))
    .get()

  if (!object) {
    throw createError({ statusCode: 404, statusMessage: 'Object not found' })
  }
  if (object.r2Key !== expectedKey) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Object metadata contains an invalid R2 key',
    })
  }
  if (object.status === 'deleting') {
    throw createError({
      statusCode: 409,
      statusMessage: 'The object is being deleted',
    })
  }

  const r2Object = await r2.head(expectedKey)
  if (!r2Object) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Upload the object before finalizing it',
    })
  }

  const metadata = r2Object.customMetadata ?? {}
  const contentType = requireNonMediaContentType(
    object.filename,
    r2Object.httpMetadata?.contentType ?? metadata.sourceMimeType,
  )
  const validMetadata =
    r2Object.key === expectedKey &&
    contentType === object.contentType &&
    metadata.objectId === objectId &&
    metadata.sourceFilename === object.filename &&
    metadata.sourceMimeType === contentType &&
    metadata.expectedSize === String(object.expectedSize)

  if (!validMetadata) {
    throw createError({
      statusCode: 409,
      statusMessage: 'R2 object metadata does not match its upload intent',
    })
  }
  if (r2Object.size !== object.expectedSize) {
    throw createError({
      statusCode: 409,
      statusMessage: 'R2 object size does not match its upload intent',
      data: { expected: object.expectedSize, received: r2Object.size },
    })
  }

  const maxObjectBytes = Number(
    useRuntimeConfig(event).public.cloudflare.r2.maxObjectBytes,
  )
  if (r2Object.size > maxObjectBytes) {
    throw createError({
      statusCode: 413,
      statusMessage: `R2 objects are limited to ${maxObjectBytes} bytes`,
    })
  }

  const uploadedAt = new Date(
    Math.floor(r2Object.uploaded.getTime() / 1000) * 1000,
  )
  if (Number.isNaN(uploadedAt.getTime())) {
    throw createError({
      statusCode: 502,
      statusMessage: 'R2 returned an invalid upload timestamp',
    })
  }

  const alreadyCurrent =
    object.status === 'ready' &&
    object.contentType === contentType &&
    object.size === r2Object.size &&
    object.etag === r2Object.etag &&
    object.r2Version === r2Object.version &&
    object.uploadedAt?.getTime() === uploadedAt.getTime()

  if (alreadyCurrent) {
    return { object: presentStoredObject(object), finalized: false }
  }

  const now = new Date()
  const finalized = await db
    .update(tables.objects)
    .set({
      contentType,
      size: r2Object.size,
      etag: r2Object.etag,
      r2Version: r2Object.version,
      status: 'ready',
      uploadedAt,
      finalizedAt: object.finalizedAt ?? now,
      updatedAt: now,
    })
    .where(
      and(
        eq(tables.objects.id, objectId),
        eq(tables.objects.status, object.status),
      ),
    )
    .returning()
    .get()

  if (!finalized) {
    const current = await db
      .select()
      .from(tables.objects)
      .where(eq(tables.objects.id, objectId))
      .get()
    if (!current) {
      throw createError({ statusCode: 404, statusMessage: 'Object not found' })
    }
    if (
      current.status === 'ready' &&
      current.r2Key === expectedKey &&
      current.size === r2Object.size &&
      current.etag === r2Object.etag &&
      current.r2Version === r2Object.version
    ) {
      return { object: presentStoredObject(current), finalized: false }
    }
    throw createError({
      statusCode: 409,
      statusMessage: 'Object state changed while it was being finalized',
    })
  }

  return { object: presentStoredObject(finalized), finalized: true }
})
