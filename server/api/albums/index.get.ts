export default eventHandler(async (event) => {
  const db = useDB()
  const session = await getUserSession(event)
  const isAdmin = session.user?.isAdmin === 1

  // 获取所有相册，按创建时间倒序
  const albums = await db.select().from(tables.albums)

  // Fetch relations once. Per-album Promise.all queries can exceed the D1
  // connection limit when a gallery contains many albums.
  const relations = await db
    .select({
      albumId: tables.albumPhotos.albumId,
      photoId: tables.albumPhotos.photoId,
    })
    .from(tables.albumPhotos)
    .orderBy(tables.albumPhotos.albumId, tables.albumPhotos.position)

  const photoIdsByAlbum = new Map<number, string[]>()
  for (const relation of relations) {
    const photoIds = photoIdsByAlbum.get(relation.albumId) ?? []
    photoIds.push(relation.photoId)
    photoIdsByAlbum.set(relation.albumId, photoIds)
  }

  const hiddenAlbumIds = new Set(
    albums.filter((album) => album.isHidden).map((album) => album.id),
  )
  const hiddenPhotoIds = new Set<string>()
  if (!isAdmin) {
    for (const relation of relations) {
      if (hiddenAlbumIds.has(relation.albumId)) {
        hiddenPhotoIds.add(relation.photoId)
      }
    }
    for (const album of albums) {
      if (album.isHidden && album.coverPhotoId) {
        hiddenPhotoIds.add(album.coverPhotoId)
      }
    }
  }

  const visibleAlbums = isAdmin
    ? albums
    : albums.filter((album) => !album.isHidden)
  const albumsWithPhotoIds = visibleAlbums.map((album) => ({
    ...album,
    coverPhotoId:
      album.coverPhotoId && hiddenPhotoIds.has(album.coverPhotoId)
        ? null
        : album.coverPhotoId,
    photoIds: (photoIdsByAlbum.get(album.id) ?? []).filter(
      (photoId) => !hiddenPhotoIds.has(photoId),
    ),
  }))

  // 按创建时间倒序排列
  return albumsWithPhotoIds.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
})
