import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'

import {
  extractLocationFromGPS,
  parseGPSCoordinates,
} from '../location/geocoding'
import { streamManifestPath } from '../../utils/photo-response'
import { hostedImages } from './hosted-images'
import { cloudflareStream, type StreamVideoDetails } from './stream'

export type WorkersPipelinePayload =
  | {
      type: 'photo'
      storageKey: string
      eraseLocation?: boolean
    }
  | {
      type: 'live-photo-video'
      storageKey: string
      photoId?: string
      expectedCurrentStreamId?: string | null
    }
  | {
      type: 'photo-reverse-geocoding'
      photoId: string
      latitude?: number | null
      longitude?: number | null
    }
  | {
      type: 'photo-erase-location'
      photoId: string
    }

export interface PipelineFinalizeResult {
  photoId?: string
  warning?: string
  pending?: boolean
}

export interface QueueFinalizeResult extends PipelineFinalizeResult {
  taskId: number
  status: 'in-stages' | 'completed' | 'failed'
  error?: string
}

const EXIF_LOCATION_KEYS = [
  'GPSLatitude',
  'GPSLatitudeRef',
  'GPSLongitude',
  'GPSLongitudeRef',
  'GPSPosition',
  'GPSCoordinates',
  'GPSAltitude',
  'GPSAltitudeRef',
  'GPSDateStamp',
  'GPSTimeStamp',
  'GPSImgDirection',
  'GPSImgDirectionRef',
  'GPSDestBearing',
  'GPSDestBearingRef',
] as const

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object'
    ? (value as Record<string, any>)
    : {}
}

function metadataFrom(value: unknown): Record<string, string> {
  const item = record(value)
  return record(item.metadata ?? item.meta ?? item.customMetadata)
}

function metadataValue(
  metadata: Record<string, string>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === 'string' && value.length > 0) return value

    const lowerKey = key.toLowerCase()
    const matchingKey = Object.keys(metadata).find(
      (candidate) => candidate.toLowerCase() === lowerKey,
    )
    if (matchingKey && metadata[matchingKey]) return metadata[matchingKey]
  }
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function streamAssociationCondition(
  photoId: string,
  observedStreamId: string | null,
  queueTaskId?: number,
) {
  return and(
    eq(tables.photos.id, photoId),
    observedStreamId === null
      ? isNull(tables.photos.cloudflareStreamId)
      : eq(tables.photos.cloudflareStreamId, observedStreamId),
    queueTaskId === undefined
      ? undefined
      : sql`NOT EXISTS (
          SELECT 1
          FROM ${tables.pipelineQueue}
          WHERE ${tables.pipelineQueue.id} > ${queueTaskId}
            AND json_extract(${tables.pipelineQueue.payload}, '$.type') = 'live-photo-video'
            AND json_extract(${tables.pipelineQueue.payload}, '$.photoId') = ${photoId}
        )`,
  )
}

async function readPhotoStreamAssociation(
  db: ReturnType<typeof useDB>,
  photoId: string,
) {
  return db
    .select({
      cloudflareStreamId: tables.photos.cloudflareStreamId,
      streamStatus: tables.photos.streamStatus,
      isLivePhoto: tables.photos.isLivePhoto,
      livePhotoVideoKey: tables.photos.livePhotoVideoKey,
      livePhotoVideoUrl: tables.photos.livePhotoVideoUrl,
    })
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()
}

async function deleteStreamBestEffort(
  streamId: string,
): Promise<string | null> {
  try {
    await cloudflareStream.delete(streamId)
    return null
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'unknown Stream delete error'
  }
}

export function sourceBasename(filename: string): string {
  const normalized = filename.replaceAll('\\', '/')
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
  const extensionIndex = basename.lastIndexOf('.')
  return extensionIndex > 0 ? basename.slice(0, extensionIndex) : basename
}

export function hostedImageUrl(imageId: string, thumbnail = false): string {
  const suffix = thumbnail ? '/thumbnail' : ''
  return `/media/images/${encodeURIComponent(imageId)}${suffix}`
}

