import { eq, or } from 'drizzle-orm'
import { z } from 'zod'
import {
  HOSTED_IMAGE_MAX_BYTES,
  MOTION_PHOTO_SOURCE_MAX_BYTES,
} from '~~/server/services/cloudflare/hosted-images'
import { classifyMedia } from '~~/server/services/cloudflare/media-classification'
import { cloudflareStream } from '~~/server/services/cloudflare/stream'
import { createPendingStreamUploadTask } from '~~/server/services/cloudflare/stream-upload-task'
import { generateSafePhotoId } from '~~/server/utils/file-utils'
import { settingsManager } from '~~/server/services/settings/settingsManager'

// Cloudflare Stream's basic multipart direct-upload contract is strictly
// smaller than 200 decimal megabytes. Larger files require tus.
const STREAM_DIRECT_UPLOAD_MAX_BYTES = 200_000_000 - 1

type UploadKind = 'image' | 'stream-video'

const declaredSizeSchema = z.union([z.number(), z.string()]).nullish()
const bodySchema = z.object({
  fileName: z.string(),
  contentType: z.string().nullish(),
  fileSize: declaredSizeSchema.optional(),
  size: declaredSizeSchema.optional(),
  photoId: z.string().trim().min(1).optional(),
  lastModified: z.string().datetime({ offset: true }).optional(),
  eraseLocation: z.boolean().optional().default(false),
  skipDuplicateCheck: z.boolean().optional(),
})

const normalizeFileName = (fileName: string): string => {
  const normalized = fileName.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() || ''
}

const sourceBasename = (fileName: string): string => {
  const leafName = normalizeFileName(fileName)
  const extensionIndex = leafName.lastIndexOf('.')
  return extensionIndex > 0 ? leafName.slice(0, extensionIndex) : leafName
}

const parseDeclaredSize = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined
  }

  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.NaN
}

