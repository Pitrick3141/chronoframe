import {
  requireCloudflareBinding,
  type CloudflareStreamVideo,
  type CloudflareStreamVideoStatus,
} from '../../utils/cloudflare-bindings'

export const STREAM_MAX_DURATION_SECONDS = 36_000
export const STREAM_BASIC_UPLOAD_MAX_BYTES = 200_000_000

export type StreamSourceMetadata = Record<string, string> & {
  sourceFilename: string
  sourceMimeType: string
  sourceSize: string
}

export interface StreamDirectUploadOptions {
  maxDurationSeconds: number
  meta: StreamSourceMetadata
  requireSignedURLs?: boolean
  expiry?: string
  creator?: string
  allowedOrigins?: string[]
  thumbnailTimestampPct?: number
}

export interface StreamDirectUploadResult {
  /** Canonical video identifier used by the Workers binding. */
  id: string
  /** Alias retained for REST/direct-upload response compatibility. */
  uid: string
  /** One-time URL that accepts a basic multipart POST upload. */
  uploadURL: string
}

export interface StreamPlayback {
  hls?: string
  dash?: string
}

export interface StreamVideoDetails {
  id: string
  uid: string
  meta: Record<string, string>
  status: CloudflareStreamVideoStatus
  playback: StreamPlayback
  thumbnail?: string
  readyToStream: boolean
  duration?: number
  size?: number
  created?: string
  modified?: string
  uploaded?: string | null
}

export interface StreamVideoListOptions {
  limit?: number
  before?: string
  beforeComp?: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'
  after?: string
  afterComp?: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'
}

export class InvalidStreamUploadError extends Error {
  readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'InvalidStreamUploadError'
  }
}

export async function uploadStreamDirectFile(
  uploadURL: string,
  bytes: Uint8Array,
  filename: string,
): Promise<void> {
  if (bytes.byteLength >= STREAM_BASIC_UPLOAD_MAX_BYTES) {
    throw new InvalidStreamUploadError(
      'Cloudflare Stream basic uploads must be smaller than 200 MB',
    )
  }

  const form = new FormData()
  form.set(
    'file',
    new Blob([bytes.slice().buffer], { type: 'video/mp4' }),
    requiredString(filename, 'Stream source filename'),
  )

  // A direct-upload URL is single use, so this request is intentionally never
  // retried. The caller creates a fresh asset if a user explicitly retries.
  const response = await fetch(requiredString(uploadURL, 'Stream upload URL'), {
    method: 'POST',
    body: form,
  })
  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 500)
    throw new Error(
      `Cloudflare Stream upload failed (${response.status})${responseText ? `: ${responseText}` : ''}`,
    )
  }
}

function requiredString(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new InvalidStreamUploadError(`${field} is required`)
  }
  return normalized
}

function videoId(
  value: { id?: string; uid?: string },
  operation: string,
): string {
  const id = value.id || value.uid
  if (!id) {
    throw new Error(`Cloudflare Stream ${operation} response has no video ID`)
  }
  return id
}

function normalizeStatus(
  status: CloudflareStreamVideo['status'],
  readyToStream: boolean,
): CloudflareStreamVideoStatus {
  if (status && typeof status === 'object') return status
  return {
    state:
      typeof status === 'string'
        ? status
        : readyToStream
          ? 'ready'
          : 'pendingupload',
  }
}

function normalizeDetails(video: CloudflareStreamVideo): StreamVideoDetails {
  const id = videoId(video, 'details')
  const readyToStream = video.readyToStream === true
  return {
    id,
    uid: id,
    meta: video.meta ?? {},
    status: normalizeStatus(video.status, readyToStream),
    playback: {
      hls: video.hlsPlaybackUrl || video.playback?.hls,
      dash: video.dashPlaybackUrl || video.playback?.dash,
    },
    thumbnail: video.thumbnail || undefined,
    readyToStream,
    duration:
      typeof video.duration === 'number' && video.duration >= 0
        ? video.duration
        : undefined,
    size: typeof video.size === 'number' ? video.size : undefined,
    created: video.created,
    modified: video.modified,
    uploaded: video.uploaded,
  }
}

