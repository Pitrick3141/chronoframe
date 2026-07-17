import { eq } from 'drizzle-orm'

import { photoForClient } from '../../../utils/photo-response'

export default eventHandler(async (event) => {
  await requireAdminSession(event)

  const photoId = getRouterParam(event, 'photoId')

  if (!photoId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Photo ID is required',
    })
  }

  const photo = await useDB()
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()

  if (!photo) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Photo not found',
    })
  }

  const clientPhoto = photoForClient(photo, { includeSource: true })

  return {
    id: photo.id,
    title: photo.title,
    isLivePhoto: Boolean(photo.isLivePhoto),
    livePhotoVideoUrl: clientPhoto.livePhotoVideoUrl,
    cloudflareStreamId: photo.cloudflareStreamId,
    streamStatus: photo.streamStatus,
    streamThumbnailUrl: photo.streamThumbnailUrl,
    streamDashUrl: clientPhoto.streamDashUrl,
    streamDuration: photo.streamDuration,
    originalUrl: photo.originalUrl,
    thumbnailUrl: photo.thumbnailUrl,
  }
})
