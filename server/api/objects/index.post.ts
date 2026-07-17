import { z } from 'zod'

import {
  normalizeObjectFilename,
  objectKeyForId,
  presentStoredObject,
  requireNonMediaContentType,
} from '~~/server/services/cloudflare/r2-object-catalog'
import { requireAdminSession } from '~~/server/utils/auth'
import { tables, useDB } from '~~/server/utils/db'

const bodySchema = z.object({
  filename: z.string(),
  contentType: z.string().nullish(),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
})

export default eventHandler(async (event) => {
  await requireAdminSession(event)

  const body = await readValidatedBody(event, bodySchema.parse)
  const filename = normalizeObjectFilename(body.filename)
  const contentType = requireNonMediaContentType(filename, body.contentType)
  const maxObjectBytes = Number(
    useRuntimeConfig(event).public.cloudflare.r2.maxObjectBytes,
  )

  if (body.size > maxObjectBytes) {
    throw createError({
      statusCode: 413,
      statusMessage: `R2 objects are limited to ${maxObjectBytes} bytes`,
    })
  }

  const id = crypto.randomUUID()
  const r2Key = objectKeyForId(id)
  const object = await useDB(event)
    .insert(tables.objects)
    .values({
      id,
      r2Key,
      filename,
      contentType,
      expectedSize: body.size,
      status: 'pending',
    })
    .returning()
    .get()

  return {
    object: presentStoredObject(object),
    upload: {
      url: `/api/objects/${id}/upload`,
      method: 'PUT' as const,
      encoding: 'raw' as const,
      headers: {
        'Content-Type': contentType,
      },
    },
    finalizeUrl: `/api/objects/${id}/finalize`,
  }
})
