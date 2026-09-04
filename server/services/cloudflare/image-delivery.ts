import type { H3Event } from 'h3'
import {
  getImageVariant,
  type ImageVariant,
  type ImageVariantKind,
} from '../../../shared/utils/image-variants'
import { requireCloudflareBinding } from '../../utils/cloudflare-bindings'
import {
  inlineDisposition,
  requireReadableHostedImage,
  throwImageNotFound,
} from '../../utils/media-access'

// Bump when output semantics change. Hosted Images source IDs are immutable:
// replacing a photo's source automatically chooses a new cache key and ETag.
export const IMAGE_TRANSFORM_VERSION = '2'
const INTERNAL_CACHE_SECONDS = 7 * 24 * 60 * 60

interface TransformedImageCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

interface ImageDimensions {
  width: number
  height: number
}

function readableDimensions(value: {
  width?: unknown
  height?: unknown
}): ImageDimensions | null {
  const { width, height } = value
  return typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : null
}

function imageCache(): TransformedImageCache | undefined {
  try {
    return (globalThis as { caches?: { default?: TransformedImageCache } })
      .caches?.default
  } catch {
    // Unit tests and non-Workers previews may not implement Cache API.
    return undefined
  }
}

export async function imageVariantIdentity(
  imageId: string,
  variant: ImageVariant,
  version = IMAGE_TRANSFORM_VERSION,
  dimensions: ImageDimensions | null = null,
): Promise<string> {
  const input = JSON.stringify([
    version,
    imageId,
    variant.size,
    variant.height,
    'scale-down',
    variant.quality,
    variant.format,
    dimensions?.width ?? null,
    dimensions?.height ?? null,
  ])
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  )
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function matchesEtag(value: string | undefined, etag: string): boolean {
  if (!value) return false
  const target = etag.replace(/^W\//, '')
  return value.split(',').some((part) => {
    const candidate = part.trim()
    return candidate === '*' || candidate.replace(/^W\//, '') === target
  })
}

/**
 * Cache only re-encoded display pixels. Every request, including a conditional
 * browser revalidation, must pass the current D1/session ACL before cache use.
 */
export async function deliverHostedImage(
  event: H3Event,
  identifier: string,
  kind: ImageVariantKind,
): Promise<Response> {
  const started = performance.now()
  const { imageId, photo } = await requireReadableHostedImage(event, identifier)
  const authorized = performance.now()
  const variant = getImageVariant(kind, getQuery(event).w)
  if (!variant) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Unsupported image size',
    })
  }
  const storedDimensions = readableDimensions(photo)
  const identity = await imageVariantIdentity(
    imageId,
    variant,
    IMAGE_TRANSFORM_VERSION,
    storedDimensions,
  )
  // A weak validator identifies the immutable source and transformation, not
  // a byte guarantee across changes in Cloudflare's encoder implementation.
  const etag = `W/"cfimg-${identity}"`
  const headers = new Headers({
    'Cache-Control': 'private, no-cache, must-revalidate',
    'Content-Type': variant.format,
    'Content-Disposition': inlineDisposition(
      null,
      `${kind === 'thumbnail' ? 'thumbnail' : 'photo'}-${photo.id}.webp`,
    ),
    'Cross-Origin-Resource-Policy': 'same-origin',
    ETag: etag,
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff',
  })
  const timing = [`acl;dur=${(authorized - started).toFixed(1)}`]
  const finish = (
    body: BodyInit | null,
    status: number,
    cacheStatus: string,
  ) => {
    headers.set('X-Image-Cache', cacheStatus)
    headers.set(
      'Server-Timing',
      [...timing, `image;dur=${(performance.now() - started).toFixed(1)}`].join(
        ', ',
      ),
    )
    return new Response(body, { status, headers })
  }
  if (matchesEtag(getHeader(event, 'if-none-match'), etag)) {
    return finish(null, 304, 'REVALIDATED')
  }

  let cache = imageCache()
  // A fresh Request strips Cookie, Authorization, conditional and Range headers.
  // This namespace is never exposed by a public media route.
  const key = new Request(
    new URL(
      `/__chronoframe_image_cache/${identity}`,
      getRequestURL(event).origin,
    ),
  )
  const lookupStarted = performance.now()
  if (cache) {
    try {
      const cached = await cache.match(key)
      timing.push(`cache;dur=${(performance.now() - lookupStarted).toFixed(1)}`)
      if (cached?.status === 200 && cached.body) {
        const length = cached.headers.get('Content-Length')
        if (length && /^\d+$/.test(length))
          headers.set('Content-Length', length)
        return finish(cached.body, 200, 'HIT')
      }
    } catch {
      cache = undefined
    }
  }

  const images = requireCloudflareBinding('IMAGES')
  const sourceStarted = performance.now()
  let source = await images.hosted.image(imageId).bytes()
  timing.push(`source;dur=${(performance.now() - sourceStarted).toFixed(1)}`)
  if (!source) throwImageNotFound()
  let dimensions = storedDimensions
  if (!dimensions) {
    const infoStarted = performance.now()
    const [infoSource, transformSource] = source.tee()
    source = transformSource
    try {
      const info = await images.info(infoSource)
      if ('width' in info) dimensions = readableDimensions(info)
    } catch {
      // Legacy/SVG sources without dimensions retain the width-only fallback.
    } finally {
      if (!infoSource.locked) void infoSource.cancel().catch(() => {})
    }
    timing.push(`info;dur=${(performance.now() - infoStarted).toFixed(1)}`)
  }
  // A single limiting axis preserves aspect ratio without padding, including
  // local Images emulators which do not implement the fit option faithfully.
  const transformDimensions =
    dimensions && kind === 'display' && dimensions.height > dimensions.width
      ? { height: Math.min(variant.size, dimensions.height) }
      : {
          width: dimensions
            ? Math.min(variant.size, dimensions.width)
            : variant.size,
        }
  const transformStarted = performance.now()
  const output = await images
    .input(source)
    .transform({
      ...transformDimensions,
      fit: 'scale-down',
    })
    .output({ format: variant.format, quality: variant.quality })
  const transformed = output.response()
  timing.push(
    `transform;dur=${(performance.now() - transformStarted).toFixed(1)}`,
  )
  if (transformed.status !== 200 || !transformed.body) {
    if (transformed.body) void transformed.body.cancel().catch(() => {})
    throw createError({
      statusCode: 502,
      statusMessage: 'Image transformation failed',
    })
  }

  // Never forward upstream cookies, source filenames, metadata or cache policy.
  const length = transformed.headers.get('Content-Length')
  if (length && /^\d+$/.test(length)) headers.set('Content-Length', length)
  const response = finish(transformed.body, 200, cache ? 'MISS' : 'BYPASS')
  if (cache) {
    const internalHeaders = new Headers({
      'Content-Type': variant.format,
      'Cache-Control': `public, max-age=${INTERNAL_CACHE_SECONDS}, immutable`,
    })
    if (length && /^\d+$/.test(length))
      internalHeaders.set('Content-Length', length)
    const internalResponse = new Response(response.clone().body, {
      headers: internalHeaders,
    })
    const write = cache.put(key, internalResponse).catch(() => {
      // Cache eviction, limits or transient errors must not break image delivery.
    })
    if (typeof event.waitUntil === 'function') event.waitUntil(write)
    else await write
  }
  return response
}
