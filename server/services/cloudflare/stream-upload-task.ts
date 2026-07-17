import { and, eq, or, sql } from 'drizzle-orm'

import { tables, useDB } from '../../utils/db'
import { logger } from '../../utils/logger'
import { cloudflareStream } from './stream'

type Database = ReturnType<typeof useDB>
type QueueStatus = 'pending' | 'in-stages' | 'completed' | 'failed'

interface CreatePendingStreamUploadTaskInput {
  streamId: string
  photoId: string
  expectedCurrentStreamId: string | null
}

export interface AbandonStreamUploadTaskResult {
  found: boolean
  isStreamUpload: boolean
  changed: boolean
  status?: QueueStatus
}

async function deleteUntrackedStreamAsset(streamId: string): Promise<void> {
  try {
    await cloudflareStream.delete(streamId)
  } catch (cleanupError) {
    logger.chrono.error(
      `Failed to delete untracked Stream asset ${streamId}:`,
      cleanupError,
    )
  }
}

/**
 * Persist the Stream UID immediately after Cloudflare creates the draft.
 *
 * Cloudflare and D1 cannot share a transaction, so a failed D1 insert is
 * compensated by deleting the otherwise-untracked Stream asset.
 */
export async function createPendingStreamUploadTask(
  db: Database,
  input: CreatePendingStreamUploadTaskInput,
): Promise<number> {
  try {
    const queued = await db
      .insert(tables.pipelineQueue)
      .values({
        payload: {
          type: 'live-photo-video',
          storageKey: input.streamId,
          photoId: input.photoId,
          expectedCurrentStreamId: input.expectedCurrentStreamId,
        },
        priority: 0,
        maxAttempts: 3,
        status: 'pending',
      })
      .returning({ id: tables.pipelineQueue.id })
      .get()

    if (!queued?.id) {
      throw new Error('Failed to create D1 Stream processing ledger')
    }

    return queued.id
  } catch (error) {
    await deleteUntrackedStreamAsset(input.streamId)
    throw error
  }
}

/**
 * Mark a browser-abandoned direct upload terminal without deleting its Stream
 * UID. A network failure can be ambiguous (Cloudflare may already have the
 * bytes), and deleting here could race a webhook that is promoting the same
 * UID. The retained storageKey gives a later reconciler enough information to
 * clean up a confirmed orphan safely.
 */
export async function abandonStreamUploadTask(
  db: Database,
  taskId: number,
): Promise<AbandonStreamUploadTaskResult> {
  const updated = await db
    .update(tables.pipelineQueue)
    .set({
      status: 'failed',
      statusStage: null,
      errorMessage: 'Cloudflare Stream direct upload failed or was aborted',
      attempts: sql`${tables.pipelineQueue.attempts} + 1`,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(tables.pipelineQueue.id, taskId),
        or(
          eq(tables.pipelineQueue.status, 'pending'),
          eq(tables.pipelineQueue.status, 'in-stages'),
        ),
        sql`json_extract(${tables.pipelineQueue.payload}, '$.type') = 'live-photo-video'`,
      ),
    )
    .returning({ status: tables.pipelineQueue.status })
    .get()

  if (updated) {
    return {
      found: true,
      isStreamUpload: true,
      changed: true,
      status: updated.status,
    }
  }

  const current = await db
    .select({
      payload: tables.pipelineQueue.payload,
      status: tables.pipelineQueue.status,
    })
    .from(tables.pipelineQueue)
    .where(eq(tables.pipelineQueue.id, taskId))
    .get()

  if (!current) {
    return { found: false, isStreamUpload: false, changed: false }
  }

  return {
    found: true,
    isStreamUpload: current.payload.type === 'live-photo-video',
    changed: false,
    status: current.status,
  }
}
