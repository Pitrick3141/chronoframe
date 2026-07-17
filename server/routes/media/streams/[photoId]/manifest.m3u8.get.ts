import {
  cloudflareStream,
  signedStreamHlsUrl,
} from '../../../../services/cloudflare/stream'
import {
  requireReadableStreamPhoto,
  throwStreamNotFound,
} from '../../../../utils/media-access'

export default eventHandler(async (event) => {
  const photoId = getRouterParam(event, 'photoId')
  if (!photoId) throwStreamNotFound()

  const { streamId } = await requireReadableStreamPhoto(event, photoId)

  try {
    const details = await cloudflareStream.details(streamId)
    if (
      details.id !== streamId ||
      details.readyToStream !== true ||
      !details.playback.hls
    ) {
      throwStreamNotFound()
    }

    const token = await cloudflareStream.generateToken(streamId)
    const location = signedStreamHlsUrl(details.playback.hls, streamId, token)

    setResponseHeaders(event, {
      'Cache-Control': 'private, no-store, max-age=0',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
    return sendRedirect(event, location, 307)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      error.statusCode === 404
    ) {
      throw error
    }

    throw createError({
      statusCode: 502,
      statusMessage: 'Unable to authorize video playback',
      cause: error,
    })
  }
})
