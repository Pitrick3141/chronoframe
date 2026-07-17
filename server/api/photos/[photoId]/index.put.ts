import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { photoForClient } from '../../../utils/photo-response'

const paramsSchema = z.object({ photoId: z.string().min(1) })

const bodySchema = z.object({
  title: z.string().trim().max(512).optional(),
  description: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().max(128)).max(64).optional(),
  location: z
    .union([
      z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      }),
      z.null(),
    ])
    .optional(),
  rating: z.union([z.number().int().min(0).max(5), z.null()]).optional(),
})

const LOCATION_EXIF_KEYS = [
  'GPSLatitude',
  'GPSLatitudeRef',
  'GPSLongitude',
  'GPSLongitudeRef',
  'GPSPosition',
  'GPSCoordinates',
  'GPSAltitude',
  'GPSAltitudeRef',
] as const

function normalizeTags(tags: string[] | undefined) {
  if (!tags) return undefined

  const seen = new Set<string>()
  return tags.filter((tag) => {
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export default eventHandler(async (event) => {
  await requireAdminSession(event)

  const t = await useTranslation(event)
  const { photoId } = paramsSchema.parse(event.context.params ?? {})
  const payload = bodySchema.parse(await readBody(event))

  if (Object.values(payload).every((value) => value === undefined)) {
    throw createError({
      statusCode: 400,
      statusMessage: t('dashboard.photos.messages.noChangesProvided'),
    })
  }

  const db = useDB()
  const photo = await db
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()

  if (!photo) {
    throw createError({
      statusCode: 404,
      statusMessage: t('dashboard.photos.messages.photoNotFound'),
    })
  }

  const exif: Record<string, unknown> =
    photo.exif && typeof photo.exif === 'object' ? { ...photo.exif } : {}
  const updateData: Partial<typeof tables.photos.$inferInsert> = {
    lastModified: new Date().toISOString(),
  }

  if (payload.title !== undefined) {
    updateData.title = payload.title || null
    exif.Title = payload.title || null
    exif.XPTitle = payload.title || null
  }

  if (payload.description !== undefined) {
    updateData.description = payload.description || null
    exif.Description = payload.description || null
    exif.ImageDescription = payload.description || null
    exif.CaptionAbstract = payload.description || null
    exif.XPComment = payload.description || null
    exif.UserComment = payload.description || null
  }

  if (payload.tags !== undefined) {
    const tags = normalizeTags(payload.tags) ?? []
    updateData.tags = tags
    exif.Subject = tags.length > 0 ? tags : null
    exif.Keywords = tags.length > 0 ? tags : null
    exif.XPKeywords = tags.length > 0 ? tags.join('; ') : null
  }

  if (payload.location !== undefined) {
    updateData.country = null
    updateData.city = null
    updateData.locationName = null

    if (payload.location) {
      const { latitude, longitude } = payload.location
      updateData.latitude = latitude
      updateData.longitude = longitude
      exif.GPSLatitude = Math.abs(latitude)
      exif.GPSLatitudeRef = latitude >= 0 ? 'N' : 'S'
      exif.GPSLongitude = Math.abs(longitude)
      exif.GPSLongitudeRef = longitude >= 0 ? 'E' : 'W'
      exif.GPSPosition = `${latitude} ${longitude}`
    } else {
      updateData.latitude = null
      updateData.longitude = null
      for (const key of LOCATION_EXIF_KEYS) delete exif[key]
    }
  }

  if (payload.rating !== undefined) exif.Rating = payload.rating
  updateData.exif = exif as typeof photo.exif

  await db
    .update(tables.photos)
    .set(updateData)
    .where(eq(tables.photos.id, photoId))

  const updatedPhoto = await db
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()

  return {
    success: true,
    photo: updatedPhoto
      ? photoForClient(updatedPhoto, { includeSource: true })
      : null,
    binaryMetadataUpdated: false,
    message:
      'Metadata was updated in D1. The original Cloudflare Hosted Image binary is immutable in this Workers flow.',
  }
})
