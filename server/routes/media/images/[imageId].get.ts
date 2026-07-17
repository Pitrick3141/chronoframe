import { hostedImages } from '../../../services/cloudflare/hosted-images'
import {
  inlineDisposition,
  requireReadableHostedImage,
  throwImageNotFound,
} from '../../../utils/media-access'

const DISPLAY_IMAGE_MAX_WIDTH = 4096

/**
 * Public image delivery always returns a re-encoded WebP display copy. This
 * keeps HEIC/SVG sources browser-compatible and prevents source EXIF metadata
 * from crossing the public response boundary.
 */
export default defineEventHandler(async (event) => {
  const identifier = getRouterParam(event, 'imageId')
  if (!identifier) throwImageNotFound()

  const { imageId, photo } = await requireReadableHostedImage(event, identifier)
  const transformed = await hostedImages.thumbnail(
    imageId,
    DISPLAY_IMAGE_MAX_WIDTH,
  )
  if (!transformed) throwImageNotFound()

  const headers = new Headers(transformed.headers)
  headers.set('Cache-Control', 'private, no-store, max-age=0')
  headers.set(
    'Content-Disposition',
    inlineDisposition(null, `photo-${photo.id}.webp`),
  )
  headers.set('Content-Type', 'image/webp')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  headers.set('Vary', 'Cookie')
  headers.set('X-Content-Type-Options', 'nosniff')

  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers,
  })
})
