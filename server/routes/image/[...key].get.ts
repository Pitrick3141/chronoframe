import {
  requireReadableHostedImage,
  throwImageNotFound,
} from '../../utils/media-access'
import { imageDisplayPath } from '../../utils/photo-response'

/** Legacy image URLs now resolve to the ACL-checked display representation. */
export default eventHandler(async (event) => {
  const rawImageId = getRouterParam(event, 'key')
  if (!rawImageId) throwImageNotFound()

  let imageId: string
  try {
    imageId = decodeURIComponent(rawImageId)
  } catch {
    throwImageNotFound()
  }

  const resolved = await requireReadableHostedImage(event, imageId)
  setResponseHeaders(event, {
    'Cache-Control': 'private, no-store, max-age=0',
    Vary: 'Cookie',
  })
  return sendRedirect(event, imageDisplayPath(resolved.photo.id), 307)
})
