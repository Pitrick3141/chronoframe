import { z } from 'zod'
import { and } from 'drizzle-orm'

export default eventHandler(async (event) => {
  await requireAdminSession(event)

  const { albumId } = await getValidatedRouterParams(
    event,
    z.object({
      albumId: z
        .string()
        .regex(/^\d+$/)
        .transform((val) => parseInt(val, 10)),
    }).parse,
  )

  const { photoId } = await getValidatedRouterParams(
    event,
    z.object({
      photoId: z.string(),
    }).parse,
  )

  const db = useDB()

  // 检查相簌-照片关系是否存在
  const relation = await db
    .select()
    .from(tables.albumPhotos)
    .where(
      and(
        eq(tables.albumPhotos.albumId, albumId),
        eq(tables.albumPhotos.photoId, photoId),
      ),
    )
    .get()

  if (!relation) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Photo not found in album',
    })
  }

  await db.batch([
    db.delete(tables.albumPhotos).where(
      and(
        eq(tables.albumPhotos.albumId, albumId),
        eq(tables.albumPhotos.photoId, photoId),
      ),
    ),
    db
      .update(tables.albums)
      .set({ coverPhotoId: null, updatedAt: new Date() })
      .where(
        and(
          eq(tables.albums.id, albumId),
          eq(tables.albums.coverPhotoId, photoId),
        ),
      ),
  ])

  return { success: true }
})
