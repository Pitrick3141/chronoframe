import { fileTypeFromBlob } from 'file-type'

export interface ImageLoaderState {
  isVisible: boolean
  isHeic?: boolean
  progress?: number
  bytesLoaded?: number
  bytesTotal?: number
  isConverting?: boolean
  message?: string
  codec?: string
}

export interface ImageLoaderCallbacks {
  onProgress?: (progress: number) => void
  onError?: () => void
  onUpdateLoadingState?: (state: Partial<ImageLoaderState>) => void
}

export interface ImageLoaderResult {
  blobSrc: string
  resultUrl?: string
}

interface CacheEntry {
  blobSrc: string
  bytes: number
  leases: number
  cached: boolean
}

interface RequestConsumer {
  success: (entry: CacheEntry) => void
  failure: (error: Error) => void
  progress: (state: Partial<ImageLoaderState>) => void
}

interface PendingRequest {
  xhr: XMLHttpRequest
  consumers: Set<RequestConsumer>
  finished: boolean
  progress?: Partial<ImageLoaderState>
}

const MAX_CACHE_BYTES = 32 * 1024 * 1024
const MAX_CACHE_ENTRIES = 12
const imageCache = new Map<string, CacheEntry>()
const pendingRequests = new Map<string, PendingRequest>()
let cachedBytes = 0

const abortError = () => new DOMException('Image load cancelled', 'AbortError')

export const isImageLoadAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

function discardEntry(src: string, entry: CacheEntry) {
  imageCache.delete(src)
  cachedBytes -= entry.bytes
  entry.cached = false
  if (entry.leases === 0) URL.revokeObjectURL(entry.blobSrc)
}

function trimCache() {
  for (const [src, entry] of imageCache) {
    if (cachedBytes <= MAX_CACHE_BYTES && imageCache.size <= MAX_CACHE_ENTRIES)
      break
    // An active viewer owns its URL until cleanup. Its memory may temporarily
    // exceed the cache budget; release immediately retries eviction.
    if (entry.leases === 0) discardEntry(src, entry)
  }
}

function acquireEntry(src: string, entry: CacheEntry) {
  entry.leases++
  if (entry.cached) {
    imageCache.delete(src)
    imageCache.set(src, entry)
  }
}

function releaseEntry(entry: CacheEntry) {
  entry.leases--
  if (entry.leases === 0 && !entry.cached) URL.revokeObjectURL(entry.blobSrc)
  trimCache()
}

function detachRequest(src: string, request: PendingRequest) {
  request.finished = true
  if (pendingRequests.get(src) === request) pendingRequests.delete(src)
  request.xhr.onload = null
  request.xhr.onerror = null
  request.xhr.onabort = null
  request.xhr.ontimeout = null
  request.xhr.onprogress = null
}

function failRequest(src: string, request: PendingRequest, error: Error) {
  if (request.finished) return
  detachRequest(src, request)
  const consumers = [...request.consumers]
  request.consumers.clear()
  for (const consumer of consumers) consumer.failure(error)
}

async function isValidImageBlob(blob: Blob): Promise<boolean> {
  if (!(blob instanceof Blob) || blob.size === 0) return false
  try {
    const fileType = await fileTypeFromBlob(blob)
    return !!fileType?.mime.startsWith('image/')
  } catch {
    return false
  }
}

function createRequest(src: string): PendingRequest {
  const xhr = new XMLHttpRequest()
  xhr.open('GET', src)
  xhr.responseType = 'blob'
  const request: PendingRequest = { xhr, consumers: new Set(), finished: false }
  pendingRequests.set(src, request)

  xhr.onload = async () => {
    if (request.finished) return
    if (xhr.status !== 200) {
      failRequest(
        src,
        request,
        new Error(`Failed to load image: ${xhr.status}`),
      )
      return
    }
    try {
      const blob = xhr.response as Blob
      const valid = await isValidImageBlob(blob)
      // Validation is asynchronous: a photo change may have cancelled everyone.
      if (request.finished) return
      if (!valid) {
        throw new Error(
          blob?.type === 'image/svg+xml'
            ? 'SVG originals require a raster display variant'
            : 'Unsupported or unrecognized image format',
        )
      }
      const entry: CacheEntry = {
        blobSrc: URL.createObjectURL(blob),
        bytes: blob.size,
        // Keep the URL alive while callbacks may synchronously clear the cache
        // or release a different consumer of this same request.
        leases: 1,
        cached: true,
      }
      imageCache.set(src, entry)
      cachedBytes += entry.bytes
      detachRequest(src, request)
      const consumers = [...request.consumers]
      request.consumers.clear()
      for (const consumer of consumers) consumer.success(entry)
      releaseEntry(entry)
    } catch (error) {
      failRequest(
        src,
        request,
        error instanceof Error ? error : new Error('Failed to load image'),
      )
    }
  }
  xhr.onprogress = (event) => {
    if (request.finished || !event.lengthComputable || event.total <= 0) return
    request.progress = {
      progress: Math.min(100, (event.loaded / event.total) * 100),
      bytesLoaded: event.loaded,
      bytesTotal: event.total,
    }
    for (const consumer of request.consumers)
      consumer.progress(request.progress)
  }
  xhr.onerror = () =>
    failRequest(src, request, new Error('Failed to load image'))
  xhr.ontimeout = () =>
    failRequest(src, request, new Error('Image load timed out'))
  xhr.onabort = () => failRequest(src, request, abortError())
  return request
}

