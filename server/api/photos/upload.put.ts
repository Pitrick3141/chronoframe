import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'

import {
  HOSTED_IMAGE_MAX_BYTES,
  MOTION_PHOTO_SOURCE_MAX_BYTES,
  hostedImages,
  type HostedImageDetails,
} from '~~/server/services/cloudflare/hosted-images'
import {
  classifyMedia,
  normalizeContentType,
} from '~~/server/services/cloudflare/media-classification'
import { cloudflareStream } from '~~/server/services/cloudflare/stream'
import {
  createAndFinalizeQueueTask,
  finalizeExistingQueueTask,
  type QueueFinalizeResult,
} from '~~/server/services/cloudflare/finalize-upload'
import { extractMotionPhotoVideo } from '~~/server/services/video/motion-photo'
import { requireAdminSession } from '~~/server/utils/auth'
import { tables, useDB, type ImageUploadIntent } from '~~/server/utils/db'
import { logger } from '~~/server/utils/logger'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UPLOAD_LEASE_MS = 5 * 60 * 1000

const singleQueryValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const parseSize = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.NaN
}

const metadataString = (
  details: HostedImageDetails,
  key: string,
): string | undefined => {
  const value = details.meta?.[key]
  return typeof value === 'string' && value ? value : undefined
}

const isMatchingHostedUpload = (
  details: HostedImageDetails,
  intent: ImageUploadIntent,
): boolean => {
  const storedSize = Number(metadataString(details, 'sourceSize'))
  const lastModifiedMatches = intent.lastModified
    ? metadataString(details, 'lastModified') === intent.lastModified
    : metadataString(details, 'lastModified') === undefined

  return (
    details.draft !== true &&
    details.requireSignedURLs === true &&
    details.creator === intent.id &&
    metadataString(details, 'uploadIntentId') === intent.id &&
    metadataString(details, 'sourceFilename') === intent.filename &&
    normalizeContentType(
      metadataString(details, 'sourceMimeType') ?? details.contentType,
    ) === intent.contentType &&
    Number.isSafeInteger(storedSize) &&
    storedSize === intent.expectedSize &&
    lastModifiedMatches
  )
}

const uploadError = (
  t: Awaited<ReturnType<typeof useTranslation>>,
  statusCode: number,
  field?: string,
) =>
  createError({
    statusCode,
    statusMessage: t('upload.error.required.title'),
    data: {
      title: t('upload.error.required.title'),
      message: field
        ? t('upload.error.required.message', { field })
        : t('upload.error.uploadFailed.message'),
    },
  })

const tooLargeError = (
  t: Awaited<ReturnType<typeof useTranslation>>,
  size: number,
  maxFileSizeMB: number,
) =>
  createError({
    statusCode: 413,
    statusMessage: t('upload.error.tooLarge.title'),
    data: {
      title: t('upload.error.tooLarge.title'),
      message: t('upload.error.tooLarge.message', {
        size: (size / 1024 / 1024).toFixed(2),
      }),
      suggestion: t('upload.error.tooLarge.suggestion', {
        maxSize: maxFileSizeMB,
      }),
    },
  })

async function readLimitedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue

      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel('Hosted Image upload is too large')
        const error = new Error('Hosted Image upload is too large') as Error & {
          statusCode: number
          actualSize: number
        }
        error.statusCode = 413
        error.actualSize = size
        throw error
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function uploadResponse(
  intent: Pick<
    ImageUploadIntent,
    'id' | 'imageId' | 'embeddedStreamId' | 'status'
  >,
  reused: boolean,
  task?: QueueFinalizeResult,
) {
  if (!intent.imageId) {
    throw new Error(`Image upload intent ${intent.id} has no Hosted Image ID`)
  }
  return {
    ok: true,
    key: intent.imageId,
    imageId: intent.imageId,
    intentId: intent.id,
    embeddedStreamId: intent.embeddedStreamId ?? undefined,
    kind: 'image' as const,
    status: intent.status,
    reused,
    ...(task
      ? {
          taskId: task.taskId,
          taskStatus: task.status,
          photoId: task.photoId ?? intent.imageId,
          warning: task.warning,
          error: task.error,
        }
      : {}),
  }
}

