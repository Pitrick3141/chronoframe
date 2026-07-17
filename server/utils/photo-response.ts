type StreamPhotoFields = {
  id: string
  isLivePhoto?: boolean | number | null
  cloudflareStreamId?: string | null
  livePhotoVideoKey?: string | null
  streamStatus?: string | null
  livePhotoVideoUrl?: string | null
  streamDashUrl?: string | null
}

type PublicPhotoInput = StreamPhotoFields & {
  title?: string | null
  description?: string | null
  width?: number | null
  height?: number | null
  aspectRatio?: number | null
  dateTaken?: string | null
  fileSize?: number | null
  lastModified?: string | null
  thumbnailHash?: string | null
  tags?: unknown
  exif?: unknown
  latitude?: number | null
  longitude?: number | null
  country?: string | null
  city?: string | null
  locationName?: string | null
  streamDuration?: number | null
  sourceFilename?: string | null
}

export type PhotoResponseOptions = {
  /** Include storage/provider identifiers. Only authenticated admin APIs use it. */
  includeSource?: boolean
}

export function streamManifestPath(photoId: string): string {
  return `/media/streams/${encodeURIComponent(photoId)}/manifest.m3u8`
}

export function imageDisplayPath(photoId: string): string {
  return `/media/images/${encodeURIComponent(photoId)}`
}

export function imageThumbnailPath(photoId: string): string {
  return `${imageDisplayPath(photoId)}/thumbnail`
}

export function imageSourcePath(photoId: string): string {
  return `${imageDisplayPath(photoId)}/source`
}

function basename(value: string | null | undefined): string | null {
  const normalized = value?.replaceAll('\\', '/').trim()
  if (!normalized) return null
  return normalized.slice(normalized.lastIndexOf('/') + 1) || null
}

function hasReadyStream(photo: StreamPhotoFields): boolean {
  const streamId = photo.cloudflareStreamId?.trim()
  return Boolean(
    (photo.isLivePhoto === true || photo.isLivePhoto === 1) &&
    photo.streamStatus === 'ready' &&
    streamId &&
    photo.livePhotoVideoKey === streamId,
  )
}

function clientPlaybackFields(photo: StreamPhotoFields) {
  return {
    livePhotoVideoUrl: hasReadyStream(photo)
      ? streamManifestPath(photo.id)
      : null,
    // DASH is not exposed until it has its own authorization route.
    streamDashUrl: null,
  }
}

/**
 * Build a public photo DTO by selecting fields explicitly. Storage keys,
 * Cloudflare resource IDs and source-file metadata must never cross an
 * anonymous response boundary.
 */
function publicPhotoForClient(photo: PublicPhotoInput) {
  return {
    id: photo.id,
    title: photo.title ?? null,
    description: photo.description ?? null,
    width: photo.width ?? null,
    height: photo.height ?? null,
    aspectRatio: photo.aspectRatio ?? null,
    dateTaken: photo.dateTaken ?? null,
    fileSize: photo.fileSize ?? null,
    lastModified: photo.lastModified ?? null,
    originalUrl: imageDisplayPath(photo.id),
    thumbnailUrl: imageThumbnailPath(photo.id),
    thumbnailHash: photo.thumbnailHash ?? null,
    tags: photo.tags ?? [],
    exif: photo.exif ?? {},
    latitude: photo.latitude ?? null,
    longitude: photo.longitude ?? null,
    country: photo.country ?? null,
    city: photo.city ?? null,
    locationName: photo.locationName ?? null,
    isLivePhoto: photo.isLivePhoto ?? 0,
    streamDuration: photo.streamDuration ?? null,
    // This is a presentation name, not the original source filename.
    displayFilename:
      basename(photo.title) || `photo-${encodeURIComponent(photo.id)}.webp`,
    ...clientPlaybackFields(photo),
  }
}

/**
 * Admin DTOs retain the complete D1 row but still use same-origin display
 * paths. Raw source bytes have a separate, explicitly admin-only URL.
 */
function adminPhotoForClient<T extends PublicPhotoInput>(photo: T) {
  return {
    ...photo,
    originalUrl: imageDisplayPath(photo.id),
    thumbnailUrl: imageThumbnailPath(photo.id),
    displayFilename:
      basename(photo.sourceFilename) ||
      basename(photo.title) ||
      `photo-${encodeURIComponent(photo.id)}.webp`,
    sourceUrl: imageSourcePath(photo.id),
    ...clientPlaybackFields(photo),
  }
}

export function photoForClient<T extends PublicPhotoInput>(
  photo: T,
  options: PhotoResponseOptions = {},
) {
  return options.includeSource
    ? adminPhotoForClient(photo)
    : publicPhotoForClient(photo)
}

export function photosForClient<T extends PublicPhotoInput>(
  photos: T[],
  options: PhotoResponseOptions = {},
) {
  return photos.map((photo) => photoForClient(photo, options))
}
