import { deliverHostedImage } from '../../../services/cloudflare/image-delivery'
import { throwImageNotFound } from '../../../utils/media-access'

/**
 * Public image delivery always returns a re-encoded WebP display copy. This
 * keeps HEIC/SVG sources browser-compatible and prevents source EXIF metadata
 * from crossing the public response boundary.
 */
export default defineEventHandler(async (event) => {
  const identifier = getRouterParam(event, 'imageId')
  if (!identifier) throwImageNotFound()

  return deliverHostedImage(event, identifier, 'display')
})
