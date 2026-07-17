import z from 'zod'
import { eq, sql } from 'drizzle-orm'

export default eventHandler(async (event) => {
  await requireAdminSession(event)

  const body = await readValidatedBody(
    event,
    z.object({
      title: z.string().min(1).max(255),
      description: z.string().max(1000).optional(),
      coverPhotoId: z.string().optional(),
      photoIds: z.array(z.string()).max(1000).optional(),
      isHidden: z.boolean().optional(),
    }).parse,
  )

  const db = useDB()
  const photoIds = new Set(body.photoIds || [])
  if (body.coverPhotoId) {
    photoIds.add(body.coverPhotoId)
  }

  // Reserve the next numeric ID before constructing the D1 batch. A competing
  // request may reserve the same value, so retry only that primary-key race.
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await db
      .select({
        id: sql<number>`max(
          coalesce(max(${tables.albums.id}), 0),
          coalesce((select seq from sqlite_sequence where name = 'albums'), 0)
        ) + 1`,
      })
      .from(tables.albums)
      .get()
    const albumId = Number(next?.id ?? 1)

    const createAlbum = db.insert(tables.albums).values({
      id: albumId,
      title: body.title,
      description: body.description || null,
      coverPhotoId: body.coverPhotoId || null,
      isHidden: body.isHidden || false,
    })

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

    try {
      await db.batch([createAlbum, ...insertRelations] as [
        typeof createAlbum,
        ...typeof insertRelations,
      ])
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined
      const isIdRace = `${String(error)} ${String(cause)}`.includes(
        'UNIQUE constraint failed: albums.id',
      )
      if (isIdRace) {
        if (attempt < 2) continue
        throw createError({
          statusCode: 409,
          statusMessage: 'Album ID allocation conflict; please retry',
        })
      }
      throw error
    }

    const album = await db
      .select()
      .from(tables.albums)
      .where(eq(tables.albums.id, albumId))
      .get()

    if (!album) {
      throw createError({
        statusCode: 500,
        statusMessage: 'Failed to create album',
      })
    }

    return album
  }

  throw createError({
    statusCode: 409,
    statusMessage: 'Album ID allocation conflict; please retry',
  })
})
