import { env as workerEnv } from 'cloudflare:workers'

export type CloudflareBinaryBody =
  | ReadableStream<Uint8Array>
  | ArrayBuffer
  | ArrayBufferView
  | string
  | null
  | Blob

export interface CloudflareRasterImageInfo {
  fileSize: number
  format: string
  height: number
  width: number
}

export type CloudflareImageInfo =
  | { format: 'image/svg+xml' }
  | CloudflareRasterImageInfo

export interface CloudflareImageMetadata {
  id: string
  filename?: string
  uploaded?: string
  requireSignedURLs: boolean
  meta?: Record<string, unknown>
  variants: string[]
  draft?: boolean
  creator?: string
}

export interface CloudflareImageUploadOptions {
  id?: string
  filename?: string
  requireSignedURLs?: boolean
  metadata?: Record<string, unknown>
  creator?: string
  encoding?: 'base64'
}

export interface CloudflareImageUpdateOptions {
  requireSignedURLs?: boolean
  metadata?: Record<string, unknown>
  creator?: string
}

export interface CloudflareHostedImageHandle {
  details(): Promise<CloudflareImageMetadata | null>
  bytes(): Promise<ReadableStream<Uint8Array> | null>
  update(
    options: CloudflareImageUpdateOptions,
  ): Promise<CloudflareImageMetadata>
  delete(): Promise<boolean>
}

export interface CloudflareImageList {
  images: CloudflareImageMetadata[]
  cursor?: string
  listComplete: boolean
}

export interface CloudflareHostedImagesBinding {
  upload(
    image: ReadableStream<Uint8Array> | ArrayBuffer,
    options?: CloudflareImageUploadOptions,
  ): Promise<CloudflareImageMetadata>
  list(options?: {
    limit?: number
    cursor?: string
    sortOrder?: 'asc' | 'desc'
    creator?: string
  }): Promise<CloudflareImageList>
  image(imageId: string): CloudflareHostedImageHandle
}

export interface CloudflareImagesResult {
  response(): Response
}

export interface CloudflareImagesTransformer {
  transform(options: {
    width?: number
    height?: number
    fit?: 'scale-down' | 'contain' | 'pad' | 'squeeze' | 'cover' | 'crop'
  }): CloudflareImagesTransformer
  output(options: {
    format:
      | 'image/jpeg'
      | 'image/png'
      | 'image/gif'
      | 'image/webp'
      | 'image/avif'
      | 'rgb'
      | 'rgba'
    quality?: number
    anim?: boolean
  }): Promise<CloudflareImagesResult>
}

/**
 * Structural type for the Images binding. This deliberately includes the
 * hosted-image API added in 2026 so the application remains type-safe when an
 * workers-types package is only present transitively during installation.
 */
export interface CloudflareImagesBinding {
  hosted: CloudflareHostedImagesBinding
  info(image: ReadableStream<Uint8Array>): Promise<CloudflareImageInfo>
  input(image: ReadableStream<Uint8Array>): CloudflareImagesTransformer
}

export type CloudflareR2Range =
  | { offset: number; length?: number }
  | { length: number; offset?: number }
  | { suffix: number }

export interface CloudflareR2HTTPMetadata {
  contentType?: string
  contentLanguage?: string
  contentDisposition?: string
  contentEncoding?: string
  cacheControl?: string
  cacheExpiry?: Date
}

export interface CloudflareR2PutOptions {
  httpMetadata?: CloudflareR2HTTPMetadata | Headers
  customMetadata?: Record<string, string>
  storageClass?: 'Standard' | 'InfrequentAccess'
  onlyIf?:
    | Headers
    | {
        etagMatches?: string
        etagDoesNotMatch?: string
        uploadedBefore?: Date
        uploadedAfter?: Date
        secondsGranularity?: boolean
      }
}

export interface CloudflareR2Object {
  key: string
  version: string
  size: number
  etag: string
  httpEtag: string
  uploaded: Date
  httpMetadata?: CloudflareR2HTTPMetadata
  customMetadata?: Record<string, string>
  range?: CloudflareR2Range
  writeHttpMetadata(headers: Headers): void
}

export interface CloudflareR2ObjectBody extends CloudflareR2Object {
  body: ReadableStream<Uint8Array>
  bodyUsed: boolean
  arrayBuffer(): Promise<ArrayBuffer>
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
  json<T>(): Promise<T>
  blob(): Promise<Blob>
}

export interface CloudflareR2ListOptions {
  prefix?: string
  cursor?: string
  delimiter?: string
  limit?: number
  include?: Array<'httpMetadata' | 'customMetadata'>
}

