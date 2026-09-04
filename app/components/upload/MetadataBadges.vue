<script setup lang="ts">
import { isMetadataImage, readUploadMetadata } from '~/utils/upload-metadata'
import type {
  UploadMetadataKind,
  UploadMetadataResult,
} from '~/utils/upload-metadata'

const props = defineProps<{ file: File }>()
const result = shallowRef<UploadMetadataResult | null>(null)
const loading = ref(true)
const { t } = useI18n()
const indicators: Array<{
  kind: UploadMetadataKind
  icon: string
  activeClass: string
}> = [
  {
    kind: 'camera',
    icon: 'tabler:camera',
    activeClass:
      'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-800',
  },
  {
    kind: 'people',
    icon: 'tabler:user',
    activeClass:
      'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:ring-violet-800',
  },
  {
    kind: 'gps',
    icon: 'tabler:map-pin',
    activeClass:
      'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-800',
  },
]
const state = (kind: UploadMetadataKind) =>
  result.value?.status === 'ready'
    ? result.value.indicators[kind]
      ? 'present'
      : 'absent'
    : 'unknown'
const description = (kind: UploadMetadataKind) => {
  const label = t(`upload.metadata.${kind}`)
  if (loading.value) return t('upload.metadata.reading', { label })
  if (result.value?.status === 'unavailable')
    return t(`upload.metadata.${result.value.reason}`, { label })
  return t(`upload.metadata.${state(kind)}`, { label })
}

watch(
  () => props.file,
  (file, _previous, onCleanup) => {
    result.value = null
    loading.value = true
    if (!import.meta.client || !isMetadataImage(file)) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    void readUploadMetadata(file, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      result.value = value
      loading.value = false
    })
  },
  { immediate: true },
)
</script>

<template>
  <span
    v-if="isMetadataImage(file)"
    class="inline-flex shrink-0 items-center gap-1"
    role="group"
    :aria-label="t('upload.metadata.group')"
    :aria-busy="loading"
  >
    <UTooltip
      v-for="indicator in indicators"
      :key="indicator.kind"
      :text="description(indicator.kind)"
    >
      <span
        role="img"
        tabindex="0"
        :aria-label="description(indicator.kind)"
        :data-metadata="indicator.kind"
        :data-state="loading ? 'reading' : state(indicator.kind)"
        :class="[
          'relative inline-flex size-6 items-center justify-center rounded-md ring-1 ring-inset transition-colors focus-visible:outline-2 focus-visible:outline-primary',
          state(indicator.kind) === 'present'
            ? indicator.activeClass
            : 'bg-neutral-100 text-neutral-400 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-500 dark:ring-neutral-700',
        ]"
      >
        <UIcon
          :name="indicator.icon"
          class="size-3.5"
          aria-hidden="true"
        />
        <span
          v-if="!loading && state(indicator.kind) === 'unknown'"
          class="absolute -right-0.5 -top-1 rounded-full bg-default px-0.5 text-[9px] font-bold leading-3"
          aria-hidden="true"
          >?</span
        >
        <span
          v-else-if="!loading && state(indicator.kind) === 'absent'"
          class="absolute bottom-0.5 right-0.5 h-px w-1.5 bg-current"
          aria-hidden="true"
        />
      </span>
    </UTooltip>
    <UIcon
      v-if="loading"
      name="svg-spinners:180-ring-with-bg"
      class="ml-0.5 size-3.5 text-muted"
      aria-hidden="true"
    />
  </span>
</template>
