import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import {
  finalizeLivePhotoVideo,
  StaleStreamAssociationError,
  type WorkersPipelinePayload,
} from '~~/server/services/cloudflare/finalize-upload'
import type { StreamVideoDetails } from '~~/server/services/cloudflare/stream'
import { getCloudflareBindings } from '~~/server/utils/cloudflare-bindings'
import {
  InvalidStreamWebhookSignatureError,
  verifyStreamWebhookSignature,
} from '~~/server/utils/cloudflare-stream-webhook'

const MAX_WEBHOOK_BYTES = 1024 * 1024

const statusSchema = z
  .object({
    state: z.string().optional(),
    step: z.string().optional(),
    pctComplete: z.string().optional(),
    errorReasonCode: z.string().optional(),
    errorReasonText: z.string().optional(),
    // Some Stream webhook examples use the shorter `errReason*` spelling.
    errReasonCode: z.string().optional(),
    errReasonText: z.string().optional(),
  })
  .passthrough()

const webhookSchema = z
  .object({
    uid: z.string().trim().min(1).max(256),
    meta: z.record(z.string(), z.unknown()).optional().default({}),
    status: z.union([z.string(), statusSchema]).optional(),
    readyToStream: z.boolean().optional().default(false),
    playback: z
      .object({
        hls: z.string().optional(),
        dash: z.string().optional(),
      })
      .optional()
      .default({}),
    thumbnail: z.string().optional(),
    duration: z.number().nonnegative().optional(),
    size: z.number().nonnegative().optional(),
    created: z.string().optional(),
    modified: z.string().optional(),
    uploaded: z.string().nullable().optional(),
  })
  .passthrough()

function metadataStrings(
  value: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

function requestBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value)

  throw createError({
    statusCode: 400,
    statusMessage: 'Cloudflare Stream webhook body is required',
  })
}

function normalizedStatus(value: z.infer<typeof webhookSchema>) {
  if (typeof value.status === 'string') {
    return { state: value.status }
  }

  const status = value.status ?? {}
  return {
    state: status.state ?? (value.readyToStream ? 'ready' : 'processing'),
    ...(status.step === undefined ? {} : { step: status.step }),
    ...(status.pctComplete === undefined
      ? {}
      : { pctComplete: status.pctComplete }),
    ...((status.errorReasonCode ?? status.errReasonCode) === undefined
      ? {}
      : { errorReasonCode: status.errorReasonCode ?? status.errReasonCode }),
    ...((status.errorReasonText ?? status.errReasonText) === undefined
      ? {}
      : { errorReasonText: status.errorReasonText ?? status.errReasonText }),
  }
}

function normalizedDetails(
  value: z.infer<typeof webhookSchema>,
  meta: Record<string, string>,
): StreamVideoDetails {
  return {
    id: value.uid,
    uid: value.uid,
    meta,
    status: normalizedStatus(value),
    playback: {
      ...(value.playback.hls ? { hls: value.playback.hls } : {}),
      ...(value.playback.dash ? { dash: value.playback.dash } : {}),
    },
    readyToStream: value.readyToStream,
    ...(value.thumbnail ? { thumbnail: value.thumbnail } : {}),
    ...(value.duration === undefined ? {} : { duration: value.duration }),
    ...(value.size === undefined ? {} : { size: value.size }),
    ...(value.created === undefined ? {} : { created: value.created }),
    ...(value.modified === undefined ? {} : { modified: value.modified }),
    ...(value.uploaded === undefined ? {} : { uploaded: value.uploaded }),
  }
}

function isActiveTaskStatus(status: string): boolean {
  return status === 'pending' || status === 'in-stages'
}