async function findExistingImageTask(
  db: ReturnType<typeof useDB>,
  imageId: string,
): Promise<number | null> {
  const existing = await db
    .select({ id: tables.pipelineQueue.id })
    .from(tables.pipelineQueue)
    .where(
      and(
        sql`json_extract(${tables.pipelineQueue.payload}, '$.type') = 'photo'`,
        sql`json_extract(${tables.pipelineQueue.payload}, '$.storageKey') = ${imageId}`,
      ),
    )
    .orderBy(desc(tables.pipelineQueue.id))
    .get()
  return existing?.id ?? null
}

async function completeUploadResponse(
  db: ReturnType<typeof useDB>,
  intent: ImageUploadIntent,
  reused: boolean,
): Promise<ReturnType<typeof uploadResponse>> {
  if (!intent.imageId) return uploadResponse(intent, reused)

  const payload = {
    type: 'photo' as const,
    storageKey: intent.imageId,
    eraseLocation: intent.eraseLocation,
  }
  let taskId = intent.queueTaskId

  if (!taskId) {
    taskId = await findExistingImageTask(db, intent.imageId)
    if (taskId) {
      await db
        .update(tables.imageUploadIntents)
        .set({ queueTaskId: taskId, updatedAt: new Date() })
        .where(
          and(
            eq(tables.imageUploadIntents.id, intent.id),
            eq(tables.imageUploadIntents.imageId, intent.imageId),
            isNull(tables.imageUploadIntents.queueTaskId),
          ),
        )
        .run()
    }
  }

  if (taskId) {
    const task = await finalizeExistingQueueTask(taskId, payload)
    return uploadResponse(intent, reused, task)
  }

  const claimToken = crypto.randomUUID()
  const claimedAt = new Date()
  const taskClaim = await db
    .update(tables.imageUploadIntents)
    .set({
      leaseToken: claimToken,
      leaseExpiresAt: new Date(claimedAt.getTime() + UPLOAD_LEASE_MS),
      updatedAt: claimedAt,
    })
    .where(
      and(
        eq(tables.imageUploadIntents.id, intent.id),
        eq(tables.imageUploadIntents.imageId, intent.imageId),
        inArray(tables.imageUploadIntents.status, ['uploaded', 'finalized']),
        isNull(tables.imageUploadIntents.queueTaskId),
        or(
          isNull(tables.imageUploadIntents.leaseToken),
          isNull(tables.imageUploadIntents.leaseExpiresAt),
          lte(tables.imageUploadIntents.leaseExpiresAt, claimedAt),
        ),
      ),
    )
    .returning({ id: tables.imageUploadIntents.id })
    .get()

  if (!taskClaim) {
    const current = await db
      .select()
      .from(tables.imageUploadIntents)
      .where(eq(tables.imageUploadIntents.id, intent.id))
      .get()
    const recoveredTaskId =
      current?.queueTaskId ?? (await findExistingImageTask(db, intent.imageId))
    if (current && recoveredTaskId) {
      const task = await finalizeExistingQueueTask(recoveredTaskId, payload)
      return uploadResponse(current, true, task)
    }
    throw createError({
      statusCode: 503,
      statusMessage: 'Image finalization task is being created',
    })
  }

  let task: QueueFinalizeResult
  try {
    task = await createAndFinalizeQueueTask(payload, {
      priority: 1,
      maxAttempts: 3,
    })
  } catch (error) {
    const recoveredTaskId = await findExistingImageTask(db, intent.imageId)
    if (!recoveredTaskId) {
      await db
        .update(tables.imageUploadIntents)
        .set({
          leaseToken: null,
          leaseExpiresAt: null,
          lastError:
            error instanceof Error
              ? error.message.slice(0, 1000)
              : String(error),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tables.imageUploadIntents.id, intent.id),
            eq(tables.imageUploadIntents.leaseToken, claimToken),
          ),
        )
        .run()
      throw error
    }
    task = await finalizeExistingQueueTask(recoveredTaskId, payload)
  }

  await db
    .update(tables.imageUploadIntents)
    .set({
      queueTaskId: task.taskId,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tables.imageUploadIntents.id, intent.id),
        eq(tables.imageUploadIntents.leaseToken, claimToken),
      ),
    )
    .run()

  const current = await db
    .select()
    .from(tables.imageUploadIntents)
    .where(eq(tables.imageUploadIntents.id, intent.id))
    .get()
  return uploadResponse(current ?? intent, reused, task)
}