/** Drop reusable images and pending loads, for example when a session changes.
 * Already displayed URLs stay valid until their viewer releases its lease.
 */
export function clearImageCache() {
  for (const [src, entry] of imageCache) discardEntry(src, entry)
  for (const [src, request] of pendingRequests) {
    failRequest(src, request, abortError())
    request.xhr.abort()
  }
}

export class ImageLoaderManager {
  private lease: CacheEntry | null = null
  private cancelPending: (() => void) | null = null
  private generation = 0
  private active = false

  /** False after cleanup, including when an already resolved promise is pending. */
  get isActive() {
    return this.active
  }

  /** The returned Blob URL is leased to this manager. Clear the displayed source
   * when calling cleanup or starting another load; a released URL can be evicted.
   */
  loadImage(
    src: string,
    callbacks: ImageLoaderCallbacks = {},
  ): Promise<ImageLoaderResult> {
    this.cleanup()
    this.active = true
    const generation = this.generation
    const isCurrent = () => this.active && this.generation === generation
    callbacks.onUpdateLoadingState?.({
      isVisible: true,
      progress: 0,
      bytesLoaded: 0,
      bytesTotal: 0,
    })

    const cached = imageCache.get(src)
    if (cached) {
      acquireEntry(src, cached)
      this.lease = cached
      callbacks.onUpdateLoadingState?.({ isVisible: false })
      return Promise.resolve({ blobSrc: cached.blobSrc })
    }

    return new Promise((resolve, reject) => {
      let request = pendingRequests.get(src)
      const fresh = !request
      try {
        request ??= createRequest(src)
      } catch (error) {
        callbacks.onError?.()
        callbacks.onUpdateLoadingState?.({ isVisible: false })
        reject(error)
        return
      }
      const pending = request
      const consumer: RequestConsumer = {
        success: (entry) => {
          if (!isCurrent()) {
            reject(abortError())
            return
          }
          this.cancelPending = null
          acquireEntry(src, entry)
          this.lease = entry
          try {
            callbacks.onUpdateLoadingState?.({ isVisible: false })
            resolve({ blobSrc: entry.blobSrc })
          } catch (error) {
            if (this.lease === entry) {
              this.lease = null
              releaseEntry(entry)
            }
            reject(error)
          }
        },
        failure: (error) => {
          if (!isCurrent()) {
            reject(abortError())
            return
          }
          this.cancelPending = null
          try {
            if (!isImageLoadAbortError(error)) {
              callbacks.onError?.()
              if (isCurrent())
                callbacks.onUpdateLoadingState?.({ isVisible: false })
            }
          } catch {
            /* A UI callback must not strand other request consumers. */
          }
          reject(error)
        },
        progress: (state) => {
          if (!isCurrent()) return
          callbacks.onProgress?.(state.progress!)
          if (isCurrent()) callbacks.onUpdateLoadingState?.({ ...state })
        },
      }
      pending.consumers.add(consumer)
      this.cancelPending = () => {
        pending.consumers.delete(consumer)
        reject(abortError())
        if (!pending.finished && pending.consumers.size === 0) {
          detachRequest(src, pending)
          pending.xhr.abort()
        }
      }
      if (pending.progress) consumer.progress(pending.progress)
      if (fresh) {
        try {
          pending.xhr.send()
        } catch (error) {
          failRequest(
            src,
            pending,
            error instanceof Error ? error : new Error('Failed to load image'),
          )
        }
      }
    })
  }

  cleanup() {
    this.active = false
    this.generation++
    this.cancelPending?.()
    this.cancelPending = null
    if (this.lease) {
      releaseEntry(this.lease)
      this.lease = null
    }
  }
}
