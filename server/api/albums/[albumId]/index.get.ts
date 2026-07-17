import { and, asc, eq, getTableColumns, notExists, or } from 'drizzle-orm'
import z from 'zod'

import { photosForClient } from '../../../utils/photo-response'

export default eventHandler(async (event) => {
  const { albumId } = await getValidatedRouterParams(
    event,
    z.object({
      albumId: z
        .string()
        .regex(/^\d+$/)
        .transform((val) => parseInt(val, 10)),
    }).parse,
  )

  const db = useDB()
  const session = await getUserSession(event)
  const isAdmin = session.user?.isAdmin === 1

  const album = await db
    .select()
    .from(tables.albums)
    .where(eq(tables.albums.id, albumId))
    .get()

  if (!album) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Album not found',
    })
  }

  // Hidden albums are visible only to administrators. Return 404 so their IDs
  // cannot be discovered through access-control responses.
  if (album.isHidden && !isAdmin) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Album not found',
    })
  }

  const hiddenAlbumPhoto = db
    .select({ photoId: tables.albumPhotos.photoId })
    .from(tables.albums)
    .leftJoin(
      tables.albumPhotos,
      eq(tables.albumPhotos.albumId, tables.albums.id),
    )
    .where(
      and(
        eq(tables.albums.isHidden, true),
        or(
          eq(tables.albumPhotos.photoId, tables.photos.id),
          eq(tables.albums.coverPhotoId, tables.photos.id),
        ),
      ),
    )

  // 获取相册中的照片
  const photosQuery = db
    // all fields from tables.photos
    .select({
      ...getTableColumns(tables.photos),
    })
    .from(tables.photos)
    .innerJoin(
      tables.albumPhotos,
      eq(tables.photos.id, tables.albumPhotos.photoId),
    )
    .where(
      isAdmin
        ? eq(tables.albumPhotos.albumId, albumId)
        : and(
            eq(tables.albumPhotos.albumId, albumId),
            notExists(hiddenAlbumPhoto),
          ),
    )
    .orderBy(asc(tables.albumPhotos.position))
  const photos = await photosQuery.all()

  const visibleAlbum =
    !isAdmin &&
    album.coverPhotoId &&
    !photos.some((photo) => photo.id === album.coverPhotoId)
      ? { ...album, coverPhotoId: null }
      : album

  // 验证相册数据完整性
  if (!photos || !Array.isArray(photos)) {
    // 空相册也是合法的，只需要返回空数组
    return {
      ...visibleAlbum,
      photos: [],
    }
  }

  return {
    ...visibleAlbum,
    photos: photosForClient(photos, { includeSource: isAdmin }),
  }
})
