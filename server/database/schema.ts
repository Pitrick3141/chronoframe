import { sql } from 'drizzle-orm'
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type { NeededExif } from '~~/shared/types/photo'
import type { StorageConfig } from '../../shared/types/storage'

type PipelineQueuePayload =
  | {
      type: 'photo'
      storageKey: string
      eraseLocation?: boolean
    }
  | {
      type: 'live-photo-video'
      storageKey: string
      photoId?: string
      expectedCurrentStreamId?: string | null
    }
  | {
      type: 'photo-reverse-geocoding'
      photoId: string
      latitude?: number | null
      longitude?: number | null
    }
  | {
      type: 'photo-erase-location'
      photoId: string
    }

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('name').notNull().unique(),
  email: text('email').notNull().unique(),
  password: text('password'),
  avatar: text('avatar'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  isAdmin: integer('is_admin').default(0).notNull(),
})

export const photos = sqliteTable(
  'photos',
  {
    id: text('id').primaryKey().unique(),
    title: text('title'),
    description: text('description'),
    width: integer('width'),
    height: integer('height'),
    aspectRatio: real('aspect_ratio'),
    dateTaken: text('date_taken'),
    storageKey: text('storage_key'),
    thumbnailKey: text('thumbnail_key'),
    fileSize: integer('file_size'),
    lastModified: text('last_modified'),
    originalUrl: text('original_url'),
    thumbnailUrl: text('thumbnail_url'),
    thumbnailHash: text('thumbnail_hash'),
    tags: text('tags', { mode: 'json' }).$type<string[]>(),
    exif: text('exif', { mode: 'json' }).$type<NeededExif>(),
    // Cloudflare Images source metadata
    cloudflareImageId: text('cloudflare_image_id'),
    sourceFilename: text('source_filename'),
    sourceMimeType: text('source_mime_type'),
    sourceSize: integer('source_size'),
    // 地理位置信息
    latitude: real('latitude'),
    longitude: real('longitude'),
    country: text('country'),
    city: text('city'),
    locationName: text('location_name'),
    // LivePhoto 相关字段
    isLivePhoto: integer('is_live_photo').default(0).notNull(),
    livePhotoVideoUrl: text('live_photo_video_url'),
    livePhotoVideoKey: text('live_photo_video_key'),
    // Cloudflare Stream metadata (Live/Motion Photo video component)
    cloudflareStreamId: text('cloudflare_stream_id'),
    streamStatus: text('stream_status'),
    streamThumbnailUrl: text('stream_thumbnail_url'),
    streamDashUrl: text('stream_dash_url'),
    streamDuration: real('stream_duration'),
  },
  (t) => [
    uniqueIndex('idx_photos_cloudflare_image_id').on(t.cloudflareImageId),
    uniqueIndex('idx_photos_cloudflare_stream_id').on(t.cloudflareStreamId),
    index('idx_photos_date_taken').on(t.dateTaken),
    index('idx_photos_storage_key').on(t.storageKey),
    index('idx_photos_source_filename').on(t.sourceFilename),
  ],
)

/**
 * Durable, single-use upload intents for gallery images.
 *
 * The browser receives only the opaque intent ID. The immutable source
 * metadata lives in D1 so the raw PUT endpoint never trusts query-string
 * filename, MIME, size, or timestamp fields. A short lease makes the upload
 * claim atomic while still allowing a crashed Worker invocation to recover.
 */
