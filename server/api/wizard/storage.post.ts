import { getCloudflareBindings } from '~~/server/utils/cloudflare-bindings'

export default eventHandler(async (event) => {
  const session = await requireUserSession(event)
  if (!session.user.isAdmin) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Admin privileges required',
    })
  }

  const bindings = getCloudflareBindings()
  const status = {
    d1: Boolean(bindings.DB),
    images: Boolean(bindings.IMAGES),
    r2: Boolean(bindings.MEDIA_BUCKET),
    stream: Boolean(bindings.STREAM),
  }

  if (Object.values(status).some((configured) => !configured)) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Required Cloudflare bindings are not configured',
      data: { bindings: status },
    })
  }

  return { success: true, bindings: status }
})