export default eventHandler(async (event) => {
  const session = await requireAdminSession(event)
  const t = await useTranslation(event)
  const config = useRuntimeConfig(event)

  const body = await readValidatedBody(event, bodySchema.parse)
  const rawFileName = body.fileName
  const skipDuplicateCheck = Boolean(body.skipDuplicateCheck)
  const declaredSize = parseDeclaredSize(body.fileSize ?? body.size)

  if (typeof rawFileName !== 'string' || !rawFileName.trim()) {
    throw createError({
      statusCode: 400,
      statusMessage: t('upload.error.required.title'),
    })
  }

  if (Number.isNaN(declaredSize)) {
    throw createError({
      statusCode: 400,
      statusMessage: t('upload.error.required.title'),
      data: {
        title: t('upload.error.required.title'),
        message: t('upload.error.required.message', { field: 'fileSize' }),
      },
    })
  }

  const fileName = normalizeFileName(rawFileName.trim())
  if (!fileName) {
    throw createError({
      statusCode: 400,
      statusMessage: t('upload.error.required.title'),
    })
  }

  const media = classifyMedia(fileName, body.contentType)
  const contentType = media.contentType
  if (media.kind === 'object') {
    throw createError({
      statusCode: 415,
      statusMessage:
        'Non-image objects must be uploaded through the /api/objects catalog',
    })
  }

  const uploadKind: UploadKind =
    media.kind === 'video' ? 'stream-video' : 'image'

  if (declaredSize !== undefined) {
    const cloudflareConfig = config.public.cloudflare
    const maxBytes =
      uploadKind === 'stream-video'
        ? Math.min(
            cloudflareConfig.stream.maxUploadBytes,
            STREAM_DIRECT_UPLOAD_MAX_BYTES,
          )
        : contentType === 'image/jpeg'
          ? MOTION_PHOTO_SOURCE_MAX_BYTES
          : Math.min(
              cloudflareConfig.images.maxUploadBytes,
              HOSTED_IMAGE_MAX_BYTES,
            )
    const maxFileSizeMB = maxBytes / 1024 / 1024

    if (declaredSize > maxBytes) {
      throw createError({
        statusCode: 413,
        statusMessage: t('upload.error.tooLarge.title'),
        data: {
          title: t('upload.error.tooLarge.title'),
          message: t('upload.error.tooLarge.message', {
            size: (declaredSize / 1024 / 1024).toFixed(2),
          }),
          suggestion: t('upload.error.tooLarge.suggestion', {
            maxSize: maxFileSizeMB,
          }),
        },
      })
    }
  }

  try {
    // Keep the legacy filename lookup so pre-migration duplicates continue to
    // work, and use sourceFilename for records finalized through Hosted Images.
    const duplicateCheckEnabled =
      ((await settingsManager.get<boolean>(
        'system',
        'upload.duplicateCheck.enabled',
      )) ??
        true) &&
      !skipDuplicateCheck
    let existingPhoto = null

    if (duplicateCheckEnabled && uploadKind === 'image') {
      const legacyPhotoId = generateSafePhotoId(fileName)
      const db = useDB()
      const duplicateCondition = or(
        eq(tables.photos.id, legacyPhotoId),
        eq(tables.photos.sourceFilename, fileName),
      )

      existingPhoto = await db
        .select({
          id: tables.photos.id,
          title: tables.photos.title,
          storageKey: tables.photos.storageKey,
          originalUrl: tables.photos.originalUrl,
          thumbnailUrl: tables.photos.thumbnailUrl,
          dateTaken: tables.photos.dateTaken,
          cloudflareImageId: tables.photos.cloudflareImageId,
        })
        .from(tables.photos)
        .where(duplicateCondition)
        .get()

      if (existingPhoto) {
        const checkMode =
          (await settingsManager.get<'warn' | 'block' | 'skip'>(
            'system',
            'upload.duplicateCheck.mode',
          )) ?? 'skip'

        if (checkMode === 'block') {
          throw createError({
            statusCode: 409,
            statusMessage: t('upload.duplicate.block.title'),
            data: {
              duplicate: true,
              existingPhoto,
              title: t('upload.duplicate.block.title'),
              message: t('upload.duplicate.block.message', { fileName }),
            },
          })
        }

        if (checkMode === 'skip') {
          return {
            skipped: true,
            duplicate: true,
            existingPhoto,
            fileKey: null,
            title: t('upload.duplicate.skip.title'),
            message: t('upload.duplicate.skip.message', { fileName }),
            info: t('upload.duplicate.skip.info', {
              dateTaken:
                existingPhoto.dateTaken || t('common.unknown', 'unknown date'),
            }),
          }
        }
      }
    }

    if (uploadKind === 'stream-video') {
      if (!body.photoId) {
        throw createError({
          statusCode: 400,
          statusMessage: 'photoId is required for Cloudflare Stream uploads',
        })
      }

      // Resolve and validate the relationship before requesting a one-time
      // Stream upload URL. This ensures an unpaired video never creates an
      // orphaned Cloudflare Stream asset.
      const db = useDB()
      const photo = await db
        .select({
          id: tables.photos.id,
          title: tables.photos.title,
          sourceFilename: tables.photos.sourceFilename,
          cloudflareStreamId: tables.photos.cloudflareStreamId,
        })
        .from(tables.photos)
        .where(eq(tables.photos.id, body.photoId))
        .get()

      if (!photo) {
        throw createError({
          statusCode: 404,
          statusMessage: `Photo ${body.photoId} was not found`,
        })
      }

      const photoSource = photo.sourceFilename?.trim() || photo.title?.trim()
      const photoBasename = photoSource
        ? sourceBasename(photoSource).toLowerCase()
        : ''
      const videoBasename = sourceBasename(fileName).toLowerCase()
      if (!photoBasename || photoBasename !== videoBasename) {
        throw createError({
          statusCode: 409,
          statusMessage: `Video ${fileName} does not match photo ${photo.id}`,
        })
      }

      const directUpload = await cloudflareStream.createDirectUpload({
        maxDurationSeconds: Number(config.cloudflare.stream.maxDurationSeconds),
        expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        meta: {
          photoId: photo.id,
          sourceFilename: fileName,
          sourceMimeType: contentType,
          sourceSize: String(declaredSize ?? 'unknown'),
          expectedCurrentStreamId: photo.cloudflareStreamId ?? '',
        },
        requireSignedURLs: true,
      })

      const taskId = await createPendingStreamUploadTask(db, {
        streamId: directUpload.id,
        photoId: photo.id,
        expectedCurrentStreamId: photo.cloudflareStreamId,
      })

      return {
        signedUrl: directUpload.uploadURL,
        uploadURL: directUpload.uploadURL,
        fileKey: directUpload.id,
        expiresIn: 3600,
        uploadKind,
        uploadMethod: 'POST',
        uploadEncoding: 'multipart',
        taskId,
      }
    }

    if (declaredSize === undefined) {
      throw createError({
        statusCode: 400,
        statusMessage: t('upload.error.required.title'),
        data: {
          title: t('upload.error.required.title'),
          message: t('upload.error.required.message', { field: 'fileSize' }),
        },
      })
    }

    // Persist every immutable upload field in D1. The raw PUT URL carries
    // only an opaque intent token, so query-string tampering cannot change
    // the filename, MIME type, byte count, or source timestamp.
    const intentId = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await useDB(event)
      .insert(tables.imageUploadIntents)
      .values({
        id: intentId,
        creatorId: session.user.id,
        filename: fileName,
        contentType,
        expectedSize: declaredSize,
        lastModified: body.lastModified
          ? new Date(body.lastModified).toISOString()
          : null,
        eraseLocation: body.eraseLocation,
        status: 'pending',
        expiresAt,
      })

    const uploadQuery = new URLSearchParams({ intent: intentId })

    const response: any = {
      signedUrl: `/api/photos/upload?${uploadQuery.toString()}`,
      // Cloudflare assigns the final Hosted Image ID only after the PUT. The
      // client must read `key` from that response before queuing finalization.
      fileKey: null,
      intentId,
      expiresIn: 3600,
      uploadKind,
      uploadMethod: 'PUT',
      uploadEncoding: 'raw',
    }

    if (existingPhoto) {
      response.duplicate = true
      response.existingPhoto = existingPhoto
      response.warningInfo = {
        title: t('upload.duplicate.warn.title'),
        message: t('upload.duplicate.warn.message', { fileName }),
        warning: t('upload.duplicate.warn.warning'),
        info: t('upload.duplicate.warn.info', {
          title: existingPhoto.title || fileName,
          dateTaken:
            existingPhoto.dateTaken || t('common.unknown', 'unknown date'),
        }),
      }
    }

    return response
  } catch (error) {
    if ((error as any).statusCode) {
      throw error
    }
    logger.chrono.error('Failed to prepare upload:', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to prepare upload',
    })
  }
})
