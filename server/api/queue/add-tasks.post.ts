import { z } from 'zod'

import { createAndFinalizeQueueTask } from '~~/server/services/cloudflare/finalize-upload'

const payloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('photo'),
    storageKey: z.string().min(1),
    eraseLocation: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('live-photo-video'),
    storageKey: z.string().min(1),
    photoId: z.string().min(1).optional(),
    expectedCurrentStreamId: z.string().min(1).nullable().optional(),
  }),
  z.object({
    type: z.literal('photo-reverse-geocoding'),
    photoId: z.string().min(1),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
  }),
  z.object({
    type: z.literal('photo-erase-location'),
    photoId: z.string().min(1),
  }),
])

const bodySchema = z.object({
  tasks: z
    .array(
      z.object({
        payload: payloadSchema,
        priority: z.number().int().min(0).max(9).optional(),
        maxAttempts: z.number().int().min(1).max(5).optional(),
      }),
    )
    .min(1)
    // Synchronous Workers processing is deliberately bounded.
    .max(100),
  defaultPriority: z.number().int().min(0).max(9).optional().default(0),
  defaultMaxAttempts: z.number().int().min(1).max(5).optional().default(3),
})

export default defineEventHandler(async (event) => {
  await requireAdminSession(event)

  const { tasks, defaultPriority, defaultMaxAttempts } =
    await readValidatedBody(event, bodySchema.parse)

  const results: Array<Record<string, unknown>> = []
  const errors: Array<Record<string, unknown>> = []

  // Keep D1/R2/Images operations sequential to remain below the Workers
  // simultaneous outbound connection limit.
  for (const [index, task] of tasks.entries()) {
    try {
      const finalized = await createAndFinalizeQueueTask(task.payload, {
        priority: task.priority ?? defaultPriority,
        maxAttempts: task.maxAttempts ?? defaultMaxAttempts,
      })

      const item = {
        index,
        taskId: finalized.taskId,
        payload: task.payload,
        success: finalized.status === 'completed',
        status: finalized.status,
        warning: finalized.warning,
        error: finalized.error,
      }
      results.push(item)
      if (finalized.status === 'failed') errors.push(item)
    } catch (error) {
      errors.push({
        index,
        payload: task.payload,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  const successCount = results.filter((item) => item.success).length
  return {
    success: errors.length === 0,
    totalTasks: tasks.length,
    successCount,
    errorCount: errors.length,
    results,
    errors: errors.length > 0 ? errors : undefined,
    message: `Finalized ${successCount} of ${tasks.length} tasks`,
  }
})
