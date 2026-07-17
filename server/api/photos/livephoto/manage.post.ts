import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

import {
  finalizeLivePhotoVideo,
  sourceBasename,
} from '~~/server/services/cloudflare/finalize-upload'
import {
  cloudflareStream,
  type StreamVideoDetails,
} from '~~/server/services/cloudflare/stream'

const MAX_VIDEOS_PER_REQUEST = 20
const ORPHAN_DISCOVERY_LIMIT = 100

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('scan'),
    before: z.string().datetime().optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_VIDEOS_PER_REQUEST)
      .optional()
      .default(MAX_VIDEOS_PER_REQUEST),
  }),
  z.object({
    action: z.literal('detect'),
    photoIds: z.array(z.string().min(1)).max(MAX_VIDEOS_PER_REQUEST).optional(),
  }),
  z.object({
    action: z.literal('process'),
    videoKey: z.string().min(1),
  }),
  z.object({
    action: z.literal('update-photo'),
    photoId: z.string().min(1),
  }),
])

async function loadPhotos(
  photoIds?: string[],
): Promise<Array<typeof tables.photos.$inferSelect>> {
  const db = useDB()
  if (!photoIds?.length) {
    return db.select().from(tables.photos).limit(MAX_VIDEOS_PER_REQUEST)
  }

  return db
    .select()
    .from(tables.photos)
    .where(inArray(tables.photos.id, [...new Set(photoIds)]))
}

function streamIdForPhoto(
  photo: Awaited<ReturnType<typeof loadPhotos>>[number],
): string | null {
  return photo.cloudflareStreamId ?? null
}

function videoSourceFilename(video: StreamVideoDetails): string | undefined {
  const entry = Object.entries(video.meta).find(
    ([key]) => key.toLowerCase() === 'sourcefilename',
  )
  return entry?.[1]
}

function matchingVideo(
  photo: Awaited<ReturnType<typeof loadPhotos>>[number],
  videos: StreamVideoDetails[],
): StreamVideoDetails | undefined {
  const photoBasename = sourceBasename(
    photo.sourceFilename ?? photo.title ?? photo.id,
  ).toLowerCase()

  return videos.find((video) => {
    const sourceFilename = videoSourceFilename(video)
    return (
      sourceFilename &&
      sourceBasename(sourceFilename).toLowerCase() === photoBasename
    )
  })
}

export default eventHandler(async (event) => {
  await requireAdminSession(event)
  const request = await readValidatedBody(event, bodySchema.parse)
  const db = useDB()

  switch (request.action) {
    case 'process': {
      const result = await finalizeLivePhotoVideo(db, request.videoKey)
      return {
        message: 'Cloudflare Stream Live Photo video finalized successfully',
        success: true,
        videoKey: request.videoKey,
        ...result,
      }
    }

    case 'scan': {
      const videos = await cloudflareStream.list({
        limit: request.limit,
        ...(request.before
          ? { before: request.before, beforeComp: 'lt' as const }
          : {}),
      })
      const results = []
      const errors = []

      for (const video of videos) {
        try {
          results.push({
            videoKey: video.id,
            ...(await finalizeLivePhotoVideo(db, video.id, {
              details: video,
            })),
          })
        } catch (error) {
          errors.push({
            videoKey: video.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      }

      return {
        message: 'Cloudflare Stream Live Photo scan page completed',
        success: errors.length === 0,
        results,
        errors,
        nextBefore:
          videos.length === request.limit ? videos.at(-1)?.created : undefined,
      }
    }

    case 'detect': {
      const photos = await loadPhotos(request.photoIds)
      const needsDiscovery = photos.some((photo) => !streamIdForPhoto(photo))
      const recentVideos = needsDiscovery
        ? await cloudflareStream.list({ limit: ORPHAN_DISCOVERY_LIMIT })
        : []
      const results = []

      for (const photo of photos) {
        const existingStreamId = streamIdForPhoto(photo)
        let video: StreamVideoDetails | undefined

        try {
          video = existingStreamId
            ? await cloudflareStream.details(existingStreamId)
            : matchingVideo(photo, recentVideos)

          if (!video) {
            results.push({
              photoId: photo.id,
              detected: false,
              migrationRequired: Boolean(
                photo.livePhotoVideoKey && !photo.cloudflareStreamId,
              ),
            })
            continue
          }

          const result = await finalizeLivePhotoVideo(db, video.id, {
            details: video,
            photoId: photo.id,
          })
          results.push({
            photoId: photo.id,
            detected: true,
            videoKey: video.id,
            ...result,
          })
        } catch (error) {
          results.push({
            photoId: photo.id,
            detected: false,
            videoKey: video?.id ?? existingStreamId,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      }

      return {
        message: 'Cloudflare Stream Live Photo detection completed',
        success: results.every((result) => !('error' in result)),
        results,
      }
    }

    case 'update-photo': {
      const photo = await db
        .select()
        .from(tables.photos)
        .where(eq(tables.photos.id, request.photoId))
        .get()

      if (!photo) {
        throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
      }

      const streamId = streamIdForPhoto(photo)
      const video = streamId
        ? await cloudflareStream.details(streamId)
        : matchingVideo(
            photo,
            await cloudflareStream.list({ limit: ORPHAN_DISCOVERY_LIMIT }),
          )

      if (!video) {
        return {
          message: photo.livePhotoVideoKey
            ? 'The legacy video must be migrated to Cloudflare Stream first'
            : 'No matching Cloudflare Stream video was found for this photo',
          success: false,
          photoId: photo.id,
          migrationRequired: Boolean(photo.livePhotoVideoKey),
        }
      }

      const result = await finalizeLivePhotoVideo(db, video.id, {
        details: video,
        photoId: photo.id,
      })
      return {
        message: 'Photo Stream playback metadata refreshed successfully',
        success: true,
        photoId: photo.id,
        videoKey: video.id,
        ...result,
      }
    }
  }
})
