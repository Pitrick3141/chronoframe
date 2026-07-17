import { hostedImages } from '../../../../services/cloudflare/hosted-images'
import {
  inlineDisposition,
  requireReadableHostedImage,
  throwImageNotFound,
} from '../../../../utils/media-access'

export default defineEventHandler(async (event) => {
  const identifier = getRouterParam(event, 'imageId')
  if (!identifier) throwImageNotFound()

  const { imageId, photo } = await requireReadableHostedImage(
    event,
    identifier,
  )

  const transformed = await hostedImages.thumbnail(imageId, 600)
  if (!transformed) throwImageNotFound()

  const headers = new Headers(transformed.headers)
  headers.set('Cache-Control', 'private, no-store')
  headers.set(
    'Content-Disposition',
    inlineDisposition(null, `thumbnail-${photo.id}.webp`),
  )
  headers.set('Content-Type', 'image/webp')
  headers.set('Vary', 'Cookie')
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers,
  })
})
