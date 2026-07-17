import { createError } from 'h3'

import type { StoredObject } from '~~/server/utils/db'

import {
  classifyMedia,
  normalizeContentType,
} from './media-classification'

const OBJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OBJECT_KEY_PREFIX = 'objects/catalog/'
const CONTENT_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i

function hasWellFormedUnicode(value: string): boolean {
  const nativeIsWellFormed = (
    String.prototype as unknown as {
      isWellFormed?: (this: string) => boolean
    }
  ).isWellFormed

  if (nativeIsWellFormed) return nativeIsWellFormed.call(value)

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }

  return true
}

export function parseObjectId(value: string | undefined): string {
  if (!value || !OBJECT_ID_PATTERN.test(value)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid object ID',
    })
  }

  return value.toLowerCase()
}

export function objectKeyForId(objectId: string): string {
  if (!OBJECT_ID_PATTERN.test(objectId)) {
    throw new TypeError('Cannot create an R2 key from an invalid object ID')
  }

  return `${OBJECT_KEY_PREFIX}${objectId.toLowerCase()}`
}

export function normalizeObjectFilename(value: string): string {
  if (!hasWellFormedUnicode(value)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid object filename',
    })
  }

  const filename = value.trim()
  const encodedLength = new TextEncoder().encode(filename).byteLength

  if (
    !filename ||
    encodedLength > 512 ||
    filename.includes('/') ||
    filename.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid object filename',
    })
  }

  return filename
}

/**
 * Validate both the filename and MIME type through the shared media classifier.
 * This intentionally rejects a media MIME with a harmless extension and a
 * media extension with a generic MIME.
 */
export function requireNonMediaContentType(
  filename: string,
  value?: string | null,
): string {
  const contentType = normalizeContentType(value)

  if (
    contentType.length > 255 ||
    !CONTENT_TYPE_PATTERN.test(contentType) ||
    classifyMedia(filename, contentType).kind !== 'object'
  ) {
    throw createError({
      statusCode: 415,
      statusMessage: 'Images and videos must use Cloudflare Images or Stream',
      data: { filename, contentType },
    })
  }

  return contentType
}

export function objectContentDisposition(filename: string): string {
  if (!hasWellFormedUnicode(filename)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid object filename',
    })
  }

  const fallback =
    filename
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_')
      .slice(0, 150) || 'download'
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (value) =>
    `%${value.codePointAt(0)!.toString(16).toUpperCase()}`,
  )

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export function objectDownloadUrl(key: string): string {
  const path = key.split('/').map(encodeURIComponent).join('/')
  return `/media/objects/${path}`
}

export function presentStoredObject(object: StoredObject) {
  return {
    ...object,
    downloadUrl:
      object.status === 'ready' ? objectDownloadUrl(object.r2Key) : null,
  }
}
