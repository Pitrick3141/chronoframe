import { z } from 'zod'

import { abandonStreamUploadTask } from '~~/server/services/cloudflare/stream-upload-task'

export default defineEventHandler(async (event) => {
  await requireAdminSession(event)

  const { taskId } = await getValidatedRouterParams(
    event,
    z.object({ taskId: z.coerce.number().int().positive() }).parse,
  )
  const result = await abandonStreamUploadTask(useDB(event), taskId)

  if (!result.found || !result.isStreamUpload) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Stream upload task not found',
    })
  }

  return {
    success: true,
    abandoned: result.changed || result.status === 'failed',
    status: result.status,
  }
})
