<script setup lang="ts">
import type { PhotoBlur } from '~~/shared/types/photo'

defineProps<{ blur: PhotoBlur }>()
defineEmits<{ reveal: [] }>()
const { blurLabel } = usePhotoBlur()
</script>

<template>
  <button
    type="button"
    class="absolute inset-0 z-30 flex cursor-pointer flex-col items-center justify-center gap-2 overflow-y-auto bg-black/40 p-4 text-center text-white focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white"
    @click.stop="$emit('reveal')"
    @pointerdown.stop
    @touchstart.stop
    @touchend.stop
    @keydown.enter.stop
    @keydown.space.stop
  >
    <Icon
      name="tabler:eye-off"
      class="size-7 shrink-0"
    />
    <span
      class="max-w-sm whitespace-pre-wrap break-words text-sm font-semibold"
      >{{ blurLabel(blur) }}</span
    >
    <span class="text-xs text-white/80">{{ $t('photoBlur.reveal') }}</span>
  </button>
</template>
