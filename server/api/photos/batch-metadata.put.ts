import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

const tagsSchema = z
  .object({
    mode: z.enum(['add', 'remove', 'replace']),
    values: z.array(z.string().trim().max(128)).max(64),
  })
  .refine(
    ({ mode, values }) => mode === 'replace' || values.length > 0,
    'At least one tag is required for add or remove mode',
  )

const bodySchema = z.object({
  photoIds: z.array(z.string().min(1)).min(1).max(200),
  tags: tagsSchema.optional(),
  location: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
  city: z.union([z.string().trim().max(256), z.null()]).optional(),
})

const normalizeTags = (tags: string[]) => {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const tag of tags) {
    const trimmed = tag.trim()
    const key = trimmed.toLowerCase()
    if (trimmed && !seen.has(key)) {
      seen.add(key)
      normalized.push(trimmed)
    }
  }
  return normalized
}

function updateTags(
  existing: string[] | null,
  update: z.infer<typeof tagsSchema>,
) {
  const current = normalizeTags(existing ?? [])
  const values = normalizeTags(update.values)
  if (update.mode === 'replace') return values
  const requested = new Set(values.map((tag) => tag.toLowerCase()))
  if (update.mode === 'remove') {
    return current.filter((tag) => !requested.has(tag.toLowerCase()))
  }
  const seen = new Set(current.map((tag) => tag.toLowerCase()))
  return [...current, ...values.filter((tag) => !seen.has(tag.toLowerCase()))]
}

export default eventHandler(async (event) => {
  await requireAdminSession(event)
  const t = await useTranslation(event)
  const payload = bodySchema.parse(await readBody(event))
  const photoIds = [...new Set(payload.photoIds)]

  if (
    payload.tags === undefined &&
    payload.location === undefined &&
    payload.city === undefined
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: t('dashboard.photos.messages.noChangesProvided'),
    })
  }

  const db = useDB()
  const photos = await db
    .select()
    .from(tables.photos)
    .where(inArray(tables.photos.id, photoIds))
  if (photos.length !== photoIds.length) {
    throw createError({
      statusCode: 404,
      statusMessage: t('dashboard.photos.messages.photoNotFound'),
    })
  }

  const lastModified = new Date().toISOString()
  const updates = photos.map((photo) => {
    const exif: Record<string, unknown> =
      photo.exif && typeof photo.exif === 'object' ? { ...photo.exif } : {}
    const update: Partial<typeof tables.photos.$inferInsert> = { lastModified }
    if (payload.tags) {
      const tags = updateTags(photo.tags, payload.tags)
      update.tags = tags
      exif.Subject = tags.length > 0 ? tags : null
      exif.Keywords = tags.length > 0 ? tags : null
      exif.XPKeywords = tags.length > 0 ? tags.join('; ') : null
    }
    if (payload.location) {
      const { latitude, longitude } = payload.location
      update.latitude = latitude
      update.longitude = longitude
      update.country = null
      update.locationName = null
      update.city = payload.city === undefined ? null : payload.city || null
      exif.GPSLatitude = Math.abs(latitude)
      exif.GPSLatitudeRef = latitude >= 0 ? 'N' : 'S'
      exif.GPSLongitude = Math.abs(longitude)
      exif.GPSLongitudeRef = longitude >= 0 ? 'E' : 'W'
      exif.GPSPosition = `${latitude} ${longitude}`
      exif.GPSCoordinates = `${latitude}, ${longitude}`
    } else if (payload.city !== undefined) {
      update.city = payload.city || null
    }
    if (payload.city !== undefined) exif.City = payload.city || null
    update.exif = exif as typeof photo.exif
    return db
      .update(tables.photos)
      .set(update)
      .where(eq(tables.photos.id, photo.id))
  })

  await db.batch(updates as [(typeof updates)[number], ...typeof updates])
  return {
    success: true,
    updatedCount: photos.length,
    binaryMetadataUpdated: false,
  }
})
