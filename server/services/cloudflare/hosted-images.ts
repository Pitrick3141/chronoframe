import {
  requireCloudflareBinding,
  type CloudflareImageInfo,
  type CloudflareImageMetadata,
} from '../../utils/cloudflare-bindings'

export const HOSTED_IMAGE_MAX_BYTES = 10 * 1024 * 1024
// Compound JPEG Motion Photos may include an appended video. The upload
// endpoint buffers at most this much, extracts the video first, and still
// enforces HOSTED_IMAGE_MAX_BYTES on the static image sent to Images.
export const MOTION_PHOTO_SOURCE_MAX_BYTES = 25 * 1024 * 1024
export const HOSTED_IMAGE_MAX_METADATA_BYTES = 1024

export type HostedImageBody =
  | ReadableStream<Uint8Array>
  | ArrayBuffer
  | ArrayBufferView
  | Blob

export interface HostedImageUploadOptions {
  metadata?: Record<string, unknown>
  contentType?: string
  filename?: string
  creator?: string
  /** Dimension hints are accepted for caller compatibility but never trusted. */
  width?: number
  height?: number
}

export interface HostedImageDetails extends CloudflareImageMetadata {
  width?: number
  height?: number
  fileSize?: number
  format?: string
  contentType?: string
  info?: CloudflareImageInfo
}

export interface HostedImageUploadResult extends HostedImageDetails {
  fileSize: number
  format: string
  info: CloudflareImageInfo
}

export interface HostedImageListOptions {
  limit?: number
  cursor?: string
  sortOrder?: 'asc' | 'desc'
  creator?: string
}

export interface HostedImageListResult {
  images: HostedImageDetails[]
  cursor?: string
  listComplete: boolean
}

export class HostedImageTooLargeError extends Error {
  readonly statusCode = 413
  readonly maxBytes = HOSTED_IMAGE_MAX_BYTES
  readonly actualBytes: number

  constructor(actualBytes: number) {
    super(
      `Hosted Image exceeds the ${HOSTED_IMAGE_MAX_BYTES} byte upload limit`,
    )
    this.name = 'HostedImageTooLargeError'
    this.actualBytes = actualBytes
  }
}

export class InvalidHostedImageError extends Error {
  readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'InvalidHostedImageError'
  }
}

function metadataSize(metadata: Record<string, unknown>): number {
  try {
    return new TextEncoder().encode(JSON.stringify(metadata)).byteLength
  } catch {
    throw new InvalidHostedImageError(
      'Hosted Image metadata must be JSON serializable',
    )
  }
}

function assertSize(size: number): void {
  if (size > HOSTED_IMAGE_MAX_BYTES) {
    throw new HostedImageTooLargeError(size)
  }
}

async function streamToArrayBuffer(
  stream: ReadableStream<Uint8Array>,
): Promise<ArrayBuffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      size += value.byteLength
      if (size > HOSTED_IMAGE_MAX_BYTES) {
        await reader.cancel('Hosted Image upload is too large')
        throw new HostedImageTooLargeError(size)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes.buffer
}

async function toArrayBuffer(body: HostedImageBody): Promise<ArrayBuffer> {
  if (body instanceof ArrayBuffer) {
    assertSize(body.byteLength)
    return body.slice(0)
  }

  if (ArrayBuffer.isView(body)) {
    assertSize(body.byteLength)
    const bytes = new Uint8Array(body.byteLength)
    bytes.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
    return bytes.buffer
  }

  if (body instanceof Blob) {
    assertSize(body.size)
    return body.arrayBuffer()
  }

  return streamToArrayBuffer(body)
}

function bodyStream(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  const stream = new Response(bytes).body
  if (!stream) throw new InvalidHostedImageError('Image body is empty')
  return stream
}

function numberFromMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key]
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function stringFromMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key]
  return typeof value === 'string' && value ? value : undefined
}

