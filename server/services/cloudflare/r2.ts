import {
  requireCloudflareBinding,
  type CloudflareBinaryBody,
  type CloudflareR2ListOptions,
  type CloudflareR2Object,
  type CloudflareR2ObjectBody,
  type CloudflareR2Objects,
  type CloudflareR2PutOptions,
  type CloudflareR2Range,
} from '../../utils/cloudflare-bindings'
import {
  RangeNotSatisfiableError,
  resolveByteRange,
  type ResolvedByteRange,
} from './range'

export { RangeNotSatisfiableError, resolveByteRange, type ResolvedByteRange }

export class R2PutFailedError extends Error {
  readonly key: string

  constructor(key: string) {
    super(`R2 rejected the write for ${key}`)
    this.name = 'R2PutFailedError'
    this.key = key
  }
}

export class R2PreconditionFailedError extends R2PutFailedError {
  constructor(key: string) {
    super(key)
    this.name = 'R2PreconditionFailedError'
  }
}

function hasBody(
  object: CloudflareR2ObjectBody | CloudflareR2Object,
): object is CloudflareR2ObjectBody {
  return 'body' in object && object.body != null
}

export async function putR2Object(
  key: string,
  body: CloudflareBinaryBody,
  options?: CloudflareR2PutOptions,
): Promise<CloudflareR2Object> {
  const object = await requireCloudflareBinding('MEDIA_BUCKET').put(
    key,
    body,
    options,
  )
  if (!object) {
    if (options?.onlyIf) throw new R2PreconditionFailedError(key)
    throw new R2PutFailedError(key)
  }
  return object
}

export async function headR2Object(
  key: string,
): Promise<CloudflareR2Object | null> {
  return requireCloudflareBinding('MEDIA_BUCKET').head(key)
}

export async function deleteR2Object(keys: string | string[]): Promise<void> {
  await requireCloudflareBinding('MEDIA_BUCKET').delete(keys)
}

export async function listR2Objects(
  options?: CloudflareR2ListOptions,
): Promise<CloudflareR2Objects> {
  return requireCloudflareBinding('MEDIA_BUCKET').list(options)
}

export async function getR2Object(
  key: string,
  range?: CloudflareR2Range | string,
): Promise<CloudflareR2ObjectBody | null> {
  let resolvedRange: CloudflareR2Range | undefined
  if (typeof range === 'string') {
    const metadata = await headR2Object(key)
    if (!metadata) return null
    resolvedRange = resolveByteRange(range, metadata.size)
  } else {
    resolvedRange = range
  }

  const object = await requireCloudflareBinding('MEDIA_BUCKET').get(
    key,
    resolvedRange ? { range: resolvedRange } : undefined,
  )
  if (!object) return null
  if (!hasBody(object)) {
    throw new Error(`R2 returned metadata without a body for ${key}`)
  }
  return object
}

function requestHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name)
  return value?.trim() || null
}

function weakEtag(value: string): string {
  return value.trim().replace(/^W\//i, '')
}

function etagMatches(header: string, etag: string): boolean {
  if (header === '*') return true
  const expected = weakEtag(etag)
  return header.split(',').some((candidate) => weakEtag(candidate) === expected)
}

function isNotModified(headers: Headers, object: CloudflareR2Object): boolean {
  const ifNoneMatch = requestHeader(headers, 'if-none-match')
  if (ifNoneMatch) return etagMatches(ifNoneMatch, object.httpEtag)

  const ifModifiedSince = requestHeader(headers, 'if-modified-since')
  if (!ifModifiedSince) return false
  const timestamp = Date.parse(ifModifiedSince)
  if (!Number.isFinite(timestamp)) return false
  return (
    Math.floor(object.uploaded.getTime() / 1000) <= Math.floor(timestamp / 1000)
  )
}

function ifRangeAllowsRange(
  headers: Headers,
  object: CloudflareR2Object,
): boolean {
  const ifRange = requestHeader(headers, 'if-range')
  if (!ifRange) return true

  if (ifRange.startsWith('"') || /^W\//i.test(ifRange)) {
    return !/^W\//i.test(ifRange) && ifRange === object.httpEtag
  }

  const timestamp = Date.parse(ifRange)
  if (!Number.isFinite(timestamp)) return false
  return (
    Math.floor(object.uploaded.getTime() / 1000) <= Math.floor(timestamp / 1000)
  )
}

export interface R2DownloadOptions {
  headOnly?: boolean
  /** Whether the request carries an authenticated ChronoFrame session. */
  authenticated?: boolean
}

const CONTENT_DISPOSITION_UNSAFE = /[\u0000-\u001f\u007f"\\/]/g
const CONTENT_DISPOSITION_MAX_LENGTH = 180

function replaceMalformedUnicode(value: string): string {
  let result = ''

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        result += value.slice(index, index + 2)
        index += 1
      } else {
        result += '_'
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      result += '_'
    } else {
      result += value.charAt(index)
    }
  }

  return result
}

