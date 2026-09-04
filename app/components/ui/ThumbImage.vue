<script lang="ts" setup>
import { twMerge } from 'tailwind-merge'
import type { CSSProperties } from 'vue'

const props = withDefaults(
  defineProps<{
    src: string
    alt: string
    thumbhash?: string | null
    class?: string
    thumbhashClass?: string
    style?: CSSProperties
    threshold?: number | number[]
    rootMargin?: string
    imageContain?: boolean
    lazy?: boolean
    srcset?: string
    sizes?: string
    fetchpriority?: 'high' | 'low' | 'auto'
  }>(),
  {
    thumbhash: null,
    class: '',
    thumbhashClass: '',
    style: undefined,
    threshold: 0.1,
    rootMargin: '50px',
    imageContain: false,
    lazy: true,
    srcset: undefined,
    sizes: undefined,
    fetchpriority: 'auto',
  },
)

const emit = defineEmits<{
  load: []
  error: []
}>()

const elemRef = useTemplateRef('elemRef')
const imageRef = useTemplateRef<HTMLImageElement>('imageRef')
const isElemVisible = ref(!props.lazy)
const isLoaded = ref(false)
const isError = ref(false)
const imageKey = computed(() => `${props.src}\0${props.srcset || ''}`)

watch(imageKey, () => {
  isLoaded.value = false
  isError.value = false
})

watch(
  () => props.lazy,
  (lazy) => {
    if (!lazy) isElemVisible.value = true
  },
)

const { stop } = useIntersectionObserver(
  elemRef,
  ([entry], _observerElement) => {
    if (entry?.isIntersecting) {
      isElemVisible.value = true
      stop()
    }
  },
  {
    threshold: props.threshold,
    rootMargin: props.rootMargin,
    immediate: props.lazy,
  },
)

const onLoaded = (event: Event) => {
  if (event.currentTarget !== imageRef.value) return
  isLoaded.value = true
  isError.value = false
  emit('load')
}

const onError = (event: Event) => {
  if (event.currentTarget !== imageRef.value) return
  isError.value = true
  emit('error')
}
</script>

<template>
  <div
    ref="elemRef"
    :class="twMerge('relative overflow-hidden', $props.class)"
    :style="style"
  >
    <ThumbHash
      v-if="thumbhash"
      :thumbhash="thumbhash"
      :class="twMerge('absolute inset-0 scale-110 blur-sm', thumbhashClass)"
    />

    <img
      v-if="isElemVisible && src"
      :key="imageKey"
      ref="imageRef"
      :loading="lazy ? 'lazy' : 'eager'"
      decoding="async"
      :src="src"
      :srcset="srcset"
      :sizes="sizes"
      :fetchpriority="fetchpriority"
      :alt="alt"
      :class="
        twMerge(
          'absolute inset-0 w-full h-full transition-opacity duration-300',
          imageContain ? 'object-contain' : 'object-cover',
          isLoaded ? 'opacity-100' : 'opacity-0',
        )
      "
      @load="onLoaded"
      @error="onError"
    />

    <div
      v-if="isError"
      class="absolute inset-0 flex justify-center items-center bg-neutral-200 dark:bg-neutral-800"
    >
      <Icon
        name="tabler:photo-off"
        class="size-6 text-neutral-400"
      />
      <p class="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
        {{ $t('ui.photo.loadError') }}
      </p>
    </div>
  </div>
</template>

<style scoped></style>
