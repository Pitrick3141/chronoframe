import { and, eq, or } from 'drizzle-orm'
import type { H3Event } from 'h3'

import { tables, useDB } from './db'

const SAFE_RASTER_CONTENT_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/jxl',
  'image/png',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
])

export function throwImageNotFound(): never {
  throw createError({ statusCode: 404, statusMessage: 'Image not found' })
}

export function throwStreamNotFound(): never {
  throw createError({ statusCode: 404, statusMessage: 'Video not found' })
}

export function throwPhotoNotFound(): never {
  throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
}

type ChronoFrameDB = ReturnType<typeof useDB>

async function requireReadablePhotoVisibility(
  event: H3Event,
  db: ChronoFrameDB,
  photoId: string,
  notFound: () => never,
): Promise<void> {
  const session = await getUserSession(event)
  if (session.user?.isAdmin === 1) return

  // A photo is private when it is either a member or the cover of any hidden
  // album. The LEFT JOIN also catches a hidden cover that is not a member.
  const hiddenReference = await db
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
          eq(tables.albumPhotos.photoId, photoId),
          eq(tables.albums.coverPhotoId, photoId),
        ),
      ),
    )
    .limit(1)
    .get()

  if (hiddenReference) notFound()
}

/** Resolve an existing photo after applying the shared hidden-album ACL. */
export async function requireReadablePhoto(event: H3Event, photoId: string) {
  if (!photoId || photoId.length > 1024 || photoId.includes('\0')) {
    throwPhotoNotFound()
  }

  const db = useDB(event)
  const photo = await db
    .select({ id: tables.photos.id })
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .limit(1)
    .get()

  if (!photo) throwPhotoNotFound()

  await requireReadablePhotoVisibility(event, db, photo.id, throwPhotoNotFound)
  return photo
}

/**
 * Resolve a public image identifier through D1 before touching Hosted Images.
 *
 * A photo assigned to or used as the cover of any hidden album is private.
 * The same 404 is used for missing and private records so callers cannot probe
 * the media catalog.
 */
export async function requireReadableHostedImage(
  event: H3Event,
  identifier: string,
) {
  if (!identifier || identifier.length > 1024 || identifier.includes('\0')) {
    throwImageNotFound()
  }

  const db = useDB(event)
  const photo = await db
    .select({
      id: tables.photos.id,
      cloudflareImageId: tables.photos.cloudflareImageId,
      storageKey: tables.photos.storageKey,
      sourceFilename: tables.photos.sourceFilename,
      sourceMimeType: tables.photos.sourceMimeType,
    })
    .from(tables.photos)
    .where(
      or(
        eq(tables.photos.cloudflareImageId, identifier),
        eq(tables.photos.id, identifier),
        eq(tables.photos.storageKey, identifier),
      ),
    )
    .limit(1)
    .get()

  if (!photo) throwImageNotFound()

  await requireReadablePhotoVisibility(event, db, photo.id, throwImageNotFound)

  const imageId = photo.cloudflareImageId ?? photo.storageKey ?? photo.id

  return { imageId, photo }
}

/** Resolve the current ready Stream association after applying photo ACLs. */
export async function requireReadableStreamPhoto(
  event: H3Event,
  photoId: string,
) {
  if (!photoId || photoId.length > 1024 || photoId.includes('\0')) {
    throwStreamNotFound()
  }

  const db = useDB(event)
  const photo = await db
    .select({
      id: tables.photos.id,
      isLivePhoto: tables.photos.isLivePhoto,
      cloudflareStreamId: tables.photos.cloudflareStreamId,
      livePhotoVideoKey: tables.photos.livePhotoVideoKey,
      streamStatus: tables.photos.streamStatus,
    })
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .limit(1)
    .get()

  if (!photo) throwStreamNotFound()
  await requireReadablePhotoVisibility(event, db, photo.id, throwStreamNotFound)

  const streamId = photo.cloudflareStreamId?.trim()
  if (
    !streamId ||
    photo.livePhotoVideoKey !== streamId ||
    photo.streamStatus !== 'ready' ||
    photo.isLivePhoto !== 1
  ) {
    throwStreamNotFound()
  }

  return { photo, streamId }
}

/** Return a MIME type that cannot opt the same-origin response into HTML/SVG. */
export function safeRasterContentType(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const contentType = candidate.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType && SAFE_RASTER_CONTENT_TYPES.has(contentType)) {
      return contentType
    }
  }
  return 'application/octet-stream'
}

function contentDisposition(
  disposition: 'attachment' | 'inline',
  sourceFilename: string | null | undefined,
  fallback: string,
): string {
  const safeFallback =
    fallback
      .replace(/[\u0000-\u001f\u007f"\\/]/g, '_')
      .slice(0, 255)
      .trim() || 'image'
  const basename = sourceFilename?.split(/[\\/]/).pop()?.trim() || safeFallback
  const filename =
    basename
      .replace(/[\u0000-\u001f\u007f]/g, '_')
      .slice(0, 255)
      .trim() || safeFallback
  const ascii =
    filename
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_') || safeFallback
  const wellFormedFilename = Array.from(filename, (char) => {
    const codePoint = char.codePointAt(0) ?? 0
    return char.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff
      ? '\uFFFD'
      : char
  }).join('')
  const encoded = encodeURIComponent(wellFormedFilename).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )

  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

export function attachmentDisposition(
  sourceFilename: string | null | undefined,
  fallback: string,
): string {
  return contentDisposition('attachment', sourceFilename, fallback)
}

export function inlineDisposition(
  sourceFilename: string | null | undefined,
  fallback: string,
): string {
  return contentDisposition('inline', sourceFilename, fallback)
}