function safeDownloadName(object: CloudflareR2Object): string {
  const metadataName = object.customMetadata?.sourceFilename
  const keyName = object.key.split('/').filter(Boolean).pop()
  const candidate = replaceMalformedUnicode(
    metadataName || keyName || 'download',
  )
    .replace(CONTENT_DISPOSITION_UNSAFE, '_')
    .trim()
  const shortened = Array.from(candidate)
    .slice(0, CONTENT_DISPOSITION_MAX_LENGTH)
    .join('')
  return shortened && shortened !== '.' && shortened !== '..'
    ? shortened
    : 'download'
}

function asciiDownloadName(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_')
  return fallback || 'download'
}

function encodedDownloadName(fileName: string): string {
  return encodeURIComponent(fileName).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function responseHeaders(
  object: CloudflareR2Object,
  options: R2DownloadOptions,
): Headers {
  const headers = new Headers()
  const downloadName = safeDownloadName(object)
  headers.set('ETag', object.httpEtag)
  headers.set('Last-Modified', object.uploaded.toUTCString())
  headers.set('Accept-Ranges', 'bytes')
  // R2 is deliberately reserved for non-image/non-video objects. Never copy
  // object-controlled HTTP metadata into a same-origin response: an HTML/SVG
  // upload must stay a download and must not execute with the application's
  // origin privileges.
  headers.set('Content-Type', 'application/octet-stream')
  headers.set(
    'Content-Disposition',
    `attachment; filename="${asciiDownloadName(downloadName)}"; filename*=UTF-8''${encodedDownloadName(downloadName)}`,
  )
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  headers.set(
    'Cache-Control',
    options.authenticated
      ? 'private, max-age=0, must-revalidate'
      : 'private, no-store',
  )
  return headers
}

/** Builds a Workers-native streaming response, including strict Range support. */
export async function createR2DownloadResponse(
  key: string,
  requestHeaders: Headers,
  options: R2DownloadOptions = {},
): Promise<Response> {
  const metadata = await headR2Object(key)
  if (!metadata) {
    return new Response(options.headOnly ? null : 'Not Found', { status: 404 })
  }

  const headers = responseHeaders(metadata, options)
  if (isNotModified(requestHeaders, metadata)) {
    headers.delete('Content-Length')
    return new Response(null, { status: 304, headers })
  }

  let range: ResolvedByteRange | undefined
  const rangeHeader = requestHeader(requestHeaders, 'range')
  if (rangeHeader && ifRangeAllowsRange(requestHeaders, metadata)) {
    try {
      range = resolveByteRange(rangeHeader, metadata.size)
    } catch (error) {
      if (!(error instanceof RangeNotSatisfiableError)) throw error
      headers.set('Content-Range', `bytes */${metadata.size}`)
      headers.set('Content-Length', '0')
      return new Response(null, { status: 416, headers })
    }
  }

  if (range) {
    const end = range.offset + range.length - 1
    headers.set(
      'Content-Range',
      `bytes ${range.offset}-${end}/${metadata.size}`,
    )
    headers.set('Content-Length', String(range.length))
  } else {
    headers.set('Content-Length', String(metadata.size))
  }

  if (options.headOnly) {
    return new Response(null, { status: range ? 206 : 200, headers })
  }

  const object = await getR2Object(key, range)
  if (!object) return new Response('Not Found', { status: 404 })
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers,
  })
}

export const r2 = {
  put: putR2Object,
  head: headR2Object,
  delete: deleteR2Object,
  get: getR2Object,
  list: listR2Objects,
  response: createR2DownloadResponse,
}
