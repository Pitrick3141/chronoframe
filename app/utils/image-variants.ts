import {
  DISPLAY_IMAGE_SIZES,
  THUMBNAIL_IMAGE_SIZES,
} from '~~/shared/utils/image-variants'

/** Only our own media routes understand the fixed-size variant parameter. */
export function imageVariantUrl(src: string, size: number): string {
  if (!/^\/media\/images\/[^/?#]+(?:\/thumbnail)?(?:\?[^#]*)?$/.test(src))
    return src
  const url = new URL(src, 'https://chronoframe.invalid')
  url.searchParams.set('w', String(size))
  return `${url.pathname}${url.search}`
}

export function thumbnailSrcSet(src: string): string | undefined {
  if (!/^\/media\/images\/[^/?#]+\/thumbnail(?:\?[^#]*)?$/.test(src))
    return undefined
  return THUMBNAIL_IMAGE_SIZES.map(
    (size) => `${imageVariantUrl(src, size)} ${size}w`,
  ).join(', ')
}

/** Pick a bounded long-edge size for the fitted image, including portrait photos. */
export function selectDisplaySize(
  width: number | undefined,
  height: number | undefined,
  viewportWidth: number,
  viewportHeight: number,
  pixelRatio = 1,
  zoom = 1,
): number {
  const vw = Math.max(1, viewportWidth || 1)
  const vh = Math.max(1, viewportHeight || 1)
  const dpr = Math.min(2, Math.max(1, pixelRatio || 1))
  const validDimensions = width && height && width > 0 && height > 0
  const fit = validDimensions ? Math.min(vw / width, vh / height, 1) : 1
  const needed = validDimensions
    ? Math.min(
        Math.max(width, height),
        Math.max(width, height) * fit * dpr * Math.max(1, zoom),
      )
    : Math.max(vw, vh) * dpr * Math.max(1, zoom)
  return DISPLAY_IMAGE_SIZES.find((size) => size >= needed) ?? 4096
}
