import { fileTypeFromBuffer } from 'file-type'
import { and, eq } from 'drizzle-orm'

import {
  objectContentDisposition,
  objectKeyForId,
  parseObjectId,
  requireNonMediaContentType,
} from '~~/server/services/cloudflare/r2-object-catalog'
import {
  classifyMedia,
  normalizeContentType,
} from '~~/server/services/cloudflare/media-classification'
import {
  R2PreconditionFailedError,
  r2,
} from '~~/server/services/cloudflare/r2'
import { requireAdminSession } from '~~/server/utils/auth'
import { tables, useDB } from '~~/server/utils/db'
import { logger } from '~~/server/utils/logger'

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) return Number.NaN

  const size = Number(value)
  return Number.isSafeInteger(size) ? size : Number.NaN
}

// file-type documents 4,100 bytes as its reasonable detection sample. Keep
// this bounded so media sniffing never turns an R2 upload into whole-file
// buffering.
const FILE_TYPE_SAMPLE_BYTES = 4100

async function readDetectionPrefix(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0

  try {
    while (length < FILE_TYPE_SAMPLE_BYTES) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue

      const remaining = FILE_TYPE_SAMPLE_BYTES - length
      const chunk =
        value.byteLength <= remaining ? value : value.subarray(0, remaining)
      chunks.push(chunk)
      length += chunk.byteLength
    }
  } finally {
    // A tee branch's cancellation settles after the other branch is consumed.
    // Starting it without awaiting avoids deadlocking the upload branch.
    void reader.cancel().catch(() => undefined)
  }

  const prefix = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    prefix.set(chunk, offset)
    offset += chunk.byteLength
  }
  return prefix
}