async function settleTasks(
  db: ReturnType<typeof useDB>,
  taskIds: number[],
  status: 'completed' | 'failed',
  message?: string,
): Promise<void> {
  for (let offset = 0; offset < taskIds.length; offset += 80) {
    const ids = taskIds.slice(offset, offset + 80)
    if (ids.length === 0) continue

    await db
      .update(tables.pipelineQueue)
      .set({
        status,
        statusStage: null,
        errorMessage: message?.slice(0, 2000) ?? null,
        completedAt: new Date(),
        ...(status === 'failed'
          ? { attempts: sql`${tables.pipelineQueue.attempts} + 1` }
          : {}),
      })
      .where(
        and(
          inArray(tables.pipelineQueue.id, ids),
          or(
            eq(tables.pipelineQueue.status, 'pending'),
            eq(tables.pipelineQueue.status, 'in-stages'),
          ),
        ),
      )
  }
}

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const declaredLength = Number(getHeader(event, 'content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: 'Cloudflare Stream webhook body is too large',
    })
  }

  const rawBody = requestBytes(await readRawBody(event, false))
  if (rawBody.byteLength > MAX_WEBHOOK_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: 'Cloudflare Stream webhook body is too large',
    })
  }

  const secret = getCloudflareBindings().CFRAME_STREAM_WEBHOOK_SECRET
  if (typeof secret !== 'string' || secret.length < 16) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Cloudflare Stream webhook secret is not configured',
    })
  }

  try {
    await verifyStreamWebhookSignature({
      secret,
      signatureHeader: getHeader(event, 'webhook-signature'),
      body: rawBody,
    })
  } catch (error) {
    if (!(error instanceof InvalidStreamWebhookSignatureError)) throw error
    throw createError({
      statusCode: 401,
      statusMessage: 'Invalid Cloudflare Stream webhook signature',
    })
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(rawBody),
    )
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid Cloudflare Stream webhook JSON',
    })
  }

  const parsedWebhook = webhookSchema.safeParse(parsedJson)
  if (!parsedWebhook.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid Cloudflare Stream webhook payload',
    })
  }
  const webhook = parsedWebhook.data
  const meta = metadataStrings(webhook.meta)
  const metadataPhotoId = meta.photoId?.trim() || undefined
  const status = normalizedStatus(webhook)
  const state = status.state.toLowerCase()
  const isError = state === 'error' || state === 'failed'
  const isReady =
    state === 'ready' &&
    webhook.readyToStream === true &&
    Boolean(webhook.playback.hls)

  // Stream only sends terminal webhooks, but an unexpected non-terminal body
  // must never advance the D1 state machine.
  if (!isReady && !isError) {
    return { received: true, ignored: true, reason: 'non-terminal-status' }
  }

  const db = useDB(event)
  const uidOwner = await db
    .select({
      id: tables.photos.id,
      cloudflareStreamId: tables.photos.cloudflareStreamId,
    })
    .from(tables.photos)
    .where(eq(tables.photos.cloudflareStreamId, webhook.uid))
    .get()

  if (uidOwner && metadataPhotoId && uidOwner.id !== metadataPhotoId) {
    return { received: true, ignored: true, reason: 'photo-id-mismatch' }
  }

  const photo = metadataPhotoId
    ? await db
        .select({
          id: tables.photos.id,
          cloudflareStreamId: tables.photos.cloudflareStreamId,
        })
        .from(tables.photos)
        .where(eq(tables.photos.id, metadataPhotoId))
        .get()
    : uidOwner

  if (!photo) {
    return { received: true, ignored: true, reason: 'unassociated-video' }
  }

  const latestStreamTask = await db
    .select({
      id: tables.pipelineQueue.id,
      status: tables.pipelineQueue.status,
      payload: tables.pipelineQueue.payload,
    })
    .from(tables.pipelineQueue)
    .where(
      and(
        sql`json_extract(${tables.pipelineQueue.payload}, '$.type') = 'live-photo-video'`,
        sql`json_extract(${tables.pipelineQueue.payload}, '$.photoId') = ${photo.id}`,
      ),
    )
    .orderBy(desc(tables.pipelineQueue.id))
    .limit(1)
    .get()

  const latestPayload = latestStreamTask?.payload as
    | WorkersPipelinePayload
    | undefined
  const isCurrent = photo.cloudflareStreamId === webhook.uid
  const isExplicitLatestTask = Boolean(
    latestStreamTask &&
    isActiveTaskStatus(latestStreamTask.status) &&
    latestPayload?.type === 'live-photo-video' &&
    latestPayload.storageKey === webhook.uid &&
    latestPayload.photoId === photo.id &&
    Object.prototype.hasOwnProperty.call(
      latestPayload,
      'expectedCurrentStreamId',
    ) &&
    latestPayload.expectedCurrentStreamId === photo.cloudflareStreamId,
  )

  if (!isCurrent && !isExplicitLatestTask) {
    return { received: true, ignored: true, reason: 'stale-video' }
  }

  const taskCandidates = await db
    .select({
      id: tables.pipelineQueue.id,
      status: tables.pipelineQueue.status,
      payload: tables.pipelineQueue.payload,
    })
    .from(tables.pipelineQueue)
    .where(
      and(
        or(
          eq(tables.pipelineQueue.status, 'pending'),
          eq(tables.pipelineQueue.status, 'in-stages'),
        ),
        or(
          sql`json_extract(${tables.pipelineQueue.payload}, '$.storageKey') = ${webhook.uid}`,
          sql`json_extract(${tables.pipelineQueue.payload}, '$.storageKey') = ${photo.id}`,
        ),
      ),
    )
    .limit(100)

  const taskIds = taskCandidates
    .filter((task) => {
      const payload = task.payload as WorkersPipelinePayload
      if (payload.type === 'live-photo-video') {
        return (
          payload.storageKey === webhook.uid &&
          (payload.photoId === photo.id || (!payload.photoId && isCurrent))
        )
      }
      return (
        payload.type === 'photo' && isCurrent && payload.storageKey === photo.id
      )
    })
    .map((task) => task.id)

  const expectedCurrentStreamId = isCurrent
    ? webhook.uid
    : latestPayload?.type === 'live-photo-video'
      ? latestPayload.expectedCurrentStreamId
      : undefined
  const wasCurrent = isCurrent

  try {
    const result = await finalizeLivePhotoVideo(db, webhook.uid, {
      details: normalizedDetails(webhook, meta),
      photoId: photo.id,
      expectedCurrentStreamId,
      ...(isExplicitLatestTask && latestStreamTask
        ? { queueTaskId: latestStreamTask.id }
        : {}),
    })

    if (result.pending) {
      return { received: true, processed: false, status: 'processing' }
    }

    await settleTasks(db, taskIds, 'completed', result.warning)
    return {
      received: true,
      processed: true,
      status: 'completed',
      photoId: result.photoId ?? photo.id,
    }
  } catch (error) {
    if (error instanceof StaleStreamAssociationError) {
      return { received: true, ignored: true, reason: 'association-changed' }
    }

    if (!isError) throw error

    // A failed current candidate must have been atomically released before its
    // tasks are terminalized. For an off-record replacement no photo mutation
    // is required; the finalizer only cleans up that failed Stream asset.
    if (wasCurrent) {
      const current = await db
        .select({ cloudflareStreamId: tables.photos.cloudflareStreamId })
        .from(tables.photos)
        .where(eq(tables.photos.id, photo.id))
        .get()
      if (current?.cloudflareStreamId === webhook.uid) throw error
    }

    const message =
      error instanceof Error
        ? error.message
        : `Cloudflare Stream video ${webhook.uid} failed`
    await settleTasks(db, taskIds, 'failed', message)
    return {
      received: true,
      processed: true,
      status: 'failed',
      photoId: photo.id,
    }
  }
})