async function finalizePhoto(
  db: ReturnType<typeof useDB>,
  storageKey: string,
  eraseLocation = false,
): Promise<PipelineFinalizeResult> {
  const details = await hostedImages.details(storageKey)
  if (!details) {
    throw new Error(`Hosted Image ${storageKey} was not found`)
  }

  const item = record(details)
  if (item.draft === true) {
    throw new Error(`Hosted Image ${storageKey} has not finished uploading`)
  }

  const metadata = metadataFrom(details)
  const info = record(item.info)
  const imageId = String(item.id ?? storageKey)
  const sourceFilename =
    metadataValue(metadata, 'sourceFilename', 'filename') ?? imageId
  const sourceMimeType =
    metadataValue(metadata, 'sourceMimeType', 'contentType') ??
    (typeof item.contentType === 'string' ? item.contentType : null)
  const sourceSize =
    finiteNumber(metadataValue(metadata, 'sourceSize', 'size')) ??
    finiteNumber(item.fileSize ?? item.size ?? info.fileSize)
  const width = finiteNumber(item.width ?? info.width)
  const height = finiteNumber(item.height ?? info.height)
  const lastModified =
    typeof item.uploaded === 'string' ? item.uploaded : new Date().toISOString()
  const dateTaken =
    metadataValue(metadata, 'dateTaken', 'lastModified') ?? lastModified

  const existing = await db
    .select({
      exif: tables.photos.exif,
      dateTaken: tables.photos.dateTaken,
    })
    .from(tables.photos)
    .where(eq(tables.photos.id, imageId))
    .get()

  const exif = record(existing?.exif)
  const sanitizedExif = eraseLocation
    ? Object.fromEntries(
        Object.entries(exif).filter(
          ([key]) => !EXIF_LOCATION_KEYS.includes(key as any),
        ),
      )
    : exif

  const values = {
    id: imageId,
    cloudflareImageId: imageId,
    title: sourceBasename(sourceFilename),
    width,
    height,
    aspectRatio: width && height ? width / height : null,
    storageKey: imageId,
    thumbnailKey: null,
    fileSize: sourceSize,
    sourceFilename,
    sourceMimeType,
    sourceSize,
    dateTaken,
    lastModified,
    originalUrl: hostedImageUrl(imageId),
    thumbnailUrl: hostedImageUrl(imageId, true),
    tags: [],
    exif: sanitizedExif,
    ...(eraseLocation
      ? {
          latitude: null,
          longitude: null,
          country: null,
          city: null,
          locationName: null,
        }
      : {}),
  }

  await db
    .insert(tables.photos)
    .values(values)
    .onConflictDoUpdate({
      target: tables.photos.id,
      set: {
        cloudflareImageId: imageId,
        width,
        height,
        aspectRatio: width && height ? width / height : null,
        storageKey: imageId,
        thumbnailKey: null,
        fileSize: sourceSize,
        sourceFilename,
        sourceMimeType,
        sourceSize,
        dateTaken: existing?.dateTaken ?? dateTaken,
        lastModified,
        originalUrl: hostedImageUrl(imageId),
        thumbnailUrl: hostedImageUrl(imageId, true),
        ...(eraseLocation
          ? {
              exif: sanitizedExif,
              latitude: null,
              longitude: null,
              country: null,
              city: null,
              locationName: null,
            }
          : {}),
      },
    })

  const baseResult: PipelineFinalizeResult = {
    photoId: imageId,
    ...(eraseLocation
      ? {
          warning:
            'Location was removed from the D1 record, but the original Hosted Image binary was not rewritten. Remove sensitive EXIF data before upload when binary erasure is required.',
        }
      : {}),
  }

  const uploadIntent = await db
    .select({
      id: tables.imageUploadIntents.id,
      imageId: tables.imageUploadIntents.imageId,
      embeddedStreamId: tables.imageUploadIntents.embeddedStreamId,
      status: tables.imageUploadIntents.status,
    })
    .from(tables.imageUploadIntents)
    .where(eq(tables.imageUploadIntents.imageId, imageId))
    .get()

  if (uploadIntent) {
    const finalizedAt = new Date()
    await db
      .update(tables.imageUploadIntents)
      .set({
        status: 'finalized',
        finalizedAt,
        updatedAt: finalizedAt,
      })
      .where(
        and(
          eq(tables.imageUploadIntents.id, uploadIntent.id),
          eq(tables.imageUploadIntents.imageId, imageId),
          inArray(tables.imageUploadIntents.status, ['uploaded', 'finalized']),
        ),
      )
      .run()
  }

  // Embedded Motion Photo video is extracted before the static JPEG reaches
  // Hosted Images. D1 is authoritative; Hosted metadata is the crash-recovery
  // fallback. Finalization only attaches/polls the already-uploaded Stream.
  const embeddedStreamId =
    uploadIntent?.embeddedStreamId ??
    metadataValue(metadata, 'embeddedStreamId')
  let persisted = await readPhotoStreamAssociation(db, imageId)

  if (!persisted?.cloudflareStreamId && embeddedStreamId) {
    const claimed = await db
      .update(tables.photos)
      .set({
        cloudflareStreamId: embeddedStreamId,
        streamStatus: 'pending',
      })
      .where(streamAssociationCondition(imageId, null))
      .returning({ id: tables.photos.id })
      .get()
    persisted = await readPhotoStreamAssociation(db, imageId)

    if (!claimed && persisted?.cloudflareStreamId !== embeddedStreamId) {
      const cleanupError = await deleteStreamBestEffort(embeddedStreamId)
      if (!cleanupError && uploadIntent) {
        await db
          .update(tables.imageUploadIntents)
          .set({ embeddedStreamId: null, updatedAt: new Date() })
          .where(
            and(
              eq(tables.imageUploadIntents.id, uploadIntent.id),
              eq(tables.imageUploadIntents.embeddedStreamId, embeddedStreamId),
            ),
          )
          .run()
      }
      baseResult.warning = [
        baseResult.warning,
        `Embedded Stream ${embeddedStreamId} lost the photo association CAS${cleanupError ? ` and cleanup failed: ${cleanupError}` : ' and was discarded'}.`,
      ]
        .filter(Boolean)
        .join(' ')
    }
  }

  if (persisted?.cloudflareStreamId) {
    if (
      persisted.streamStatus === 'ready' &&
      persisted.isLivePhoto === 1 &&
      persisted.livePhotoVideoUrl
    ) {
      return baseResult
    }

    const streamResult = await finalizeLivePhotoVideo(
      db,
      persisted.cloudflareStreamId,
      { photoId: imageId },
    )
    return {
      ...streamResult,
      warning:
        [baseResult.warning, streamResult.warning].filter(Boolean).join(' ') ||
        undefined,
    }
  }
  return baseResult
}

