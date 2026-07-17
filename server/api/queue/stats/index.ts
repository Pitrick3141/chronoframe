import { sql } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdminSession(event)

  const rows = await useDB()
    .select({
      status: tables.pipelineQueue.status,
      count: sql<number>`count(*)`,
    })
    .from(tables.pipelineQueue)
    .groupBy(tables.pipelineQueue.status)

  const queue = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    total: 0,
  }

  for (const row of rows) {
    const count = Number(row.count)
    queue.total += count
    if (row.status === 'in-stages') queue.processing = count
    else queue[row.status] = count
  }

  return {
    timestamp: new Date().toISOString(),
    pool: {
      // There is no process-global worker pool in a Cloudflare isolate.
      isActive: false,
      workerCount: 0,
      mode: 'request-synchronous',
    },
    queue,
  }
})