async function detectMediaMagic(
  stream: ReadableStream<Uint8Array>,
): Promise<{ kind: 'image' | 'video'; contentType: string } | null> {
  const prefix = await readDetectionPrefix(stream)
  if (prefix.byteLength === 0) return null

  // `file-type` intentionally detects binary signatures only. SVG is an image
  // too, so reject an SVG document even when it is disguised as `.bin` with an
  // octet-stream MIME type instead of allowing it into the R2 object catalog.
  const textPrefix = new TextDecoder('utf-8', { fatal: false }).decode(prefix)
  if (
    /^\uFEFF?\s*(?:<\?xml\b[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(
      textPrefix,
    )
  ) {
    return { kind: 'image', contentType: 'image/svg+xml' }
  }

  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>
  try {
    detected = await fileTypeFromBuffer(prefix)
  } catch (error) {
    // A short, otherwise valid arbitrary binary can end mid-signature. That is
    // not itself evidence that it is media.
    if ((error as { name?: string }).name === 'EndOfStreamError') return null
    throw error
  }

  if (!detected) return null
  const classified = classifyMedia(
    `detected.${detected.ext}`,
    detected.mime,
  )
  return classified.kind === 'image' || classified.kind === 'video'
    ? { kind: classified.kind, contentType: detected.mime }
    : null
}

function isR2PreconditionFailure(error: unknown): boolean {
  if (error instanceof R2PreconditionFailedError) return true
  if (!error || typeof error !== 'object') return false

  const status = (error as { status?: number; statusCode?: number }).status
  const statusCode = (error as { status?: number; statusCode?: number })
    .statusCode
  return status === 412 || statusCode === 412
}

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
  if (object.status !== 'pending') {
    throw createError({
      statusCode: 409,
      statusMessage: 'The object upload intent is no longer pending',
    })
  }

  const declaredContentType = requireNonMediaContentType(
    object.filename,
    object.contentType,
  )
  const requestContentType = requireNonMediaContentType(
    object.filename,
    getHeader(event, 'content-type'),
  )
  if (requestContentType !== declaredContentType) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Upload Content-Type does not match its intent',
      data: { expected: declaredContentType, received: requestContentType },
    })
  }

  const contentLength = parseContentLength(getHeader(event, 'content-length'))
  if (Number.isNaN(contentLength)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid Content-Length',
    })
  }
  if (
    contentLength !== undefined &&
    contentLength !== object.expectedSize
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Upload size does not match its intent',
      data: { expected: object.expectedSize, received: contentLength },
    })
  }

  const maxObjectBytes = Number(
    useRuntimeConfig(event).public.cloudflare.r2.maxObjectBytes,
  )
  if (object.expectedSize > maxObjectBytes) {
    throw createError({
      statusCode: 413,
      statusMessage: `R2 objects are limited to ${maxObjectBytes} bytes`,
    })
  }

  const requestBody = toWebRequest(event).body
  if (!requestBody && object.expectedSize !== 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'A raw request body is required',
    })
  }

  let storageBody: ReadableStream<Uint8Array> | undefined
  if (requestBody) {
    const [inspectionBody, uploadBody] = requestBody.tee()
    storageBody = uploadBody

    let detectedMedia: Awaited<ReturnType<typeof detectMediaMagic>>
    try {
      detectedMedia = await detectMediaMagic(inspectionBody)
    } catch (error) {
      await storageBody
        .cancel('Media signature inspection failed')
        .catch(() => undefined)
      logger.chrono.error('R2 object signature inspection failed:', error)
      throw createError({
        statusCode: 400,
        statusMessage: 'Could not inspect the uploaded object',
      })
    }

    if (detectedMedia) {
      await storageBody
        .cancel('Images and videos cannot be stored in R2')
        .catch(() => undefined)
      throw createError({
        statusCode: 415,
        statusMessage: 'Images and videos must use Cloudflare Images or Stream',
        data: {
          detectedKind: detectedMedia.kind,
          detectedContentType: detectedMedia.contentType,
        },
      })
    }
  }

  let streamedBytes = 0
  let streamFailure: 'size' | 'limit' | undefined
  const uploadBody = storageBody
    ? storageBody.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            streamedBytes += chunk.byteLength
            if (streamedBytes > maxObjectBytes) {
              streamFailure = 'limit'
              throw new Error('R2 object exceeded its configured size limit')
            }
            if (streamedBytes > object.expectedSize) {
              streamFailure = 'size'
              throw new Error('R2 object exceeded its declared size')
            }
            controller.enqueue(chunk)
          },
          flush() {
            if (streamedBytes !== object.expectedSize) {
              streamFailure = 'size'
              throw new Error('R2 object did not match its declared size')
            }
          },
        }),
      )
    : new Uint8Array(0)

  try {
    const uploaded = await r2.put(expectedKey, uploadBody, {
      httpMetadata: {
        contentType: requestContentType,
        contentDisposition: objectContentDisposition(object.filename),
      },
      customMetadata: {
        objectId,
        sourceFilename: object.filename,
        sourceMimeType: normalizeContentType(requestContentType),
        expectedSize: String(object.expectedSize),
      },
      onlyIf: new Headers({ 'If-None-Match': '*' }),
    })

    const currentIntent = await db
      .select({
        etag: tables.objects.etag,
        r2Key: tables.objects.r2Key,
        r2Version: tables.objects.r2Version,
        size: tables.objects.size,
        status: tables.objects.status,
      })
      .from(tables.objects)
      .where(eq(tables.objects.id, objectId))
      .get()

    const finalizedSameUpload =
      currentIntent?.status === 'ready' &&
      currentIntent.r2Key === expectedKey &&
      currentIntent.size === uploaded.size &&
      currentIntent.etag === uploaded.etag &&
      currentIntent.r2Version === uploaded.version
    const intentStillPending =
      currentIntent?.status === 'pending' &&
      currentIntent.r2Key === expectedKey

    if (!intentStillPending && !finalizedSameUpload) {
      const now = new Date()
      if (currentIntent) {
        await db
          .update(tables.objects)
          .set({ status: 'deleting', updatedAt: now })
          .where(
            and(
              eq(tables.objects.id, objectId),
              eq(tables.objects.status, currentIntent.status),
            ),
          )
          .run()
      }

      try {
        await r2.delete(expectedKey)
      } catch (cleanupError) {
        // If the competing delete already removed the D1 row, recreate a
        // retryable tombstone rather than losing track of the late R2 write.
        try {
          await db
            .insert(tables.objects)
            .values({
              ...object,
              status: 'deleting',
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: tables.objects.id,
              set: { status: 'deleting', updatedAt: now },
            })
            .run()
        } catch (catalogError) {
          logger.chrono.error(
            'Failed to preserve the R2 cleanup tombstone:',
            catalogError,
          )
        }

        logger.chrono.error(
          'Failed to compensate a cancelled R2 object upload:',
          cleanupError,
        )
        throw createError({
          statusCode: 502,
          statusMessage: 'Upload was cancelled but R2 cleanup must be retried',
        })
      }

      await db
        .delete(tables.objects)
        .where(
          and(
            eq(tables.objects.id, objectId),
            eq(tables.objects.status, 'deleting'),
          ),
        )
        .run()

      throw createError({
        statusCode: 409,
        statusMessage: 'The upload intent was deleted during the upload',
      })
    }

    return {
      uploaded: true,
      objectId,
      key: expectedKey,
      size: uploaded.size,
      etag: uploaded.etag,
      finalizeUrl: `/api/objects/${objectId}/finalize`,
    }
  } catch (error) {
    if (isR2PreconditionFailure(error)) {
      throw createError({
        statusCode: 409,
        statusMessage: 'R2 already contains this object; finalize or delete it',
      })
    }
    if (streamFailure === 'limit') {
      throw createError({
        statusCode: 413,
        statusMessage: `R2 objects are limited to ${maxObjectBytes} bytes`,
      })
    }
    if (streamFailure === 'size') {
      throw createError({
        statusCode: 400,
        statusMessage: 'Upload size does not match its intent',
        data: { expected: object.expectedSize, received: streamedBytes },
      })
    }
    if ((error as { statusCode?: number }).statusCode) throw error

    logger.chrono.error('R2 object upload failed:', error)
    throw createError({
      statusCode: 502,
      statusMessage: 'R2 object upload failed',
    })
  }
})