export interface CloudflareR2Objects {
  objects: CloudflareR2Object[]
  truncated: boolean
  cursor?: string
  delimitedPrefixes?: string[]
}

export interface CloudflareR2Bucket {
  put(
    key: string,
    value: CloudflareBinaryBody,
    options?: CloudflareR2PutOptions,
  ): Promise<CloudflareR2Object | null>
  head(key: string): Promise<CloudflareR2Object | null>
  delete(keys: string | string[]): Promise<void>
  get(
    key: string,
    options?: {
      range?: CloudflareR2Range | Headers
      onlyIf?: Headers | Record<string, unknown>
      ssecKey?: ArrayBuffer | string
    },
  ): Promise<CloudflareR2ObjectBody | CloudflareR2Object | null>
  list(options?: CloudflareR2ListOptions): Promise<CloudflareR2Objects>
}

export interface CloudflareStreamDirectUploadCreateParams {
  maxDurationSeconds: number
  expiry?: string
  creator?: string
  meta?: Record<string, string>
  allowedOrigins?: string[]
  requireSignedURLs?: boolean
  thumbnailTimestampPct?: number
  scheduledDeletion?: string | null
  watermark?: { id: string }
}

export interface CloudflareStreamDirectUpload {
  uploadURL: string
  /** Workers binding field. */
  id?: string
  /** REST-compatible field used by some mocks and older adapters. */
  uid?: string
  watermark?: unknown
  scheduledDeletion?: string | null
}

export interface CloudflareStreamVideoStatus {
  state: string
  step?: string
  pctComplete?: string
  errorReasonCode?: string
  errorReasonText?: string
}

export interface CloudflareStreamVideo {
  id?: string
  uid?: string
  meta?: Record<string, string>
  status?: CloudflareStreamVideoStatus | string
  thumbnail?: string
  readyToStream?: boolean
  duration?: number
  size?: number
  created?: string
  modified?: string
  uploaded?: string | null
  hlsPlaybackUrl?: string
  dashPlaybackUrl?: string
  playback?: { hls?: string; dash?: string }
}

export interface CloudflareStreamVideoHandle {
  id?: string
  details(): Promise<CloudflareStreamVideo>
  /** Create a short-lived signed playback token for this video. */
  generateToken(): Promise<string>
  delete(): Promise<void>
}

export interface CloudflareStreamVideosBinding {
  list(options?: {
    limit?: number
    before?: string
    beforeComp?: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'
    after?: string
    afterComp?: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'
  }): Promise<CloudflareStreamVideo[]>
}

export interface CloudflareStreamBinding {
  videos: CloudflareStreamVideosBinding
  createDirectUpload(
    params: CloudflareStreamDirectUploadCreateParams,
  ): Promise<CloudflareStreamDirectUpload>
  video(id: string): CloudflareStreamVideoHandle
}

export interface CloudflareD1PreparedStatement {
  bind(...values: unknown[]): CloudflareD1PreparedStatement
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<unknown & { results?: T[] }>
  run<T = Record<string, unknown>>(): Promise<unknown & { results?: T[] }>
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>
}

export interface CloudflareD1Database {
  prepare(query: string): CloudflareD1PreparedStatement
  batch<T = unknown>(
    statements: CloudflareD1PreparedStatement[],
  ): Promise<Array<unknown & { results?: T[] }>>
  exec(query: string): Promise<unknown>
  dump(): Promise<ArrayBuffer>
}

export interface CloudflareAssetsBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export interface CloudflareBindings {
  DB: CloudflareD1Database
  IMAGES: CloudflareImagesBinding
  MEDIA_BUCKET: CloudflareR2Bucket
  STREAM: CloudflareStreamBinding
  ASSETS: CloudflareAssetsBinding
  CFRAME_STREAM_WEBHOOK_SECRET: string
}

export class MissingCloudflareBindingError extends Error {
  readonly binding: keyof CloudflareBindings

  constructor(binding: keyof CloudflareBindings) {
    super(`Cloudflare binding ${binding} is not configured`)
    this.name = 'MissingCloudflareBindingError'
    this.binding = binding
  }
}

/**
 * Returns the live Workers env proxy. Bindings are intentionally resolved for
 * each operation instead of being captured in a module-level client.
 */
export function getCloudflareBindings(): CloudflareBindings {
  return workerEnv as unknown as CloudflareBindings
}

export function requireCloudflareBinding<K extends keyof CloudflareBindings>(
  binding: K,
): CloudflareBindings[K] {
  const value = getCloudflareBindings()[binding]
  if (!value) throw new MissingCloudflareBindingError(binding)
  return value
}
