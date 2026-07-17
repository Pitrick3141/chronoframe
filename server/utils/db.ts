import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import type { H3Event } from 'h3'

import * as schema from '../database/schema'

export const tables = schema
export { eq, and, or, inArray } from 'drizzle-orm'

type CloudflareBindings = {
  // Wrangler supplies the concrete D1Database type at deployment/typegen time.
  // Keep this boundary structural so local Nuxt type generation does not
  // depend on a generated worker-configuration.d.ts file.
  DB?: any
}

/**
 * Return a Drizzle client backed by the Worker D1 binding.
 *
 * `cloudflare:workers` exposes request-scoped bindings through a global proxy,
 * so callers do not need to thread the H3 event through every service.
 */
export function useDB(_event?: H3Event) {
  const { DB } = env as unknown as CloudflareBindings
  if (!DB) {
    throw new Error('Cloudflare D1 binding DB is not configured')
  }

  return drizzle(DB, { schema })
}

export type User = typeof schema.users.$inferSelect
export type Photo = typeof schema.photos.$inferSelect & {
  /** Safe presentation filename returned to public clients. */
  displayFilename?: string | null
  /** Admin-only route for immutable Hosted Images source bytes. */
  sourceUrl?: string | null
}
export type ImageUploadIntent = typeof schema.imageUploadIntents.$inferSelect
export type NewImageUploadIntent = typeof schema.imageUploadIntents.$inferInsert
export type StoredObject = typeof schema.objects.$inferSelect
export type NewStoredObject = typeof schema.objects.$inferInsert

export type PipelineQueueItem = typeof schema.pipelineQueue.$inferSelect
export type NewPipelineQueueItem = typeof schema.pipelineQueue.$inferInsert

export type PhotoReaction = typeof schema.photoReactions.$inferSelect

export type Album = typeof schema.albums.$inferSelect
export type NewAlbum = typeof schema.albums.$inferInsert
export type AlbumPhoto = typeof schema.albumPhotos.$inferSelect
export type NewAlbumPhoto = typeof schema.albumPhotos.$inferInsert
export type AlbumWithPhotos = Album & {
  photos: Photo[]
}
