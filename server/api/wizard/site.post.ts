import { z } from 'zod'
import { settingsManager } from '~~/server/services/settings/settingsManager'

export default eventHandler(async (event) => {
  const session = await requireUserSession(event)
  if (!session.user.isAdmin) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Admin privileges required',
    })
  }

  const body = await readValidatedBody(
    event,
    z.object({
      title: z.string().min(1),
      slogan: z.string().optional(),
      avatarUrl: z.string().optional(),
      author: z.string().optional(),
    }).parse,
  )

  await settingsManager.set('app', 'title', body.title)
  if (body.slogan) await settingsManager.set('app', 'slogan', body.slogan)
  if (body.avatarUrl)
    await settingsManager.set('app', 'avatarUrl', body.avatarUrl)
  if (body.author) await settingsManager.set('app', 'author', body.author)

  return { success: true }
})
