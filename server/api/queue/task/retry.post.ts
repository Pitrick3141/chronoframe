import { eq } from 'drizzle-orm'
import { z } from 'zod'

import {
  finalizeExistingQueueTask,
  type WorkersPipelinePayload,
} from '~~/server/services/cloudflare/finalize-upload'

export default defineEventHandler(async (event) => {
  await requireAdminSession(event)

  const { taskId } = await readValidatedBody(
    event,
    z.object({ taskId: z.number().int().positive() }).parse,
  )

  const db = useDB()
  const task = await db
    .select()
    .from(tables.pipelineQueue)
    .where(eq(tables.pipelineQueue.id, taskId))
    .get()

  if (!task) {
    throw createError({ statusCode: 404, statusMessage: 'Task not found' })
  }
  if (task.status !== 'failed') {
    throw createError({
      statusCode: 400,
      statusMessage: `Task is not in failed status, current status: ${task.status}`,
    })
  }

  await db
    .update(tables.pipelineQueue)
    .set({
      status: 'pending',
      statusStage: null,
      errorMessage: null,
      attempts: 0,
      createdAt: new Date(),
      completedAt: null,
    })
    .where(eq(tables.pipelineQueue.id, taskId))

  const finalized = await finalizeExistingQueueTask(
    taskId,
    task.payload as WorkersPipelinePayload,
  )

  return {
    success: finalized.status === 'completed',
    message:
      finalized.status === 'completed'
        ? `Task ${taskId} was retried successfully`
        : finalized.status === 'in-stages'
          ? `Task ${taskId} was resubmitted and is still processing`
          : `Task ${taskId} failed again: ${finalized.error}`,
    taskId,
    status: finalized.status,
    warning: finalized.warning,
    error: finalized.error,
    payload: task.payload,
  }
})
