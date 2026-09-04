<script setup lang="ts">
import { LoadingState, WebGLImageViewer } from '@chronoframe/webgl-image'
import type { LoadingIndicatorRef } from './LoadingIndicator.vue'
import { ImageLoaderManager } from '~/libs/image-loader-manager'
import { imageVariantUrl, selectDisplaySize } from '~/utils/image-variants'

interface Props {
  src: string
  thumbnailSrc?: string
  thumbhash?: string | null
  alt?: string
  width?: number
  height?: number
  className?: string
  enablePan?: boolean
  enableZoom?: boolean
  isCurrentImage?: boolean
  loadingIndicatorRef: LoadingIndicatorRef | null
  onProgress?: (progress: number) => void
  onError?: () => void
  onZoomChange?: (isZoomed: boolean, level?: number) => void
  onBlobSrcChange?: (blobSrc: string | null) => void
  onImageLoaded?: () => void
  isLivePhoto?: boolean
  livePhotoVideoUrl?: string
  isHDR?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  enablePan: true,
  enableZoom: true,
  isCurrentImage: true,
  thumbnailSrc: '',
  thumbhash: null,
  alt: 'Image',
  width: undefined,
  height: undefined,
  className: '',
  onProgress: undefined,
  onError: undefined,
  onZoomChange: undefined,
  onBlobSrcChange: undefined,
  onImageLoaded: undefined,
  isLivePhoto: false,
  livePhotoVideoUrl: '',
  isHDR: false,
})

const containerRef = ref<HTMLDivElement>()

const highResLoaded = ref(false)
const highResRendered = ref(false)
const hasError = ref(false)
const currentSrc = ref<string | null>()

const { loggedIn } = useUserSession()
const webglImageViewerDebug = useSettingRef('system:webglImageViewerDebug')
const isDev = computed(() => import.meta.env.DEV)
const showDebugInfo = computed(() => {
  if (webglImageViewerDebug.value === true) {
    return !!loggedIn.value
  }

  return isDev.value && import.meta.env.VITE_SHOW_DEBUG_INFO === 'true'
})

// 使用 WebGLImageViewer 的引用
const webglViewerRef = ref()
let activeLoader: ImageLoaderManager | null = null
let pendingLoader: ImageLoaderManager | null = null
let retiredLoaders: ImageLoaderManager[] = []
let requestId = 0
let requestedSize = 0
let requestedUrl = ''
let renderedSize = 0
let renderedImage: {
  loader: ImageLoaderManager
  src: string
  size: number
} | null = null
let mounted = false
const relativeZoom = ref(1)
// The viewer fills the viewport. Swiper's mounting/transition layout briefly
// reports smaller element sizes, which would start and then cancel a low-res
// request on every open. Use stable viewport dimensions for the first request.
const { width: viewportWidth, height: viewportHeight } = useWindowSize()

const showThumbnail = computed(() => {
  return props.thumbnailSrc && (!highResRendered.value || hasError.value)
})

const showWebGLViewer = computed(() => {
  return (
    highResLoaded.value &&
    currentSrc.value &&
    props.isCurrentImage &&
    !hasError.value
  )
})

const releaseRetiredLoaders = () => {
  retiredLoaders.forEach((loader) => loader.cleanup())
  retiredLoaders = []
}

const resetImage = () => {
  requestId++
  currentSrc.value = null
  highResLoaded.value = false
  highResRendered.value = false
  hasError.value = false
  relativeZoom.value = 1
  requestedSize = renderedSize = 0
  requestedUrl = ''
  renderedImage = null
  pendingLoader?.cleanup()
  activeLoader?.cleanup()
  pendingLoader = activeLoader = null
  releaseRetiredLoaders()
  props.onBlobSrcChange?.(null)
}

const loadFittedImage = async () => {
  if (!mounted || !props.isCurrentImage || !props.src) return
  const size = selectDisplaySize(
    props.width,
    props.height,
    viewportWidth.value || window.innerWidth,
    viewportHeight.value || window.innerHeight,
    window.devicePixelRatio,
    relativeZoom.value,
  )
  const url = imageVariantUrl(props.src, size)
  if (size <= requestedSize || url === requestedUrl) return

  const id = ++requestId
  pendingLoader?.cleanup()
  const loader = new ImageLoaderManager()
  pendingLoader = loader
  requestedSize = size
  requestedUrl = url
  const hasPreview = Boolean(currentSrc.value)
  try {
    const result = await loader.loadImage(url, {
      onProgress: (progress) => {
        if (id === requestId && !hasPreview) props.onProgress?.(progress)
      },
      onUpdateLoadingState: (state) => {
        if (id === requestId && !hasPreview)
          props.loadingIndicatorRef?.updateLoadingState(state)
      },
    })
    if (id !== requestId || !props.isCurrentImage) return
    // Keep the old Blob alive until the renderer has decoded its replacement.
    if (activeLoader) retiredLoaders.push(activeLoader)
    activeLoader = loader
    pendingLoader = null
    renderedSize = size
    currentSrc.value = result.blobSrc
    highResLoaded.value = true
    hasError.value = false
    props.onBlobSrcChange?.(result.blobSrc)
  } catch (error) {
    loader.cleanup()
    if (id !== requestId) return
    pendingLoader = null
    requestedSize = renderedSize
    requestedUrl = ''
    if (error instanceof Error && error.name === 'AbortError') {
      // Session changes can invalidate a shared request without changing this
      // photo. Retry under the new session; our own cancellations change id.
      await nextTick()
      if (id === requestId) void loadFittedImage()
      return
    }
    // An interrupted/failed upgrade leaves the already rendered image usable.
    if (!currentSrc.value) {
      hasError.value = true
      props.onError?.()
      props.loadingIndicatorRef?.updateLoadingState({ isVisible: false })
    }
  }
}

