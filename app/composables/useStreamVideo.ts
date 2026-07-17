import type Hls from 'hls.js'
import { onScopeDispose, readonly, ref } from 'vue'

const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl'
const STREAM_LOAD_TIMEOUT = 20_000

export const isHlsVideoUrl = (url: string) => /\.m3u8(?:$|[?#])/i.test(url)

/**
 * Attach a Cloudflare Stream HLS manifest to a video element.
 *
 * Safari uses its native HLS implementation. Other compatible browsers load
 * the manifest through hls.js. Non-HLS URLs remain supported by assigning the
 * URL directly to the video element.
 */
export const useStreamVideo = () => {
  const isLoading = ref(false)
  const isReady = ref(false)
  const error = ref<string | null>(null)

  let activeVideo: HTMLVideoElement | null = null
  let activeUrl: string | null = null
  let hls: Hls | null = null
  let attachmentId = 0
  let loadTimeout: ReturnType<typeof setTimeout> | null = null
  let settlePending: ((ready: boolean) => void) | null = null
  let removeMediaListeners: (() => void) | null = null

  const clearLoadTimeout = () => {
    if (loadTimeout) {
      clearTimeout(loadTimeout)
      loadTimeout = null
    }
  }

  const settle = (ready: boolean) => {
    clearLoadTimeout()
    removeMediaListeners?.()
    removeMediaListeners = null
    isLoading.value = false
    isReady.value = ready
    settlePending?.(ready)
    settlePending = null
  }

  const stopActivePlayback = () => {
    hls?.destroy()
    hls = null

    if (activeVideo) {
      activeVideo.pause()
      activeVideo.removeAttribute('src')
      activeVideo.load()
    }
  }

  const detachStreamVideo = () => {
    attachmentId++
    settlePending?.(false)
    settlePending = null
    clearLoadTimeout()
    removeMediaListeners?.()
    removeMediaListeners = null

    stopActivePlayback()

    activeVideo = null
    activeUrl = null
    isLoading.value = false
    isReady.value = false
    error.value = null
  }

  const attachStreamVideo = async (
    video: HTMLVideoElement,
    url: string,
  ): Promise<boolean> => {
    if (activeVideo === video && activeUrl === url && isReady.value) {
      return true
    }

    detachStreamVideo()
    const currentAttachmentId = attachmentId
    activeVideo = video
    activeUrl = url
    isLoading.value = true
    error.value = null

    const readyPromise = new Promise<boolean>((resolve) => {
      settlePending = resolve

      const handleReady = () => {
        if (currentAttachmentId === attachmentId) settle(true)
      }
      const handleError = () => {
        if (currentAttachmentId !== attachmentId) return
        error.value = 'Unable to load the video stream'
        settle(false)
        stopActivePlayback()
      }

      video.addEventListener('loadedmetadata', handleReady, { once: true })
      video.addEventListener('error', handleError, { once: true })
      removeMediaListeners = () => {
        video.removeEventListener('loadedmetadata', handleReady)
        video.removeEventListener('error', handleError)
      }

      loadTimeout = setTimeout(() => {
        if (currentAttachmentId !== attachmentId) return
        error.value = 'Timed out while loading the video stream'
        settle(false)
        stopActivePlayback()
      }, STREAM_LOAD_TIMEOUT)
    })

    if (!isHlsVideoUrl(url)) {
      video.src = url
      video.load()
      return readyPromise
    }

    const supportsNativeHls = Boolean(
      video.canPlayType(HLS_MIME_TYPE) ||
      video.canPlayType('application/x-mpegURL'),
    )

    if (supportsNativeHls) {
      video.src = url
      video.load()
      return readyPromise
    }

    try {
      const { default: HlsPlayer } = await import('hls.js')
      if (currentAttachmentId !== attachmentId) return false

      if (!HlsPlayer.isSupported()) {
        error.value = 'HLS playback is not supported by this browser'
        settle(false)
        return readyPromise
      }

      hls = new HlsPlayer({
        enableWorker: true,
        startLevel: -1,
      })
      hls.on(HlsPlayer.Events.MEDIA_ATTACHED, () => {
        if (currentAttachmentId === attachmentId) hls?.loadSource(url)
      })
      hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
        if (currentAttachmentId !== attachmentId || !data.fatal) return

        if (data.type === HlsPlayer.ErrorTypes.NETWORK_ERROR) {
          hls?.startLoad()
          return
        }
        if (data.type === HlsPlayer.ErrorTypes.MEDIA_ERROR) {
          hls?.recoverMediaError()
          return
        }

        error.value = data.details || 'Unable to play the HLS stream'
        settle(false)
        stopActivePlayback()
      })
      hls.attachMedia(video)
    } catch (cause) {
      if (currentAttachmentId === attachmentId) {
        error.value =
          cause instanceof Error ? cause.message : 'Unable to load hls.js'
        settle(false)
        stopActivePlayback()
      }
    }

    return readyPromise
  }

  onScopeDispose(detachStreamVideo)

  return {
    attachStreamVideo,
    detachStreamVideo,
    isLoading: readonly(isLoading),
    isReady: readonly(isReady),
    error: readonly(error),
  }
}
