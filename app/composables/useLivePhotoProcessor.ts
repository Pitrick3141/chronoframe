import { computed, readonly, ref } from 'vue'

interface LivePhotoProcessingState {
  isProcessing: boolean
  progress: number
  streamUrl: string | null
  error: string | null
  lastProcessed: number
}

// The cache only stores lightweight Stream URLs and UI state. Video bytes are
// never downloaded into memory; playback is delegated to the browser/HLS.
const processedLivePhotos = ref<Map<string, LivePhotoProcessingState>>(
  new Map(),
)

export const useLivePhotoProcessor = () => {
  const prepareLivePhoto = async (
    streamUrl: string,
    photoId: string,
  ): Promise<string | null> => {
    const existing = processedLivePhotos.value.get(photoId)
    if (existing?.streamUrl === streamUrl && !existing.error) {
      return streamUrl
    }

    const state: LivePhotoProcessingState = {
      isProcessing: true,
      progress: 25,
      streamUrl: null,
      error: null,
      lastProcessed: Date.now(),
    }
    processedLivePhotos.value.set(photoId, state)

    try {
      if (!streamUrl.trim()) throw new Error('Missing Live Photo video URL')

      // Yield once so processing indicators can render before the video element
      // is attached. No video payload is fetched or converted here.
      await Promise.resolve()
      state.isProcessing = false
      state.progress = 100
      state.streamUrl = streamUrl
      state.lastProcessed = Date.now()
      processedLivePhotos.value.set(photoId, { ...state })
      return streamUrl
    } catch (cause) {
      state.isProcessing = false
      state.progress = 0
      state.error =
        cause instanceof Error
          ? cause.message
          : 'Unable to prepare video stream'
      state.lastProcessed = Date.now()
      processedLivePhotos.value.set(photoId, { ...state })
      return null
    }
  }

  const getProcessingState = (photoId: string) =>
    computed(() => processedLivePhotos.value.get(photoId) || null)

  const processPhotoBatch = async (
    photos: Array<{ id: string; livePhotoVideoUrl: string }>,
    maxConcurrent: number,
  ) => {
    const concurrency = Math.max(1, Math.floor(maxConcurrent))
    for (let index = 0; index < photos.length; index += concurrency) {
      await Promise.allSettled(
        photos
          .slice(index, index + concurrency)
          .map((photo) => prepareLivePhoto(photo.livePhotoVideoUrl, photo.id)),
      )
    }
  }

  const preloadLivePhotosInViewport = async (
    photos: Array<{
      id: string
      livePhotoVideoUrl?: string | null
      isVisible?: boolean
    }>,
    options: {
      maxConcurrent?: number
      prioritizeVisible?: boolean
      prefetchDistance?: number
    } = {},
  ) => {
    const {
      maxConcurrent = 2,
      prioritizeVisible = true,
      prefetchDistance = 3,
    } = options
    const livePhotos = photos.filter(
      (photo): photo is typeof photo & { livePhotoVideoUrl: string } =>
        Boolean(photo.livePhotoVideoUrl),
    )

    if (!prioritizeVisible) {
      await processPhotoBatch(livePhotos, maxConcurrent)
      return
    }

    const visiblePhotos = livePhotos.filter((photo) => photo.isVisible)
    const nearbyPhotos = livePhotos
      .filter((photo) => !photo.isVisible)
      .slice(0, prefetchDistance)

    await processPhotoBatch(visiblePhotos, maxConcurrent)
    await processPhotoBatch(nearbyPhotos, Math.min(maxConcurrent, 1))
  }

  const batchProcessLivePhotos = async (
    photos: Array<{ id: string; livePhotoVideoUrl?: string | null }>,
  ) => {
    await preloadLivePhotosInViewport(photos, {
      maxConcurrent: 3,
      prioritizeVisible: false,
    })
  }

  const cleanupExpiredCache = () => {
    const now = Date.now()
    const cacheExpiry = 24 * 60 * 60 * 1000
    const maxCacheSize = 100

    for (const [photoId, state] of processedLivePhotos.value) {
      if (now - state.lastProcessed > cacheExpiry) {
        processedLivePhotos.value.delete(photoId)
      }
    }

    if (processedLivePhotos.value.size <= maxCacheSize) return

    const oldest = [...processedLivePhotos.value.entries()].sort(
      (left, right) => left[1].lastProcessed - right[1].lastProcessed,
    )
    for (const [photoId] of oldest.slice(
      0,
      processedLivePhotos.value.size - maxCacheSize,
    )) {
      processedLivePhotos.value.delete(photoId)
    }
  }

  const getCacheStats = () => {
    let processed = 0
    let processing = 0
    let failed = 0

    processedLivePhotos.value.forEach((state) => {
      if (state.streamUrl) processed++
      else if (state.isProcessing) processing++
      else if (state.error) failed++
    })

    return {
      total: processedLivePhotos.value.size,
      processed,
      processing,
      failed,
      totalSizeMB: 0,
    }
  }

  const clearProcessedCache = () => {
    processedLivePhotos.value.clear()
  }

  return {
    prepareLivePhoto,
    getProcessingState,
    batchProcessLivePhotos,
    preloadLivePhotosInViewport,
    cleanupExpiredCache,
    getCacheStats,
    clearProcessedCache,
    processedLivePhotos: readonly(processedLivePhotos),
  }
}