watch(
  [() => props.src, () => props.isCurrentImage],
  () => {
    resetImage()
    void loadFittedImage()
  },
  { flush: 'post' },
)

watch([viewportWidth, viewportHeight], () => void loadFittedImage())

onMounted(() => {
  mounted = true
  void loadFittedImage()
})

const updateWebGLState = useWebGLWorkState(props.loadingIndicatorRef)
const handleWebGLStateChange = (
  isLoading: boolean,
  state?: LoadingState,
  quality?: 'high' | 'medium' | 'low' | 'unknown',
) => {
  if (!props.isCurrentImage) return
  if (!highResRendered.value || !isLoading)
    updateWebGLState(isLoading, state, quality)
  if (!isLoading && state === LoadingState.COMPLETE) {
    highResRendered.value = true
    if (activeLoader && currentSrc.value) {
      renderedImage = {
        loader: activeLoader,
        src: currentSrc.value,
        size: renderedSize,
      }
    }
    releaseRetiredLoaders()
    props.onImageLoaded?.()
  } else if (state === LoadingState.ERROR) {
    if (renderedImage && renderedImage.src !== currentSrc.value) {
      // A GPU/decode failure must not throw away an already usable preview.
      requestId++
      pendingLoader?.cleanup()
      pendingLoader = null
      activeLoader?.cleanup()
      activeLoader = renderedImage.loader
      retiredLoaders = retiredLoaders.filter(
        (loader) => loader !== activeLoader,
      )
      releaseRetiredLoaders()
      currentSrc.value = renderedImage.src
      requestedSize = renderedSize = renderedImage.size
      requestedUrl = ''
      props.onBlobSrcChange?.(renderedImage.src)
      return
    }
    hasError.value = true
    releaseRetiredLoaders()
    props.onError?.()
  }
}

// 处理缩放状态变化
const handleZoomChange = (_originalScale: number, relativeScale: number) => {
  relativeZoom.value = relativeScale
  if (relativeScale > 1.1) void loadFittedImage()
  const isZoomed = relativeScale > 1.1 // 认为缩放超过 1.1 倍算作缩放状态
  if (props.onZoomChange) {
    // A fitted image is 1x regardless of the currently decoded resolution.
    props.onZoomChange(isZoomed, Math.round(relativeScale * 10) / 10)
  }
}

// 组件卸载时清理
onUnmounted(() => {
  mounted = false
  resetImage()
})
</script>

<template>
  <div
    ref="containerRef"
    class="relative w-full h-full flex items-center justify-center"
  >
    <ThumbImage
      v-if="showThumbnail"
      :src="imageVariantUrl(thumbnailSrc, 360)"
      :thumbhash="thumbhash"
      :alt="alt || $t('ui.photo.altFallback')"
      class="absolute inset-0 w-full h-full object-contain"
      thumbhash-class="opacity-50"
      :lazy="false"
      image-contain
    />

    <!-- WebGL 图片查看器 -->
    <WebGLImageViewer
      v-if="showWebGLViewer"
      ref="webglViewerRef"
      :src="currentSrc!"
      preserve-view-on-source-change
      :class="className"
      class="w-full h-full"
      :width="width"
      :height="height"
      :center-on-init="true"
      :limit-to-bounds="true"
      :smooth="true"
      :min-scale="1"
      :max-scale="12"
      :wheel="{ step: 0.2, wheelDisabled: false, touchPadDisabled: false }"
      :pinch="{ step: 0.2 }"
      :double-click="{ mode: 'toggle', step: 2.4, animationTime: 400 }"
      :panning="{ velocityDisabled: false }"
      :debug="showDebugInfo"
      @zoom-change="handleZoomChange"
      @loading-state-change="handleWebGLStateChange"
    />

    <!-- 错误状态 -->
    <div
      v-if="hasError"
      class="flex flex-col items-center justify-center text-white/70 gap-2"
    >
      <Icon
        name="tabler:photo-off"
        class="w-12 h-12"
      />
      <p class="text-sm">{{ $t('photo.image.loadError') }}</p>
    </div>
  </div>
</template>

<style scoped></style>
