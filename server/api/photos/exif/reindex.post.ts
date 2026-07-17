import { z } from 'zod'

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('single-reindex'),
    photoId: z.string().min(1),
  }),
  z.object({
    action: z.literal('batch-reindex'),
    photoIds: z.array(z.string().min(1)).max(500).optional(),
  }),
])

export default eventHandler(async (event) => {
  await requireAdminSession(event)
  const request = bodySchema.parse(await readBody(event))

  throw createError({
    statusCode: 501,
    statusMessage:
      'EXIF reindexing is unavailable for Cloudflare Hosted Images. The Workers binding exposes image details and transformations, not the original EXIF payload.',
    data: {
      success: false,
      workerCompatible: false,
      action: request.action,
      photoId:
        request.action === 'single-reindex' ? request.photoId : undefined,
      photoIds:
        request.action === 'batch-reindex' ? request.photoIds : undefined,
      remediation:
        'Extract and sanitize EXIF before uploading, then send the required metadata to the application for storage in D1.',
    },
  })
})
