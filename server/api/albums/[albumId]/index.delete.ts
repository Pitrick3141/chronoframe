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

  const db = useDB()

  // 检查相簌是否存在
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

  // album_photos 使用 ON DELETE CASCADE，D1 中无需同步事务回调。
  await db.delete(tables.albums).where(eq(tables.albums.id, albumId)).run()

  return { success: true }
})