function enrichDetails(metadata: CloudflareImageMetadata): HostedImageDetails {
  const width = numberFromMetadata(metadata.meta, 'width')
  const height = numberFromMetadata(metadata.meta, 'height')
  const fileSize =
    numberFromMetadata(metadata.meta, 'fileSize') ??
    numberFromMetadata(metadata.meta, 'sourceSize')
  const format = stringFromMetadata(metadata.meta, 'format')
  const contentType =
    stringFromMetadata(metadata.meta, 'contentType') ??
    stringFromMetadata(metadata.meta, 'sourceMimeType')

  const info =
    width !== undefined &&
    height !== undefined &&
    fileSize !== undefined &&
    format
      ? { width, height, fileSize, format }
      : undefined

  return {
    ...metadata,
    width,
    height,
    fileSize,
    format,
    contentType,
    info,
  }
}

function inferredContentType(format: string): string {
  if (format.includes('/')) return format
  const normalized = format.toLowerCase() === 'jpg' ? 'jpeg' : format
  return `image/${normalized.toLowerCase()}`
}

export async function uploadHostedImage(
  body: HostedImageBody,
  options: HostedImageUploadOptions = {},
): Promise<HostedImageUploadResult> {
  const images = requireCloudflareBinding('IMAGES')
  const bytes = await toArrayBuffer(body)
  assertSize(bytes.byteLength)

  const info = await images.info(bodyStream(bytes))
  const rasterInfo =
    'width' in info && 'height' in info && 'fileSize' in info ? info : null
  if (
    rasterInfo &&
    (!Number.isFinite(rasterInfo.width) ||
      !Number.isFinite(rasterInfo.height) ||
      rasterInfo.width <= 0 ||
      rasterInfo.height <= 0)
  ) {
    throw new InvalidHostedImageError(
      'Cloudflare could not read image dimensions',
    )
  }

  const fileSize = rasterInfo?.fileSize || bytes.byteLength
  const contentType = options.contentType || inferredContentType(info.format)
  const metadata = {
    ...options.metadata,
    ...(rasterInfo
      ? { width: rasterInfo.width, height: rasterInfo.height }
      : {}),
    fileSize,
    format: info.format,
    contentType,
  }
  if (metadataSize(metadata) > HOSTED_IMAGE_MAX_METADATA_BYTES) {
    throw new InvalidHostedImageError(
      `Hosted Image metadata exceeds ${HOSTED_IMAGE_MAX_METADATA_BYTES} bytes`,
    )
  }

  const uploaded = await images.hosted.upload(bytes, {
    filename: options.filename,
    creator: options.creator,
    metadata,
    // Cloudflare does not allow signed delivery for custom IDs. Never pass an
    // ID here: the platform-generated ID plus this flag prevents a caller who
    // learns the ID from bypassing ChronoFrame's D1 authorization proxy.
    requireSignedURLs: true,
  })

  return {
    ...uploaded,
    meta: uploaded.meta ?? metadata,
    width: rasterInfo?.width,
    height: rasterInfo?.height,
    fileSize,
    format: info.format,
    contentType,
    info: rasterInfo ? { ...rasterInfo, fileSize } : info,
  }
}

export async function listHostedImages(
  options: HostedImageListOptions = {},
): Promise<HostedImageListResult> {
  const result = await requireCloudflareBinding('IMAGES').hosted.list(options)
  return {
    ...result,
    images: result.images.map(enrichDetails),
  }
}

export async function getHostedImageDetails(
  id: string,
): Promise<HostedImageDetails | null> {
  const details = await requireCloudflareBinding('IMAGES')
    .hosted.image(id)
    .details()
  return details ? enrichDetails(details) : null
}

export async function getHostedImageBytes(
  id: string,
): Promise<ReadableStream<Uint8Array> | null> {
  return requireCloudflareBinding('IMAGES').hosted.image(id).bytes()
}

export async function deleteHostedImage(id: string): Promise<boolean> {
  return requireCloudflareBinding('IMAGES').hosted.image(id).delete()
}

export async function getHostedImageThumbnail(
  id: string,
  width = 600,
): Promise<Response | null> {
  const images = requireCloudflareBinding('IMAGES')
  const bytes = await images.hosted.image(id).bytes()
  if (!bytes) return null

  const output = await images
    .input(bytes)
    .transform({ width, fit: 'scale-down' })
    .output({ format: 'image/webp', quality: 85 })
  return output.response()
}

export const hostedImages = {
  upload: uploadHostedImage,
  list: listHostedImages,
  details: getHostedImageDetails,
  bytes: getHostedImageBytes,
  delete: deleteHostedImage,
  thumbnail: getHostedImageThumbnail,
}
