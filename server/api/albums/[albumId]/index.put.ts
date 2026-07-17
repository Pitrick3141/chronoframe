import { z } from 'zod'

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

  const body = await readValidatedBody(
    event,
    z.object({
      title: z.string().min(1).max(255).optional(),
      description: z.string().max(1000).optional(),
      coverPhotoId: z.string().optional(),
      photoIds: z.array(z.string()).max(1000).optional(),
      isHidden: z.boolean().optional(),
    }).parse,
  )

  const db = useDB()

  // 检查相簿是否存在
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

  const updateData: Record<string, any> = {
    updatedAt: new Date(),
  }

  if (body.title !== undefined) {
    updateData.title = body.title
  }

  if (body.description !== undefined) {
    updateData.description = body.description || null
  }

  if (body.coverPhotoId !== undefined) {
    updateData.coverPhotoId = body.coverPhotoId || null
  }
  if (body.isHidden !== undefined) {
    updateData.isHidden = body.isHidden
  }

  const updateAlbum = db
    .update(tables.albums)
    .set(updateData)
    .where(eq(tables.albums.id, albumId))

  if (body.photoIds === undefined) {
    await updateAlbum.run()
  } else {
    const photoIds = new Set(body.photoIds)
    if (body.coverPhotoId) {
      photoIds.add(body.coverPhotoId)
    }

    const deleteRelations = db
      .delete(tables.albumPhotos)
      .where(eq(tables.albumPhotos.albumId, albumId))

    if (photoIds.size === 0) {
      await db.batch([updateAlbum, deleteRelations])
    } else {
      let position = 1000000
      const relations = [...photoIds].map((photoId) => ({
        albumId,
        photoId,
        position: (position += 10),
      }))
      const insertRelations = []
      for (let offset = 0; offset < relations.length; offset += 30) {
        insertRelations.push(
          db
            .insert(tables.albumPhotos)
            .values(relations.slice(offset, offset + 30))
            .onConflictDoNothing(),
        )
      }

      await db.batch([
        updateAlbum,
        deleteRelations,
        ...insertRelations,
      ] as [
        typeof updateAlbum,
        typeof deleteRelations,
        ...typeof insertRelations,
      ])
    }
  }

  const updatedAlbum = await db
    .select()
    .from(tables.albums)
    .where(eq(tables.albums.id, albumId))
    .get()

  return updatedAlbum
})
