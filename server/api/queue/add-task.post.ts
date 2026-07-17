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
  payload: payloadSchema,
  priority: z.number().int().min(0).max(9).optional().default(0),
  maxAttempts: z.number().int().min(1).max(5).optional().default(3),
})

export default defineEventHandler(async (event) => {
  await requireAdminSession(event)

  const { payload, priority, maxAttempts } = await readValidatedBody(
    event,
    bodySchema.parse,
  )

  try {
    const finalized = await createAndFinalizeQueueTask(payload, {
      priority,
      maxAttempts,
    })

    return {
      // `success` retains its historical meaning: the task was accepted and
      // can be polled. `processingSuccess` reports synchronous finalization.
      success: true,
      processingSuccess: finalized.status === 'completed',
      taskId: finalized.taskId,
      status: finalized.status,
      photoId: finalized.photoId,
      warning: finalized.warning,
      error: finalized.error,
      message:
        finalized.status === 'completed'
          ? 'Task finalized successfully'
          : finalized.status === 'in-stages'
            ? 'Task was recorded and is still processing'
            : 'Task was recorded but finalization failed',
      payload,
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error

    throw createError({
      statusCode: 500,
      statusMessage:
        error instanceof Error ? error.message : 'Failed to record queue task',
    })
  }
})
