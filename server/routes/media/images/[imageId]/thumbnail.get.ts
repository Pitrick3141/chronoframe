import { deliverHostedImage } from '../../../../services/cloudflare/image-delivery'
import { throwImageNotFound } from '../../../../utils/media-access'

export default defineEventHandler(async (event) => {
  const identifier = getRouterParam(event, 'imageId')
  if (!identifier) throwImageNotFound()

  return deliverHostedImage(event, identifier, 'thumbnail')
})
