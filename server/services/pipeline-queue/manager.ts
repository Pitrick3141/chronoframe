import type { ConsolaInstance } from 'consola'
import { eq, sql } from 'drizzle-orm'
import {
  tables,
  useDB,
  type NewPipelineQueueItem,
  type PipelineQueueItem,
} from '../../utils/db'
import { logger } from '../../utils/logger'

/**
 * D1-backed compatibility facade for legacy callers.
 *
 * It deliberately performs no polling. Queue execution belongs to an
 * explicit request or Cloudflare Queue consumer so an isolate can terminate.
 */
export class QueueManager {
  private static readonly instances = new Map<string, QueueManager>()
  private readonly startedAt = Date.now()
  private readonly log: ConsolaInstance

  static getInstance(
    workerId = 'default',
    log?: ConsolaInstance,
  ): QueueManager {
    let instance = QueueManager.instances.get(workerId)
    if (!instance) {
      instance = new QueueManager(workerId, log)
      QueueManager.instances.set(workerId, instance)
    }
    return instance
  }

  static getAllInstances(): QueueManager[] {
    return [...QueueManager.instances.values()]
  }

  private constructor(
    private readonly workerId: string,
    log?: ConsolaInstance,
  ) {
    this.log = log?.withTag(workerId) ?? logger.dynamic(`queue-${workerId}`)
  }

  getWorkerId(): string {
    return this.workerId
  }

  getStats() {
    return {
      workerId: this.workerId,
      isProcessing: false,
      processedCount: 0,
      errorCount: 0,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      successRate: 0,
    }
  }

  async addTask(
    payload: PipelineQueueItem['payload'],
    options?: Partial<NewPipelineQueueItem>,
  ): Promise<number> {
    const result = await useDB()
      .insert(tables.pipelineQueue)
      .values({ ...options, payload })
      .returning({ id: tables.pipelineQueue.id })
      .get()

    if (!result) throw new Error('Failed to persist queue task in D1')
    return result.id
  }

  async getTaskStatus(taskId: number) {
    return await useDB()
      .select()
      .from(tables.pipelineQueue)
      .where(eq(tables.pipelineQueue.id, taskId))
      .get()
  }

  async getNextTask(): Promise<PipelineQueueItem | null> {
    this.log.debug('Polling is disabled on Workers; no task was claimed.')
    return null
  }

  async updateTaskStage(
    taskId: number,
    stage: PipelineQueueItem['statusStage'],
  ): Promise<void> {
    await useDB()
      .update(tables.pipelineQueue)
      .set({ statusStage: stage })
      .where(eq(tables.pipelineQueue.id, taskId))
  }

  async markTaskCompleted(taskId: number): Promise<void> {
    await useDB()
      .update(tables.pipelineQueue)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(tables.pipelineQueue.id, taskId))
  }

  async markTaskFailed(taskId: number, errorMessage?: string): Promise<void> {
    const task = await this.getTaskStatus(taskId)
    if (!task) return

    const attempts = task.attempts + 1
    await useDB()
      .update(tables.pipelineQueue)
      .set({
        status: attempts < task.maxAttempts ? 'pending' : 'failed',
        attempts,
        errorMessage: errorMessage || 'Unknown error',
      })
      .where(eq(tables.pipelineQueue.id, taskId))
  }

  startProcessing(_intervalMs = 3000): void {
    this.log.debug(
      'Resident queue processing is disabled; use a Cloudflare Queue consumer.',
    )
  }

  stopProcessing(): void {}

  async getQueueStats(): Promise<Record<string, number>> {
    const rows = await useDB()
      .select({
        status: tables.pipelineQueue.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(tables.pipelineQueue)
      .groupBy(tables.pipelineQueue.status)

    return Object.fromEntries(rows.map((row) => [row.status, row.count]))
  }
}
