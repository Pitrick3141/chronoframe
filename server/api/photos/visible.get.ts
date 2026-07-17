import { and, desc, eq, notExists, or } from 'drizzle-orm'

import { photosForClient } from '../../utils/photo-response'

export default eventHandler(async (_event) => {
  const db = useDB()

  const hiddenAlbumPhoto = db
    .select({
      photoId: tables.albumPhotos.photoId,
    })
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

  // A correlated NOT EXISTS avoids materializing an unbounded ID list and
  // stays below D1's bind-parameter limit.
  const photos = await db
    .select()
    .from(tables.photos)
    .where(notExists(hiddenAlbumPhoto))
    .orderBy(desc(tables.photos.dateTaken))
    .all()

  return photosForClient(photos)
})