export async function createStreamDirectUpload(
  options: StreamDirectUploadOptions,
): Promise<StreamDirectUploadResult> {
  if (
    !Number.isInteger(options.maxDurationSeconds) ||
    options.maxDurationSeconds < 1 ||
    options.maxDurationSeconds > STREAM_MAX_DURATION_SECONDS
  ) {
    throw new InvalidStreamUploadError(
      `maxDurationSeconds must be an integer between 1 and ${STREAM_MAX_DURATION_SECONDS}`,
    )
  }
  if (options.requireSignedURLs === false) {
    throw new InvalidStreamUploadError(
      'ChronoFrame Stream uploads must require signed playback URLs',
    )
  }

  const meta: StreamSourceMetadata = {
    ...options.meta,
    sourceFilename: requiredString(
      options.meta.sourceFilename,
      'meta.sourceFilename',
    ),
    sourceMimeType: requiredString(
      options.meta.sourceMimeType,
      'meta.sourceMimeType',
    ),
    sourceSize: requiredString(options.meta.sourceSize, 'meta.sourceSize'),
  }

  const directUpload = await requireCloudflareBinding(
    'STREAM',
  ).createDirectUpload({
    maxDurationSeconds: options.maxDurationSeconds,
    meta,
    requireSignedURLs: true,
    expiry: options.expiry,
    creator: options.creator,
    allowedOrigins: options.allowedOrigins,
    thumbnailTimestampPct: options.thumbnailTimestampPct,
  })

  const id = videoId(directUpload, 'direct upload')
  if (!directUpload.uploadURL) {
    throw new Error(
      'Cloudflare Stream direct upload response has no upload URL',
    )
  }
  return { id, uid: id, uploadURL: directUpload.uploadURL }
}

export async function getStreamVideoDetails(
  id: string,
): Promise<StreamVideoDetails> {
  const normalizedId = requiredString(id, 'Stream video ID')
  const details = await requireCloudflareBinding('STREAM')
    .video(normalizedId)
    .details()
  return normalizeDetails(details)
}

export async function listStreamVideos(
  options: StreamVideoListOptions = {},
): Promise<StreamVideoDetails[]> {
  const videos = await requireCloudflareBinding('STREAM').videos.list(options)
  return videos.map(normalizeDetails)
}

export async function deleteStreamVideo(id: string): Promise<void> {
  const normalizedId = requiredString(id, 'Stream video ID')
  await requireCloudflareBinding('STREAM').video(normalizedId).delete()
}

export async function generateStreamPlaybackToken(id: string): Promise<string> {
  const normalizedId = requiredString(id, 'Stream video ID')
  const token = await requireCloudflareBinding('STREAM')
    .video(normalizedId)
    .generateToken()
  return requiredString(token, 'Stream playback token')
}

/**
 * Replace only the exact video-ID pathname segment returned by Stream. Never
 * use a substring replacement: an ID could otherwise alter a hostname, query,
 * or an unrelated path component.
 */
export function signedStreamHlsUrl(
  playbackUrl: string,
  videoIdValue: string,
  tokenValue: string,
): string {
  const videoId = requiredString(videoIdValue, 'Stream video ID')
  const token = requiredString(tokenValue, 'Stream playback token')
  let url: URL
  try {
    url = new URL(requiredString(playbackUrl, 'Stream HLS playback URL'))
  } catch {
    throw new Error('Cloudflare Stream returned an invalid HLS playback URL')
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Cloudflare Stream returned an unsafe HLS playback URL')
  }

  const segments = url.pathname.split('/')
  const matchingIndexes: number[] = []
  for (let index = 1; index < segments.length; index += 1) {
    try {
      if (decodeURIComponent(segments[index] ?? '') === videoId) {
        matchingIndexes.push(index)
      }
    } catch {
      throw new Error('Cloudflare Stream returned a malformed HLS path')
    }
  }

  if (
    matchingIndexes.length !== 1 ||
    !segments
      .slice(matchingIndexes[0]! + 1)
      .join('/')
      .endsWith('.m3u8')
  ) {
    throw new Error(
      'Cloudflare Stream HLS URL does not contain the expected video ID segment',
    )
  }

  segments[matchingIndexes[0]!] = encodeURIComponent(token)
  url.pathname = segments.join('/')
  return url.toString()
}

export const cloudflareStream = {
  createDirectUpload: createStreamDirectUpload,
  uploadFile: uploadStreamDirectFile,
  details: getStreamVideoDetails,
  list: listStreamVideos,
  generateToken: generateStreamPlaybackToken,
  delete: deleteStreamVideo,
}

/** Short alias for callers that already use the `hostedImages` / `r2` style. */
export const stream = cloudflareStream