async function recoverHostedUpload(
  db: ReturnType<typeof useDB>,
  intent: ImageUploadIntent,
): Promise<ImageUploadIntent | null> {
  let candidates: HostedImageDetails[]
  try {
    const listed = await hostedImages.list({
      creator: intent.id,
      limit: 100,
      sortOrder: 'desc',
    })
    candidates = listed.images.filter((item) =>
      isMatchingHostedUpload(item, intent),
    )
  } catch (error) {
    logger.chrono.warn(
      `Could not scan Hosted Images for upload intent ${intent.id}:`,
      error,
    )
    return null
  }

  const candidate = candidates[0]
  if (!candidate) return null

  const embeddedStreamId =
    metadataString(candidate, 'embeddedStreamId') ?? intent.embeddedStreamId
  const now = new Date()
  const recovered = await db
    .update(tables.imageUploadIntents)
    .set({
      status: 'uploaded',
      imageId: candidate.id,
      embeddedStreamId: embeddedStreamId ?? null,
      actualSize: candidate.fileSize ?? null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      uploadedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(tables.imageUploadIntents.id, intent.id),
        eq(tables.imageUploadIntents.creatorId, intent.creatorId),
        inArray(tables.imageUploadIntents.status, ['pending', 'uploading']),
      ),
    )
    .returning()
    .get()

  const current =
    recovered ??
    (await db
      .select()
      .from(tables.imageUploadIntents)
      .where(eq(tables.imageUploadIntents.id, intent.id))
      .get())

  if (current?.imageId === candidate.id) {
    // A crash after the Images upload can leave duplicate auto-ID objects if a
    // lease was later reclaimed. Keep the D1 winner and remove all extras.
    for (const duplicate of candidates.slice(1)) {
      void hostedImages
        .delete(duplicate.id)
        .catch((error) =>
          logger.chrono.warn(
            `Could not delete duplicate Hosted Image ${duplicate.id}:`,
            error,
          ),
        )
    }
    return current
  }

  // Another request won with a different auto-generated ID. This candidate
  // is no longer reachable from D1 and must not become an orphan.
  for (const orphan of candidates) {
    await hostedImages
      .delete(orphan.id)
      .catch((error) =>
        logger.chrono.warn(
          `Could not compensate Hosted Image ${orphan.id}:`,
          error,
        ),
      )
  }
  return current?.imageId ? current : null
}

async function deleteStreamBestEffort(streamId: string): Promise<boolean> {
  try {
    await cloudflareStream.delete(streamId)
    return true
  } catch (error) {
    logger.chrono.warn(`Could not delete Stream video ${streamId}:`, error)
    return false
  }
}

async function releaseUploadLease(
  db: ReturnType<typeof useDB>,
  intentId: string,
  leaseToken: string,
  error: unknown,
  embeddedStreamId: string | null,
): Promise<void> {
  const now = new Date()
  await db
    .update(tables.imageUploadIntents)
    .set({
      status: 'pending',
      leaseToken: null,
      leaseExpiresAt: null,
      embeddedStreamId,
      lastError:
        error instanceof Error ? error.message.slice(0, 1000) : String(error),
      updatedAt: now,
    })
    .where(
      and(
        eq(tables.imageUploadIntents.id, intentId),
        eq(tables.imageUploadIntents.status, 'uploading'),
        eq(tables.imageUploadIntents.leaseToken, leaseToken),
      ),
    )
    .run()
}

