const IMAGE_CONTENT_TYPES = new Map<string, string>([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.hif', 'image/heif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.webp', 'image/webp'],
])

const VIDEO_CONTENT_TYPES = new Map<string, string>([
  ['.3g2', 'video/3gpp2'],
  ['.3gp', 'video/3gpp'],
  ['.avi', 'video/x-msvideo'],
  ['.f4v', 'video/mp4'],
  ['.flv', 'video/x-flv'],
  ['.gxf', 'video/mpeg'],
  ['.lxf', 'video/mpeg'],
  ['.m2p', 'video/mpeg'],
  ['.m2ts', 'video/mp2t'],
  ['.m2v', 'video/mpeg'],
  ['.m4v', 'video/mp4'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.mpeg', 'video/mpeg'],
  ['.mpg', 'video/mpeg'],
  ['.mts', 'video/mp2t'],
  ['.mxf', 'application/mxf'],
  ['.ogv', 'video/ogg'],
  ['.qt', 'video/quicktime'],
  ['.ts', 'video/mp2t'],
  ['.vob', 'video/mpeg'],
  ['.webm', 'video/webm'],
  ['.wmv', 'video/x-ms-wmv'],
])

export type CloudflareMediaKind = 'image' | 'video' | 'object'

export interface ClassifiedMedia {
  kind: CloudflareMediaKind
  contentType: string
  extension: string
}

export function normalizeContentType(contentType?: string | null): string {
  return (
    contentType?.split(';', 1)[0]?.trim().toLowerCase() ||
    'application/octet-stream'
  )
}

export function fileExtension(fileName: string): string {
  const basename = fileName.replaceAll('\\', '/').split('/').pop() ?? ''
  const dot = basename.lastIndexOf('.')
  return dot > 0 ? basename.slice(dot).toLowerCase() : ''
}

/**
 * Returns true when the filename uses a container that must be uploaded to
 * Cloudflare Stream, even when the browser omits the MIME type or reports it
 * as application/octet-stream.
 */
export function isCloudflareStreamContainer(fileName: string): boolean {
  return VIDEO_CONTENT_TYPES.has(fileExtension(fileName))
}

export function classifyMedia(
  fileName: string,
  contentType?: string | null,
): ClassifiedMedia {
  const normalizedType = normalizeContentType(contentType)
  const extension = fileExtension(fileName)
  const videoType = VIDEO_CONTENT_TYPES.get(extension)
  const imageType = IMAGE_CONTENT_TYPES.get(extension)

  // Treat either a video MIME or a known video extension as authoritative so a
  // misleading filename/MIME pair can never be routed into R2.
  if (normalizedType.startsWith('video/') || videoType) {
    return {
      kind: 'video',
      contentType: normalizedType.startsWith('video/')
        ? normalizedType
        : videoType!,
      extension,
    }
  }

  if (normalizedType.startsWith('image/') || imageType) {
    return {
      kind: 'image',
      contentType: normalizedType.startsWith('image/')
        ? normalizedType
        : imageType!,
      extension,
    }
  }

  return { kind: 'object', contentType: normalizedType, extension }
}
