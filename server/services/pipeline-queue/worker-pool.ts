import type { ConsolaInstance } from 'consola'
import { consola } from 'consola'
import { QueueManager } from './manager'

export interface WorkerPoolConfig {
  workerCount: number
  intervalMs: number
  intervalOffset: number
  enableLoadBalancing: boolean
  statsReportInterval: number
}

export interface WorkerStats {
  workerId: string
  isProcessing: boolean
  processedCount: number
  errorCount: number
  uptime: number
  successRate: number
}

export interface PoolStats {
  totalWorkers: number
  activeWorkers: number
  totalProcessed: number
  totalErrors: number
  averageSuccessRate: number
  workers: WorkerStats[]
}

/** @deprecated Workers do not support resident worker pools. */
export class WorkerPool {
  private readonly queue: QueueManager
  private readonly log: ConsolaInstance

  constructor(_config: Partial<WorkerPoolConfig> = {}, log?: ConsolaInstance) {
    this.log = log ?? consola.withTag('worker-pool')
    this.queue = QueueManager.getInstance('cloudflare', this.log)
  }

  async start(): Promise<void> {
    this.log.debug('WorkerPool start ignored on Cloudflare Workers.')
  }

  async stop(): Promise<void> {}

  getPoolStats(): PoolStats {
    return {
      totalWorkers: 0,
      activeWorkers: 0,
      totalProcessed: 0,
      totalErrors: 0,
      averageSuccessRate: 0,
      workers: [],
    }
  }

  async rebalance(): Promise<void> {}

  async getQueueStats() {
    return await this.queue.getQueueStats()
  }

  isActive(): boolean {
    return false
  }

  getWorkerCount(): number {
    return 0
  }

  getFirstWorker(): QueueManager {
    return this.queue
  }

  async addTask(
    payload: Parameters<QueueManager['addTask']>[0],
    options?: Parameters<QueueManager['addTask']>[1],
  ): Promise<number> {
    return await this.queue.addTask(payload, options)
  }

  async getTaskStatus(taskId: number) {
    return await this.queue.getTaskStatus(taskId)
  }
}