async function findPhotoForSourceFilename(
  db: ReturnType<typeof useDB>,
  sourceFilename: string,
) {
  const basename = sourceBasename(sourceFilename).toLowerCase()

  const candidates = await db
    .select({
      id: tables.photos.id,
      title: tables.photos.title,
      sourceFilename: tables.photos.sourceFilename,
      isLivePhoto: tables.photos.isLivePhoto,
      cloudflareStreamId: tables.photos.cloudflareStreamId,
      livePhotoVideoKey: tables.photos.livePhotoVideoKey,
      livePhotoVideoUrl: tables.photos.livePhotoVideoUrl,
    })
    .from(tables.photos)
    .where(
      or(
        sql`lower(${tables.photos.title}) = ${basename}`,
        // Avoid SQLite LIKE patterns here: D1 caps them at 50 bytes and
        // filenames may legitimately contain '%' or '_'. Compare a bounded
        // basename-plus-dot prefix instead, then retain the exact JS filter
        // below for extension and legacy-record edge cases.
        sql`substr(lower(${tables.photos.sourceFilename}), 1, length(${basename}) + 1) = ${`${basename}.`}`,
      ),
    )
    .limit(50)

  const matches = candidates.filter((candidate) => {
    if (candidate.sourceFilename) {
      return sourceBasename(candidate.sourceFilename).toLowerCase() === basename
    }
    return candidate.title?.toLowerCase() === basename
  })

  if (matches.length > 1) {
    throw new Error(
      `Multiple photos match video source basename ${sourceBasename(sourceFilename)}`,
    )
  }
  return matches[0]
}

export interface FinalizeLivePhotoVideoOptions {
  details?: StreamVideoDetails
  photoId?: string
  queueTaskId?: number
  /**
   * Optional optimistic association captured when the Stream upload intent was
   * created. Webhooks and queued replacements use it to prevent a stale UID
   * from replacing a newer video.
   */
  expectedCurrentStreamId?: string | null
}

export class StaleStreamAssociationError extends Error {
  constructor(streamId: string, photoId: string) {
    super(
      `Cloudflare Stream video ${streamId} is no longer the expected candidate for photo ${photoId}`,
    )
    this.name = 'StaleStreamAssociationError'
  }
}

