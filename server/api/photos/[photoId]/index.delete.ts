import { eq } from 'drizzle-orm'

import { hostedImages } from '~~/server/services/cloudflare/hosted-images'
import { cloudflareStream } from '~~/server/services/cloudflare/stream'

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const candidate = error as {
    name?: unknown
    status?: unknown
    statusCode?: unknown
  }
  return (
    candidate.status === 404 ||
    candidate.statusCode === 404 ||
    candidate.name === 'NotFoundError'
  )
}

export default eventHandler(async (event) => {
  await requireAdminSession(event)

  const photoId = getRouterParam(event, 'photoId')
  if (!photoId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Photo ID is required',
    })
  }

  const db = useDB()
  const photo = await db
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()

  if (!photo) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  const failures: string[] = []
  const deleted = {
    image: false,
    stream: false,
    alreadyMissing: [] as string[],
  }

  // Validate legacy/malformed records before deleting either external asset.
  // A mixed record may already have a Stream ID while its image still points
  // at a legacy provider; deleting Stream first would make the 409 response
  // destructive and leave the photo only partially recoverable.
  if (!photo.cloudflareStreamId && photo.livePhotoVideoKey) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Legacy Live Photo video migration is required',
      data: {
        photoId,
        legacyVideoKey: photo.livePhotoVideoKey,
        message: `Legacy video ${photo.livePhotoVideoKey} has not been migrated to Cloudflare Stream`,
      },
    })
  }

  const imageId = photo.cloudflareImageId
  if (!imageId && photo.storageKey) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Legacy photo migration is required',
      data: {
        photoId,
        legacyStorageKey: photo.storageKey,
        message: `Legacy photo ${photo.storageKey} has not been migrated to Cloudflare Hosted Images`,
      },
    })
  }
  if (!imageId) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Photo has no Cloudflare Hosted Images ID',
      data: { photoId },
    })
  }

  // Delete Stream first. If Hosted Images deletion subsequently fails, the D1
  // row is retained so the partial failure remains visible and retryable.
  const streamId = photo.cloudflareStreamId
  if (streamId) {
    try {
      await cloudflareStream.delete(streamId)
      deleted.stream = true
    } catch (error) {
      if (isNotFoundError(error)) {
        deleted.stream = true
        deleted.alreadyMissing.push(`stream:${streamId}`)
      } else {
        failures.push(
          `Cloudflare Stream video ${streamId}: ${error instanceof Error ? error.message : 'delete failed'}`,
        )
      }
    }
  }

  if (failures.length > 0) {
    throw createError({
      statusCode: 502,
      statusMessage: `Photo objects were not fully deleted: ${failures.join('; ')}`,
      data: { photoId, deleted, failures },
    })
  }

  try {
    const removed = await hostedImages.delete(imageId)
    deleted.image = true
    if (!removed) {
      deleted.alreadyMissing.push(`image:${imageId}`)
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      deleted.image = true
      deleted.alreadyMissing.push(`image:${imageId}`)
    } else {
      failures.push(
        `Hosted Image ${imageId}: ${error instanceof Error ? error.message : 'delete failed'}`,
      )
    }
  }

  if (failures.length > 0) {
    throw createError({
      statusCode: 502,
      statusMessage: `Photo objects were not fully deleted: ${failures.join('; ')}`,
      data: { photoId, deleted, failures },
    })
  }

  await db.delete(tables.photos).where(eq(tables.photos.id, photoId))

  return {
    statusCode: 200,
    statusMessage: 'Photo deleted successfully',
    photoId,
    deleted,
  }
})
