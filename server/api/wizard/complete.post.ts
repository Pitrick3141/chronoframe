import { settingsManager } from '~~/server/services/settings/settingsManager'
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
  const bindingStatus = {
    d1: Boolean(bindings.DB),
    images: Boolean(bindings.IMAGES),
    r2: Boolean(bindings.MEDIA_BUCKET),
    stream: Boolean(bindings.STREAM),
  }
  if (Object.values(bindingStatus).some((configured) => !configured)) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Required Cloudflare bindings are not configured',
      data: { bindings: bindingStatus },
    })
  }

  // Set firstLaunch to false
  // Pass true as the last argument (sudo) to bypass readonly check
  await settingsManager.set('system', 'firstLaunch', false, undefined, true)

  return { success: true }
})