export const imageUploadIntents = sqliteTable(
  'image_upload_intents',
  {
    id: text('id').primaryKey(),
    creatorId: integer('creator_id')
      .notNull()
      .references(() => users.id),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    expectedSize: integer('expected_size').notNull(),
    lastModified: text('last_modified'),
    eraseLocation: integer('erase_location', { mode: 'boolean' })
      .notNull()
      .default(false),
    status: text('status', {
      enum: ['pending', 'uploading', 'uploaded', 'finalized', 'failed'],
    })
      .notNull()
      .default('pending'),
    leaseToken: text('lease_token'),
    leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp' }),
    attemptCount: integer('attempt_count').notNull().default(0),
    imageId: text('image_id'),
    embeddedStreamId: text('embedded_stream_id'),
    queueTaskId: integer('queue_task_id'),
    actualSize: integer('actual_size'),
    lastError: text('last_error'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    uploadedAt: integer('uploaded_at', { mode: 'timestamp' }),
    finalizedAt: integer('finalized_at', { mode: 'timestamp' }),
    failedAt: integer('failed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('idx_image_upload_intents_image_id').on(t.imageId),
    uniqueIndex('idx_image_upload_intents_embedded_stream_id').on(
      t.embeddedStreamId,
    ),
    uniqueIndex('idx_image_upload_intents_queue_task_id').on(t.queueTaskId),
    index('idx_image_upload_intents_creator_status_created_at').on(
      t.creatorId,
      t.status,
      t.createdAt,
    ),
    index('idx_image_upload_intents_status_expires_at').on(
      t.status,
      t.expiresAt,
    ),
    index('idx_image_upload_intents_status_lease_expires_at').on(
      t.status,
      t.leaseExpiresAt,
    ),
  ],
)

/**
 * Metadata catalog for non-image, non-video files stored in R2.
 *
 * An intent is inserted as `pending` before bytes are accepted. Finalization
 * HEADs R2 and promotes the row to `ready` with authoritative object metadata.
 */
export const objects = sqliteTable(
  'objects',
  {
    id: text('id').primaryKey(),
    r2Key: text('r2_key').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    expectedSize: integer('expected_size').notNull(),
    size: integer('size'),
    etag: text('etag'),
    r2Version: text('r2_version'),
    status: text('status', { enum: ['pending', 'ready', 'deleting'] })
      .notNull()
      .default('pending'),
    uploadedAt: integer('uploaded_at', { mode: 'timestamp' }),
    finalizedAt: integer('finalized_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('idx_objects_r2_key').on(t.r2Key),
    index('idx_objects_status_created_at').on(t.status, t.createdAt),
  ],
)

export const pipelineQueue = sqliteTable(
  'pipeline_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    payload: text('payload', { mode: 'json' })
      .$type<PipelineQueuePayload>()
      .notNull()
      .default({
        type: 'photo',
        storageKey: '',
      } satisfies PipelineQueuePayload),
    priority: integer('priority').default(0).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(3).notNull(),
    status: text('status', {
      enum: [
        'pending', // Waiting to be processed
        'in-stages', // Currently being processed
        'completed', // Successfully processed
        'failed', // Processing failed
      ],
    })
      .notNull()
      .default('pending'),
    statusStage: text('status_stage', {
      enum: [
        'preprocessing',
        'metadata',
        'thumbnail',
        'exif',
        'motion-photo',
        'reverse-geocoding',
        'live-photo',
        'location-erase',
      ],
    }),
    errorMessage: text('error_message'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (t) => [
    index('idx_pipeline_queue_status_priority_created_at').on(
      t.status,
      t.priority,
      t.createdAt,
    ),
  ],
)

// 照片表态表
export const photoReactions = sqliteTable(
  'photo_reactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    reactionType: text('reaction_type', {
      enum: [
        'like',
        'love',
        'amazing',
        'funny',
        'wow',
        'sad',
        'fire',
        'sparkle',
      ],
    }).notNull(),
    // 使用指纹而不是 IP 地址，更准确且支持匿名用户
    fingerprint: text('fingerprint').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex('idx_photo_reactions_photo_fingerprint').on(
      t.photoId,
      t.fingerprint,
    ),
    index('idx_photo_reactions_fingerprint_created_at').on(
      t.fingerprint,
      t.createdAt,
    ),
    index('idx_photo_reactions_photo_type').on(t.photoId, t.reactionType),
  ],
)

// 相簿表
export const albums = sqliteTable('albums', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description'),
  coverPhotoId: text('cover_photo_id').references(() => photos.id, {
    onDelete: 'set null',
  }),
  isHidden: integer('is_hidden', { mode: 'boolean' }).default(false).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// 相簿-照片 多对多关系表
export const albumPhotos = sqliteTable(
  'album_photos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    albumId: integer('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    position: real('position').notNull().default(1000000),
    addedAt: integer('added_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index('idx_album_photos_album_position').on(t.albumId, t.position),
    index('idx_album_photos_photo_album').on(t.photoId, t.albumId),
    uniqueIndex('idx_album_photos_album_photo').on(t.albumId, t.photoId),
  ],
)

export const settings = sqliteTable(
  'settings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    namespace: text('namespace').notNull().default('common'),
    key: text('key').notNull(),
    type: text('type', {
      enum: ['string', 'number', 'boolean', 'json'],
    }).notNull(),
    value: text('value'),
    defaultValue: text('default_value'),
    label: text('label'),
    description: text('description'),
    isPublic: integer('is_public', { mode: 'boolean' })
      .default(false)
      .notNull(),
    isReadonly: integer('is_readonly', { mode: 'boolean' })
      .default(false)
      .notNull(),
    isSecret: integer('is_secret', { mode: 'boolean' })
      .default(false)
      .notNull(),
    enum: text('enum', { mode: 'json' }).$type<string[] | null>(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedBy: integer('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [uniqueIndex('idx_namespace_key').on(t.namespace, t.key)],
)

export const settings_storage_providers = sqliteTable(
  'settings_storage_providers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    provider: text('provider', {
      enum: ['s3', 'local', 'openlist'],
    }).notNull(),
    config: text('config', { mode: 'json' }).$type<StorageConfig>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
)
