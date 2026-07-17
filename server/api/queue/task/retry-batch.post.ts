import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { z } from 'zod'

import {
  finalizeExistingQueueTask,
  type WorkersPipelinePayload,
} from '~~/server/services/cloudflare/finalize-upload'

// A photo retry currently consumes up to roughly seven D1 statements. Five
// tasks leave headroom beneath the Free-plan 50-query invocation ceiling for
// request initialization and page selection as well.
const MAX_RETRY_TASKS_PER_REQUEST = 5

export default defineEventHandler(async (event) => {
  await requireAdminSession(event)

  const { cursor, taskIds, retryAll } = await readValidatedBody(
    event,
    z
      .object({
        cursor: z.number().int().positive().optional(),
        taskIds: z
          .array(z.number().int().positive())
          .max(MAX_RETRY_TASKS_PER_REQUEST)
          .optional(),
        retryAll: z.boolean().optional().default(false),
      })
      .refine((body) => body.retryAll || Boolean(body.taskIds?.length), {
        message: 'Either taskIds or retryAll must be provided',
      })
      .refine((body) => body.retryAll || body.cursor === undefined, {
        message: 'cursor is only valid with retryAll',
      }).parse,
  )

  const db = useDB()
  const requestedIds = taskIds ?? []
  const selectedPage = retryAll
    ? await db
        .select()
        .from(tables.pipelineQueue)
        .where(
          cursor === undefined
            ? eq(tables.pipelineQueue.status, 'failed')
            : and(
                eq(tables.pipelineQueue.status, 'failed'),
                gt(tables.pipelineQueue.id, cursor),
              ),
        )
        .orderBy(asc(tables.pipelineQueue.id))
        .limit(MAX_RETRY_TASKS_PER_REQUEST + 1)
    : await db
        .select()
        .from(tables.pipelineQueue)
        .where(inArray(tables.pipelineQueue.id, [...new Set(requestedIds)]))

  const hasMore = retryAll && selectedPage.length > MAX_RETRY_TASKS_PER_REQUEST
  const selected = selectedPage.slice(0, MAX_RETRY_TASKS_PER_REQUEST)
  const nextCursor = hasMore ? selected.at(-1)?.id : undefined

  const failedTasks = selected.filter((task) => task.status === 'failed')
  const skippedTasks = selected.filter((task) => task.status !== 'failed')
  const results = []

  for (const task of failedTasks) {
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
      .where(eq(tables.pipelineQueue.id, task.id))

    results.push(
      await finalizeExistingQueueTask(
        task.id,
        task.payload as WorkersPipelinePayload,
      ),
    )
  }

  const completedCount = results.filter(
    (result) => result.status === 'completed',
  ).length
  const pendingCount = results.filter(
    (result) => result.status === 'in-stages',
  ).length
  const failedCount = results.filter(
    (result) => result.status === 'failed',
  ).length

  return {
    success: failedCount === 0,
    message: `Retried ${results.length} tasks; ${completedCount} completed, ${pendingCount} processing, ${failedCount} failed`,
    retriedCount: results.length,
    completedCount,
    pendingCount,
    failedCount,
    skippedCount: skippedTasks.length,
    hasMore,
    nextCursor,
    results,
    skippedTasks: skippedTasks.map((task) => ({
      id: task.id,
      status: task.status,
      reason: `Task is not in failed status (current: ${task.status})`,
    })),
  }
})
