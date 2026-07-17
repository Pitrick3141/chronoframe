import { hostedImages } from '../../../../services/cloudflare/hosted-images'
import {
  attachmentDisposition,
  requireReadableHostedImage,
  throwImageNotFound,
} from '../../../../utils/media-access'

/** Raw Hosted Images bytes are an explicit administrator-only capability. */
export default defineEventHandler(async (event) => {
  await requireAdminSession(event)

  const identifier = getRouterParam(event, 'imageId')
  if (!identifier) throwImageNotFound()

  const { imageId, photo } = await requireReadableHostedImage(event, identifier)
  const [details, bytes] = await Promise.all([
    hostedImages.details(imageId),
    hostedImages.bytes(imageId),
  ])
  if (!bytes) throwImageNotFound()

  const headers = new Headers({
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Disposition': attachmentDisposition(
      photo.sourceFilename,
      `photo-${photo.id}`,
    ),
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Type': 'application/octet-stream',
    'Cross-Origin-Resource-Policy': 'same-origin',
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff',
  })
  if (details?.fileSize !== undefined) {
    headers.set('Content-Length', String(details.fileSize))
  }
  if (details?.uploaded) {
    const uploaded = new Date(details.uploaded)
    if (!Number.isNaN(uploaded.getTime())) {
      headers.set('Last-Modified', uploaded.toUTCString())
    }
  }

  return new Response(bytes, { headers })
})
