export const THUMBNAIL_IMAGE_SIZES = [360, 640, 960] as const
export const DISPLAY_IMAGE_SIZES = [1280, 1920, 2560, 4096] as const
export const DEFAULT_THUMBNAIL_IMAGE_SIZE = 640
export const DEFAULT_DISPLAY_IMAGE_SIZE = 4096

export type ImageVariantKind = 'thumbnail' | 'display'

export interface ImageVariant {
  size: number
  /** Thumbnail srcset uses pixel-width descriptors; only displays cap height. */
  height: number | null
  quality: number
  format: 'image/webp'
}

/** Only fixed variants can enter the transform cache; arbitrary query sizes cannot. */
export function getImageVariant(
  kind: ImageVariantKind,
  requestedSize: unknown,
): ImageVariant | null {
  const sizes: readonly number[] =
    kind === 'thumbnail' ? THUMBNAIL_IMAGE_SIZES : DISPLAY_IMAGE_SIZES
  const fallback =
    kind === 'thumbnail'
      ? DEFAULT_THUMBNAIL_IMAGE_SIZE
      : DEFAULT_DISPLAY_IMAGE_SIZE
  if (
    requestedSize !== undefined &&
    (typeof requestedSize !== 'string' || !/^\d+$/.test(requestedSize))
  ) {
    return null
  }
  const size = requestedSize === undefined ? fallback : Number(requestedSize)
  if (!sizes.includes(size)) return null
  return {
    size,
    height: kind === 'thumbnail' ? null : size,
    quality: kind === 'thumbnail' ? 80 : 85,
    format: 'image/webp',
  }
}