export default eventHandler(async (event) => {
  const session = await requireAdminSession(event)
  const t = await useTranslation(event)
  const intentId = singleQueryValue(getQuery(event).intent)

  if (!intentId || !UUID_PATTERN.test(intentId)) {
    throw uploadError(t, 400, 'intent')
  }

  const db = useDB(event)
  let intent = await db
    .select()
    .from(tables.imageUploadIntents)
    .where(
      and(
        eq(tables.imageUploadIntents.id, intentId),
        eq(tables.imageUploadIntents.creatorId, session.user.id),
      ),
    )
    .get()

  if (!intent) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Image upload intent was not found',
    })
  }

  if (
    (intent.status === 'uploaded' || intent.status === 'finalized') &&
    intent.imageId
  ) {
    return completeUploadResponse(db, intent, true)
  }

  if (intent.status === 'failed') {
    throw createError({
      statusCode: 409,
      statusMessage: intent.lastError || 'Image upload intent has failed',
    })
  }

  if (intent.expiresAt.getTime() <= Date.now()) {
    const now = new Date()
    await db
      .update(tables.imageUploadIntents)
      .set({
        status: 'failed',
        lastError: 'Image upload intent expired',
        failedAt: now,
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(tables.imageUploadIntents.id, intent.id),
          inArray(tables.imageUploadIntents.status, ['pending', 'uploading']),
        ),
      )
      .run()
    throw createError({
      statusCode: 410,
      statusMessage: 'Image upload intent expired',
    })
  }

  if (intent.status === 'uploading' || intent.attemptCount > 0) {
    const recovered = await recoverHostedUpload(db, intent)
    if (recovered?.imageId) {
      return completeUploadResponse(db, recovered, true)
    }
  }

  if (
    intent.status === 'uploading' &&
    intent.leaseExpiresAt &&
    intent.leaseExpiresAt.getTime() > Date.now()
  ) {
    setHeader(event, 'Retry-After', 5)
    throw createError({
      statusCode: 409,
      statusMessage: 'Image upload intent is already being processed',
    })
  }

  const requestContentType = normalizeContentType(
    getHeader(event, 'content-type'),
  )
  const media = classifyMedia(intent.filename, requestContentType)
  if (
    media.kind !== 'image' ||
    requestContentType !== intent.contentType ||
    media.contentType !== intent.contentType
  ) {
    throw createError({
      statusCode: 415,
      statusMessage: t('upload.error.invalidType.title'),
      data: {
        title: t('upload.error.invalidType.title'),
        message: t('upload.error.invalidType.message', {
          type: requestContentType || 'unknown',
        }),
      },
    })
  }

  const contentLength = parseSize(getHeader(event, 'content-length'))
  if (Number.isNaN(contentLength)) throw uploadError(t, 400, 'content-length')
  if (contentLength !== undefined && contentLength !== intent.expectedSize) {
    throw uploadError(t, 400, 'content-length')
  }

  const config = useRuntimeConfig(event)
  const hostedMaxBytes = Math.min(
    config.public.cloudflare.images.maxUploadBytes,
    HOSTED_IMAGE_MAX_BYTES,
  )
  const isJpeg = intent.contentType === 'image/jpeg'
  const sourceMaxBytes = isJpeg ? MOTION_PHOTO_SOURCE_MAX_BYTES : hostedMaxBytes
  if (intent.expectedSize > sourceMaxBytes) {
    throw tooLargeError(t, intent.expectedSize, sourceMaxBytes / 1024 / 1024)
  }

  const requestBody = toWebRequest(event).body
  if (!requestBody) throw uploadError(t, 400)

  let rawBytes: Uint8Array
  try {
    rawBytes = await readLimitedBody(requestBody, sourceMaxBytes)
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 413) {
      const actualSize =
        (error as { actualSize?: number }).actualSize ?? sourceMaxBytes + 1
      throw tooLargeError(t, actualSize, sourceMaxBytes / 1024 / 1024)
    }
    throw error
  }

  if (rawBytes.byteLength !== intent.expectedSize) {
    throw uploadError(t, 400, 'content-length')
  }

  const now = new Date()
  const leaseToken = crypto.randomUUID()
  const claimed = await db
    .update(tables.imageUploadIntents)
    .set({
      status: 'uploading',
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + UPLOAD_LEASE_MS),
      attemptCount: sql`${tables.imageUploadIntents.attemptCount} + 1`,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(tables.imageUploadIntents.id, intent.id),
        eq(tables.imageUploadIntents.creatorId, intent.creatorId),
        or(
          eq(tables.imageUploadIntents.status, 'pending'),
          and(
            eq(tables.imageUploadIntents.status, 'uploading'),
            or(
              isNull(tables.imageUploadIntents.leaseExpiresAt),
              lte(tables.imageUploadIntents.leaseExpiresAt, now),
            ),
          ),
        ),
      ),
    )
    .returning()
    .get()

  if (!claimed) {
    const current = await db
      .select()
      .from(tables.imageUploadIntents)
      .where(eq(tables.imageUploadIntents.id, intent.id))
      .get()
    if (current?.imageId) {
      return completeUploadResponse(db, current, true)
    }
    throw createError({
      statusCode: 409,
      statusMessage: 'Image upload intent could not be claimed',
    })
  }
  intent = claimed

  let imageBytes = rawBytes
  let streamId = intent.embeddedStreamId
  let streamUploadedThisAttempt = false
  const extraction = isJpeg
    ? extractMotionPhotoVideo(rawBytes)
    : ({ status: 'not-motion' } as const)

  if (extraction.status === 'malformed') {
    if (streamId && (await deleteStreamBestEffort(streamId))) streamId = null
    const failedAt = new Date()
    await db
      .update(tables.imageUploadIntents)
      .set({
        status: 'failed',
        embeddedStreamId: streamId,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: extraction.reason,
        failedAt,
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(tables.imageUploadIntents.id, intent.id),
          eq(tables.imageUploadIntents.leaseToken, leaseToken),
        ),
      )
      .run()
    throw createError({
      statusCode: 422,
      statusMessage: `Malformed Motion Photo: ${extraction.reason}`,
    })
  }

  try {
    if (extraction.status === 'extracted') {
      imageBytes = rawBytes.slice(0, extraction.offset)
      if (imageBytes.byteLength === 0) {
        throw createError({
          statusCode: 422,
          statusMessage: 'Motion Photo contains no static JPEG bytes',
        })
      }

      if (streamId) {
        const priorStreamId = streamId
        let reusable = false
        try {
          const prior = await cloudflareStream.details(priorStreamId)
          const state = prior.status.state.toLowerCase()
          reusable =
            Boolean(prior.uploaded) ||
            !['pendingupload', 'error', 'failed'].includes(state)
        } catch (error) {
          logger.chrono.warn(
            `Could not inspect prior Stream video ${priorStreamId}:`,
            error,
          )
        }

        if (!reusable) {
          const deleted = await deleteStreamBestEffort(priorStreamId)
          if (!deleted) {
            throw new Error(
              `Prior Stream video ${priorStreamId} is unusable and could not be deleted`,
            )
          }
          streamId = null
        }
      }

      if (!streamId) {
        const videoFilename = `${intent.filename.replace(/\.[^.]+$/, '')}.mp4`
        const directUpload = await cloudflareStream.createDirectUpload({
          maxDurationSeconds: Number(
            config.cloudflare.stream.maxDurationSeconds ?? 600,
          ),
          expiry: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          creator: intent.id,
          meta: {
            uploadIntentId: intent.id,
            sourceImageIntentId: intent.id,
            sourceFilename: videoFilename,
            sourceMimeType: 'video/mp4',
            sourceSize: String(extraction.video.byteLength),
            purpose: 'motion-photo',
            ...(extraction.presentationTimestampUs === undefined
              ? {}
              : {
                  presentationTimestampUs: String(
                    extraction.presentationTimestampUs,
                  ),
                }),
          },
          requireSignedURLs: true,
        })
        streamId = directUpload.id

        const recorded = await db
          .update(tables.imageUploadIntents)
          .set({ embeddedStreamId: streamId, updatedAt: new Date() })
          .where(
            and(
              eq(tables.imageUploadIntents.id, intent.id),
              eq(tables.imageUploadIntents.status, 'uploading'),
              eq(tables.imageUploadIntents.leaseToken, leaseToken),
            ),
          )
          .returning({ id: tables.imageUploadIntents.id })
          .get()
        if (!recorded) {
          await deleteStreamBestEffort(streamId)
          throw createError({
            statusCode: 409,
            statusMessage: 'Image upload lease was lost before Stream upload',
          })
        }

        await cloudflareStream.uploadFile(
          directUpload.uploadURL,
          extraction.video,
          videoFilename,
        )
        streamUploadedThisAttempt = true
      }
    } else if (streamId && (await deleteStreamBestEffort(streamId))) {
      streamId = null
      await db
        .update(tables.imageUploadIntents)
        .set({ embeddedStreamId: null, updatedAt: new Date() })
        .where(
          and(
            eq(tables.imageUploadIntents.id, intent.id),
            eq(tables.imageUploadIntents.leaseToken, leaseToken),
          ),
        )
        .run()
    }

    if (imageBytes.byteLength > hostedMaxBytes) {
      throw tooLargeError(
        t,
        imageBytes.byteLength,
        hostedMaxBytes / 1024 / 1024,
      )
    }

    const sourceMetadata = {
      uploadIntentId: intent.id,
      sourceFilename: intent.filename,
      sourceMimeType: intent.contentType,
      sourceSize: String(intent.expectedSize),
      staticSourceSize: String(imageBytes.byteLength),
      ...(intent.lastModified ? { lastModified: intent.lastModified } : {}),
      ...(streamId ? { embeddedStreamId: streamId } : {}),
      ...(extraction.status === 'extracted' &&
      extraction.presentationTimestampUs !== undefined
        ? {
            motionPhotoPresentationTimestampUs: String(
              extraction.presentationTimestampUs,
            ),
          }
        : {}),
    }

    let uploaded
    try {
      uploaded = await hostedImages.upload(imageBytes, {
        filename: intent.filename,
        contentType: intent.contentType,
        creator: intent.id,
        metadata: sourceMetadata,
      })
    } catch (error) {
      const recovered = await recoverHostedUpload(db, intent)
      if (recovered?.imageId) {
        return completeUploadResponse(db, recovered, true)
      }
      throw error
    }

    const uploadedAt = new Date()
    let persisted: ImageUploadIntent | undefined
    try {
      persisted = await db
        .update(tables.imageUploadIntents)
        .set({
          status: 'uploaded',
          imageId: uploaded.id,
          embeddedStreamId: streamId,
          actualSize: uploaded.fileSize,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: null,
          uploadedAt,
          updatedAt: uploadedAt,
        })
        .where(
          and(
            eq(tables.imageUploadIntents.id, intent.id),
            eq(tables.imageUploadIntents.status, 'uploading'),
            eq(tables.imageUploadIntents.leaseToken, leaseToken),
          ),
        )
        .returning()
        .get()
    } catch (error) {
      logger.chrono.error(
        `Hosted Image ${uploaded.id} committed but D1 intent update failed:`,
        error,
      )
      // Keep the leased intent and creator metadata intact. A retry can find
      // the auto-ID image through hosted.list({ creator: intentId }).
      throw createError({
        statusCode: 502,
        statusMessage: 'Image was stored but its D1 intent needs recovery',
      })
    }

    if (!persisted) {
      const current = await db
        .select()
        .from(tables.imageUploadIntents)
        .where(eq(tables.imageUploadIntents.id, intent.id))
        .get()
      if (current?.imageId === uploaded.id) {
        return completeUploadResponse(db, current, true)
      }

      await hostedImages
        .delete(uploaded.id)
        .catch((error) =>
          logger.chrono.warn(
            `Could not compensate unclaimed Hosted Image ${uploaded.id}:`,
            error,
          ),
        )
      if (streamId) await deleteStreamBestEffort(streamId)
      throw createError({
        statusCode: 409,
        statusMessage: 'Image upload lease was lost before D1 finalization',
      })
    }

    return completeUploadResponse(db, persisted, false)
  } catch (error) {
    // Once a Hosted Image has committed, the inner branch intentionally
    // leaves the D1 lease intact for creator-based recovery. All other errors
    // compensate the Stream asset and make the intent safely retryable.
    const statusCode = (error as { statusCode?: number }).statusCode
    if (statusCode === 502) throw error

    if (streamId) {
      const deleted = await deleteStreamBestEffort(streamId)
      if (deleted) streamId = null
    }
    await releaseUploadLease(db, intent.id, leaseToken, error, streamId)

    if (statusCode) throw error
    logger.chrono.error('Private Hosted Images upload failed:', error)
    throw createError({
      statusCode: 500,
      statusMessage: t('upload.error.uploadFailed.title'),
      data: {
        title: t('upload.error.uploadFailed.title'),
        message: t('upload.error.uploadFailed.message'),
        streamUploadCompleted: streamUploadedThisAttempt,
      },
    })
  }
})
