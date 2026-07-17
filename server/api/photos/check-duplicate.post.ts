import { z } from 'zod'
import { inArray, or } from 'drizzle-orm'

/**
 * 检查照片是否已存在
 * 可以检查单个或多个文件
 */
export default defineEventHandler(async (event) => {
  await requireAdminSession(event)

  const t = await useTranslation(event)

  try {
    const { fileNames, storageKeys } = await readValidatedBody(
      event,
      z.object({
        fileNames: z.array(z.string()).optional(),
        storageKeys: z.array(z.string()).optional(),
      }).parse,
    )

    if (!fileNames && !storageKeys) {
      throw createError({
        statusCode: 400,
        statusMessage: t('upload.error.required.title'),
        data: {
          title: t('upload.error.required.title'),
          message: t('upload.error.required.message', {
            field: 'fileNames or storageKeys',
          }),
        },
      })
    }

    const db = useDB()
    const results = []
    const photoColumns = {
      id: tables.photos.id,
      title: tables.photos.title,
      storageKey: tables.photos.storageKey,
      cloudflareImageId: tables.photos.cloudflareImageId,
      sourceFilename: tables.photos.sourceFilename,
      originalUrl: tables.photos.originalUrl,
      thumbnailUrl: tables.photos.thumbnailUrl,
      dateTaken: tables.photos.dateTaken,
      fileSize: tables.photos.fileSize,
      width: tables.photos.width,
      height: tables.photos.height,
    }
    type Photo = typeof tables.photos.$inferSelect
    type DuplicatePhoto = Pick<
      Photo,
      | 'id'
      | 'title'
      | 'storageKey'
      | 'cloudflareImageId'
      | 'sourceFilename'
      | 'originalUrl'
      | 'thumbnailUrl'
      | 'dateTaken'
      | 'fileSize'
      | 'width'
      | 'height'
    >

    // 检查文件名
    if (fileNames && fileNames.length > 0) {
      const photosByFilename = new Map<string, DuplicatePhoto>()

      for (let offset = 0; offset < fileNames.length; offset += 80) {
        const names = fileNames.slice(offset, offset + 80)
        const matches = await db
          .select(photoColumns)
          .from(tables.photos)
          .where(inArray(tables.photos.sourceFilename, names))
          .all()

        for (const match of matches) {
          if (match.sourceFilename) {
            photosByFilename.set(match.sourceFilename, match)
          }
        }
      }

      for (const fileName of fileNames) {
        const existingPhoto = photosByFilename.get(fileName)

        results.push({
          fileName,
          storageKey: existingPhoto?.storageKey ?? null,
          photoId: existingPhoto?.id ?? null,
          exists: !!existingPhoto,
          photo: existingPhoto || null,
        })
      }
    }

    // 检查 storageKey
    if (storageKeys && storageKeys.length > 0) {
      const photosByStorageKey = new Map<string, DuplicatePhoto>()

      // Each key is bound three times; 30 stays below D1's conservative limit.
      for (let offset = 0; offset < storageKeys.length; offset += 30) {
        const keys = storageKeys.slice(offset, offset + 30)
        const matches = await db
          .select(photoColumns)
          .from(tables.photos)
          .where(
            or(
              inArray(tables.photos.id, keys),
              inArray(tables.photos.storageKey, keys),
              inArray(tables.photos.cloudflareImageId, keys),
            ),
          )
          .all()

        for (const match of matches) {
          photosByStorageKey.set(match.id, match)
          if (match.storageKey) {
            photosByStorageKey.set(match.storageKey, match)
          }
          if (match.cloudflareImageId) {
            photosByStorageKey.set(match.cloudflareImageId, match)
          }
        }
      }

      for (const storageKey of storageKeys) {
        const existingPhoto = photosByStorageKey.get(storageKey)

        results.push({
          storageKey,
          photoId: existingPhoto?.id ?? null,
          exists: !!existingPhoto,
          photo: existingPhoto || null,
        })
      }
    }

    const duplicatesFound = results.filter((r) => r.exists).length

    return {
      success: true,
      results,
      duplicatesFound,
      summary: {
        title: t('upload.success.check.title'),
        message: t('upload.success.check.message', {
          total: results.length,
          duplicates: duplicatesFound,
        }),
      },
    }
  } catch (error: any) {
    if (error.statusCode) {
      throw error
    }

    throw createError({
      statusCode: 500,
      statusMessage: t('upload.error.uploadFailed.title'),
      data: {
        title: t('upload.error.uploadFailed.title'),
        message: error.message || t('upload.error.uploadFailed.message'),
      },
    })
  }
})
