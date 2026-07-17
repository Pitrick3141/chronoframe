import { eq } from 'drizzle-orm'
import { z } from 'zod'

import {
  finalizeExistingQueueTask,
  type WorkersPipelinePayload,
} from '~~/server/services/cloudflare/finalize-upload'

export default defineEventHandler(async (event) => {
  await requireAdminSession(event)

  const { taskId } = await getValidatedRouterParams(
    event,
    z.object({ taskId: z.coerce.number().int().positive() }).parse,
  )

  const db = useDB()
  let task = await db
    .select()
    .from(tables.pipelineQueue)
    .where(eq(tables.pipelineQueue.id, taskId))
    .get()

  if (!task) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Task not found',
    })
  }

  const payload = task.payload as WorkersPipelinePayload
  if (
    (task.status === 'pending' || task.status === 'in-stages') &&
    (payload.type === 'photo' || payload.type === 'live-photo-video')
  ) {
    // Workers do not keep a background poller alive. Photo finalization may
    // discover an embedded Motion Photo, so both task kinds refresh Stream
    // lazily while an authenticated client is polling.
    await finalizeExistingQueueTask(taskId, payload)
    task =
      (await db
        .select()
        .from(tables.pipelineQueue)
        .where(eq(tables.pipelineQueue.id, taskId))
        .get()) ?? task
  }

  return task
})