export async function finalizeLivePhotoVideo(
  db: ReturnType<typeof useDB>,
  storageKey: string,
  options: FinalizeLivePhotoVideoOptions = {},
): Promise<PipelineFinalizeResult> {
  if (options.photoId && options.queueTaskId !== undefined) {
    const latest = await db
      .select({ id: tables.pipelineQueue.id })
      .from(tables.pipelineQueue)
      .where(
        and(
          sql`json_extract(${tables.pipelineQueue.payload}, '$.type') = 'live-photo-video'`,
          sql`json_extract(${tables.pipelineQueue.payload}, '$.photoId') = ${options.photoId}`,
        ),
      )
      .orderBy(sql`${tables.pipelineQueue.id} DESC`)
      .limit(1)
      .get()

    if (latest && latest.id !== options.queueTaskId) {
      const current = await readPhotoStreamAssociation(db, options.photoId)
      const cleanupError =
        current?.cloudflareStreamId === storageKey
          ? null
          : await deleteStreamBestEffort(storageKey)
      return {
        photoId: options.photoId,
        warning: `Cloudflare Stream task ${options.queueTaskId} was superseded by task ${latest.id}; candidate ${storageKey} was discarded${cleanupError ? ` but cleanup failed: ${cleanupError}` : ''}`,
      }
    }
  }

  let details = options.details
  if (!details) {
    try {
      details = await cloudflareStream.details(storageKey)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Cloudflare Stream details are temporarily unavailable'

      // A management API failure does not say anything about the terminal
      // encoding state. Keep the ledger pollable so a later stats request can
      // refresh it instead of permanently failing an otherwise valid upload.
      return {
        pending: true,
        warning: `Unable to refresh Cloudflare Stream video ${storageKey}: ${message}`,
      }
    }
  }

  const item = record(details)
  const metadata = metadataFrom(details)
  const sourceFilename = metadataValue(metadata, 'sourceFilename', 'filename')
  const metadataPhotoId = metadataValue(metadata, 'photoId')

  if (!sourceFilename) {
    throw new Error(
      `Cloudflare Stream video ${storageKey} is missing sourceFilename metadata`,
    )
  }

  const contentType =
    metadataValue(metadata, 'sourceMimeType', 'contentType') ??
    record(item.httpMetadata).contentType
  if (
    contentType &&
    typeof contentType === 'string' &&
    !contentType.toLowerCase().startsWith('video/')
  ) {
    throw new Error(
      `Cloudflare Stream asset ${storageKey} is not a video (${contentType})`,
    )
  }

  // New uploads carry an immutable D1 relationship in Stream metadata. Keep
  // the basename lookup only as a migration fallback for legacy Stream assets.
  const targetPhotoId = metadataPhotoId ?? options.photoId
  const photo = targetPhotoId
    ? await db
        .select({
          id: tables.photos.id,
          title: tables.photos.title,
          sourceFilename: tables.photos.sourceFilename,
          isLivePhoto: tables.photos.isLivePhoto,
          cloudflareStreamId: tables.photos.cloudflareStreamId,
          streamStatus: tables.photos.streamStatus,
          livePhotoVideoKey: tables.photos.livePhotoVideoKey,
          livePhotoVideoUrl: tables.photos.livePhotoVideoUrl,
        })
        .from(tables.photos)
        .where(eq(tables.photos.id, targetPhotoId))
        .get()
    : await findPhotoForSourceFilename(db, sourceFilename)
  if (!photo) {
    throw new Error(
      targetPhotoId
        ? `Photo ${targetPhotoId} was not found`
        : `No photo matches video source basename ${sourceBasename(sourceFilename)}`,
    )
  }

  const photoSource =
    photo.sourceFilename?.trim() || photo.title?.trim() || photo.id
  const photoBasename = sourceBasename(photoSource).toLowerCase()
  const videoBasename = sourceBasename(sourceFilename).toLowerCase()
  if (photoBasename !== videoBasename) {
    throw new Error(
      `Photo ${photo.id} does not match video source basename ${sourceBasename(sourceFilename)}`,
    )
  }

  const streamId = String(item.id ?? item.uid ?? storageKey)
  const hasExpectedAssociation = Object.prototype.hasOwnProperty.call(
    options,
    'expectedCurrentStreamId',
  )
  if (
    photo.cloudflareStreamId !== streamId &&
    ((hasExpectedAssociation &&
      photo.cloudflareStreamId !== options.expectedCurrentStreamId) ||
      (!hasExpectedAssociation && photo.cloudflareStreamId !== null))
  ) {
    // Idempotent refreshes of the already-current UID are always safe. Any
    // actual replacement must carry the exact predecessor captured when its
    // durable task was created; legacy/history scans cannot roll video state
    // backward merely because their asset is ready.
    throw new StaleStreamAssociationError(streamId, photo.id)
  }
  const statusDetails = record(item.status)
  const reportedStatus =
    typeof item.status === 'string'
      ? item.status
      : typeof statusDetails.state === 'string'
        ? statusDetails.state
        : 'processing'
  const playback = record(item.playback)
  const hlsUrl =
    typeof playback.hls === 'string' && playback.hls ? playback.hls : null
  const thumbnailUrl =
    typeof item.thumbnail === 'string' && item.thumbnail ? item.thumbnail : null
  const duration = finiteNumber(item.duration)
  const normalizedStatus = reportedStatus.toLowerCase()
  const streamFailed =
    normalizedStatus === 'error' || normalizedStatus === 'failed'
  const streamReady =
    !streamFailed && item.readyToStream === true && Boolean(hlsUrl)
  const streamStatus = streamReady ? 'ready' : reportedStatus
  const observedStreamId = photo.cloudflareStreamId ?? null
  const hasExistingPlayback = Boolean(
    photo.isLivePhoto && photo.livePhotoVideoUrl,
  )

  if (streamFailed) {
    const reason =
      typeof statusDetails.errorReasonText === 'string'
        ? `: ${statusDetails.errorReasonText}`
        : ''

    // Remove a terminally failed candidate only after either proving that it
    // is not the current association, or atomically releasing that exact ID.
    const current = await readPhotoStreamAssociation(db, photo.id)
    let mayDeleteCandidate = current?.cloudflareStreamId !== streamId
    if (current?.cloudflareStreamId === streamId) {
      const clearsCurrentPlayback = current.livePhotoVideoKey === streamId
      const released = await db
        .update(tables.photos)
        .set({
          cloudflareStreamId: null,
          streamStatus: 'failed',
          ...(clearsCurrentPlayback
            ? {
                isLivePhoto: 0,
                livePhotoVideoKey: null,
                livePhotoVideoUrl: null,
                streamThumbnailUrl: null,
                streamDashUrl: null,
                streamDuration: null,
              }
            : {}),
        })
        .where(
          streamAssociationCondition(photo.id, streamId, options.queueTaskId),
        )
        .returning({ id: tables.photos.id })
        .get()
      mayDeleteCandidate = Boolean(released)
      if (!released) {
        const refreshed = await readPhotoStreamAssociation(db, photo.id)
        mayDeleteCandidate = refreshed?.cloudflareStreamId !== streamId
      }
    }

    const cleanupError = mayDeleteCandidate
      ? await deleteStreamBestEffort(streamId)
      : null
    throw new Error(
      `Cloudflare Stream video ${streamId} failed${reason}${cleanupError ? `; failed candidate cleanup also failed: ${cleanupError}` : ''}`,
    )
  }

  if (!streamReady) {
    // A replacement remains off-record while the known-good video is still
    // playable. When it becomes ready, promotion below CASes from the exact ID
    // observed here. New videos without an association atomically claim it.
    if (observedStreamId === null || observedStreamId === streamId) {
      const attached = await db
        .update(tables.photos)
        .set({
          cloudflareStreamId: streamId,
          streamStatus,
          streamThumbnailUrl: thumbnailUrl,
          streamDashUrl: null,
          streamDuration: duration,
          ...(!hasExistingPlayback
            ? {
                isLivePhoto: 0,
                livePhotoVideoUrl: null,
              }
            : {}),
        })
        .where(
          streamAssociationCondition(
            photo.id,
            observedStreamId,
            options.queueTaskId,
          ),
        )
        .returning({ id: tables.photos.id })
        .get()

      if (!attached) {
        const current = await readPhotoStreamAssociation(db, photo.id)
        if (current?.cloudflareStreamId !== streamId) {
          const cleanupError = await deleteStreamBestEffort(streamId)
          return {
            photoId: photo.id,
            warning: `Cloudflare Stream candidate ${streamId} lost the D1 pending-state CAS and was discarded${cleanupError ? `; cleanup failed: ${cleanupError}` : ''}`,
          }
        }
      }
    }

    return {
      photoId: photo.id,
      pending: true,
      warning:
        observedStreamId && observedStreamId !== streamId
          ? `Cloudflare Stream replacement ${streamId} is still ${streamStatus}; existing playback remains active`
          : `Cloudflare Stream video ${streamId} is still ${streamStatus}`,
    }
  }

  const promoted = await db
    .update(tables.photos)
    .set({
      isLivePhoto: 1,
      cloudflareStreamId: streamId,
      livePhotoVideoKey: streamId,
      livePhotoVideoUrl: streamManifestPath(photo.id),
      streamStatus: 'ready',
      streamThumbnailUrl: thumbnailUrl,
      streamDashUrl: null,
      streamDuration: duration,
    })
    .where(
      streamAssociationCondition(
        photo.id,
        observedStreamId,
        options.queueTaskId,
      ),
    )
    .returning({ id: tables.photos.id })
    .get()

  if (!promoted) {
    const current = await readPhotoStreamAssociation(db, photo.id)
    if (current?.cloudflareStreamId === streamId) {
      return { photoId: photo.id }
    }

    const cleanupError = await deleteStreamBestEffort(streamId)
    return {
      photoId: photo.id,
      warning: `Ready Cloudflare Stream candidate ${streamId} lost the D1 promotion CAS and was discarded${cleanupError ? `; cleanup failed: ${cleanupError}` : ''}`,
    }
  }

  let warning: string | undefined
  if (observedStreamId && observedStreamId !== streamId) {
    const cleanupError = await deleteStreamBestEffort(observedStreamId)
    if (cleanupError) {
      warning = `New Stream video is ready, but old video ${observedStreamId} could not be deleted: ${cleanupError}`
    }
  }
  return { photoId: photo.id, warning }
}

