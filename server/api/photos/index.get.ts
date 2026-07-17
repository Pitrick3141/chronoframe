import { and, desc, eq, notExists, or } from 'drizzle-orm'

import { photosForClient } from '../../utils/photo-response'

export default eventHandler(async (event) => {
  const db = useDB()
  const session = await getUserSession(event)

  if (session.user?.isAdmin === 1) {
    const photos = await db
      .select()
      .from(tables.photos)
      .orderBy(desc(tables.photos.dateTaken))
      .all()
    return photosForClient(photos, { includeSource: true })
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

  const photos = await db
    .select()
    .from(tables.photos)
    .where(notExists(hiddenAlbumPhoto))
    .orderBy(desc(tables.photos.dateTaken))
    .all()
  return photosForClient(photos)
})
