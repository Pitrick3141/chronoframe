import { and, eq, inArray, notExists, or, sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const photoIds = query.ids

  if (!photoIds) {
    throw createError({
      statusCode: 400,
      message: 'Photo IDs are required',
    })
  }

  // 支持单个或多个 ID
  const ids = [
    ...new Set((Array.isArray(photoIds) ? photoIds : [photoIds]).map(String)),
  ]

  if (ids.length === 0) {
    return {}
  }

  const db = useDB()
  const session = await getUserSession(event)
  const isAdmin = session.user?.isAdmin === 1

  // Keep the visibility test correlated to each reaction row. This prevents
  // an unbounded hidden-photo ID list from being materialized in the Worker.
  const hiddenAlbumPhoto = db
    .select({ id: tables.albums.id })
    .from(tables.albums)
    .leftJoin(
      tables.albumPhotos,
      eq(tables.albumPhotos.albumId, tables.albums.id),
    )
    .where(
      and(
        eq(tables.albums.isHidden, true),
        or(
          eq(tables.albumPhotos.photoId, tables.photoReactions.photoId),
          eq(tables.albums.coverPhotoId, tables.photoReactions.photoId),
        ),
      ),
    )

  type PhotoReaction = typeof tables.photoReactions.$inferSelect
  type ReactionRow = {
    photoId: string
    reactionType: PhotoReaction['reactionType']
    count: number
  }
  const reactions: ReactionRow[] = []

  // D1 caps bound parameters per statement, so large masonry pages are read
  // sequentially in conservative chunks.
  const chunkSize = 80
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize)
    const rows = await db
      .select({
        photoId: tables.photoReactions.photoId,
        reactionType: tables.photoReactions.reactionType,
        count: sql<number>`count(*)`,
      })
      .from(tables.photoReactions)
      .where(
        isAdmin
          ? inArray(tables.photoReactions.photoId, chunk)
          : and(
              inArray(tables.photoReactions.photoId, chunk),
              notExists(hiddenAlbumPhoto),
            ),
      )
      .groupBy(
        tables.photoReactions.photoId,
        tables.photoReactions.reactionType,
      )
      .all()

    reactions.push(...rows)
  }

  const result: Record<string, Record<string, number>> = {}

  ids.forEach((id) => {
    result[id] = {
      like: 0,
      love: 0,
      amazing: 0,
      funny: 0,
      wow: 0,
      sad: 0,
      fire: 0,
      sparkle: 0,
    }
  })

  // 填充实际的计数
  reactions.forEach((r) => {
    const photoResult = result[r.photoId]
    if (photoResult && r.reactionType) {
      photoResult[r.reactionType] = r.count
    }
  })

  return result
})