async function reverseGeocodePhoto(
  db: ReturnType<typeof useDB>,
  payload: Extract<WorkersPipelinePayload, { type: 'photo-reverse-geocoding' }>,
): Promise<PipelineFinalizeResult> {
  const photo = await db
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, payload.photoId))
    .get()

  if (!photo) throw new Error(`Photo ${payload.photoId} was not found`)

  const parsedCoordinates = parseGPSCoordinates(photo.exif)
  const latitude =
    payload.latitude ?? photo.latitude ?? parsedCoordinates.latitude
  const longitude =
    payload.longitude ?? photo.longitude ?? parsedCoordinates.longitude

  if (latitude == null || longitude == null) {
    throw new Error(`Photo ${payload.photoId} has no GPS coordinates`)
  }

  const location = await extractLocationFromGPS(latitude, longitude)
  if (!location) {
    throw new Error(`Reverse geocoding failed for photo ${payload.photoId}`)
  }

  await db
    .update(tables.photos)
    .set({
      latitude,
      longitude,
      country: location.country ?? null,
      city: location.city ?? null,
      locationName: location.locationName ?? null,
    })
    .where(eq(tables.photos.id, payload.photoId))

  return { photoId: payload.photoId }
}

async function eraseLocationRecord(
  db: ReturnType<typeof useDB>,
  photoId: string,
): Promise<PipelineFinalizeResult> {
  const photo = await db
    .select({ id: tables.photos.id, exif: tables.photos.exif })
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()

  if (!photo) throw new Error(`Photo ${photoId} was not found`)

  const exif = record(photo.exif)
  for (const key of EXIF_LOCATION_KEYS) delete exif[key]

  await db
    .update(tables.photos)
    .set({
      exif,
      latitude: null,
      longitude: null,
      country: null,
      city: null,
      locationName: null,
      lastModified: new Date().toISOString(),
    })
    .where(eq(tables.photos.id, photoId))

  return {
    photoId,
    warning:
      'Location was removed from the D1 record. Cloudflare Workers cannot rewrite the original Hosted Image binary; pre-sanitize the image when irreversible EXIF removal is required.',
  }
}

async function processPayload(
  db: ReturnType<typeof useDB>,
  payload: WorkersPipelinePayload,
  queueTaskId?: number,
): Promise<PipelineFinalizeResult> {
  switch (payload.type) {
    case 'photo':
      return finalizePhoto(db, payload.storageKey, payload.eraseLocation)
    case 'live-photo-video':
      return finalizeLivePhotoVideo(db, payload.storageKey, {
        photoId: payload.photoId,
        queueTaskId,
        ...(Object.prototype.hasOwnProperty.call(
          payload,
          'expectedCurrentStreamId',
        )
          ? { expectedCurrentStreamId: payload.expectedCurrentStreamId }
          : {}),
      })
    case 'photo-reverse-geocoding':
      return reverseGeocodePhoto(db, payload)
    case 'photo-erase-location':
      return eraseLocationRecord(db, payload.photoId)
  }
}

function stageForPayload(payload: WorkersPipelinePayload) {
  switch (payload.type) {
    case 'photo':
      return 'metadata' as const
    case 'live-photo-video':
      return 'live-photo' as const
    case 'photo-reverse-geocoding':
      return 'reverse-geocoding' as const
    case 'photo-erase-location':
      return 'location-erase' as const
  }
}

export async function finalizeExistingQueueTask(
  taskId: number,
  payload: WorkersPipelinePayload,
): Promise<QueueFinalizeResult> {
  const db = useDB()

  const claimed = await db
    .update(tables.pipelineQueue)
    .set({
      status: 'in-stages',
      statusStage: stageForPayload(payload),
      errorMessage: null,
      completedAt: null,
    })
    .where(
      and(
        eq(tables.pipelineQueue.id, taskId),
        or(
          eq(tables.pipelineQueue.status, 'pending'),
          eq(tables.pipelineQueue.status, 'in-stages'),
        ),
      ),
    )
    .returning({ id: tables.pipelineQueue.id })
    .get()

  if (!claimed) {
    const settled = await db
      .select({
        status: tables.pipelineQueue.status,
        errorMessage: tables.pipelineQueue.errorMessage,
      })
      .from(tables.pipelineQueue)
      .where(eq(tables.pipelineQueue.id, taskId))
      .get()

    if (settled?.status === 'completed') {
      return {
        taskId,
        status: 'completed',
        warning: settled.errorMessage ?? undefined,
      }
    }
    if (settled?.status === 'failed') {
      return {
        taskId,
        status: 'failed',
        error: settled.errorMessage ?? 'Task failed',
      }
    }
    throw new Error(`Queue task ${taskId} was not found`)
  }

  try {
    const result = await processPayload(db, payload, taskId)
    if (result.pending) {
      // Keep asynchronous Stream encoding in a non-terminal state. The task
      // stats endpoint will call this finalizer again on the next client poll.
      await db
        .update(tables.pipelineQueue)
        .set({
          status: 'in-stages',
          statusStage:
            payload.type === 'photo'
              ? ('motion-photo' as const)
              : stageForPayload(payload),
          errorMessage: null,
          completedAt: null,
        })
        .where(
          and(
            eq(tables.pipelineQueue.id, taskId),
            or(
              eq(tables.pipelineQueue.status, 'pending'),
              eq(tables.pipelineQueue.status, 'in-stages'),
            ),
          ),
        )

      return { taskId, status: 'in-stages', ...result }
    }

    await db
      .update(tables.pipelineQueue)
      .set({
        status: 'completed',
        statusStage: null,
        errorMessage: result.warning ?? null,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(tables.pipelineQueue.id, taskId),
          or(
            eq(tables.pipelineQueue.status, 'pending'),
            eq(tables.pipelineQueue.status, 'in-stages'),
          ),
        ),
      )

    return { taskId, status: 'completed', ...result }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown upload finalization error'

    await db
      .update(tables.pipelineQueue)
      .set({
        status: 'failed',
        statusStage: null,
        errorMessage: message.slice(0, 2000),
        attempts: sql`${tables.pipelineQueue.attempts} + 1`,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(tables.pipelineQueue.id, taskId),
          or(
            eq(tables.pipelineQueue.status, 'pending'),
            eq(tables.pipelineQueue.status, 'in-stages'),
          ),
        ),
      )

    return { taskId, status: 'failed', error: message }
  }
}

export async function createAndFinalizeQueueTask(
  payload: WorkersPipelinePayload,
  options: { priority?: number; maxAttempts?: number } = {},
): Promise<QueueFinalizeResult> {
  const db = useDB()
  const inserted = await db
    .insert(tables.pipelineQueue)
    .values({
      payload,
      priority: options.priority ?? 0,
      maxAttempts: options.maxAttempts ?? 3,
      status: 'pending',
    })
    .returning({ id: tables.pipelineQueue.id })
    .get()

  if (!inserted?.id) throw new Error('Failed to create D1 queue ledger entry')

  return finalizeExistingQueueTask(inserted.id, payload)
}
