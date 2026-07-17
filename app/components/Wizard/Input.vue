<script setup lang="ts">
defineOptions({
  inheritAttrs: false,
})

const props = defineProps<{
  modelValue?: string | number
}>()

const emit = defineEmits(['update:modelValue'])

const value = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val),
})
</script>

<template>
  <UInput
    v-bind="$attrs"
    v-model="value"
    :ui="{
      root: 'relative w-full',
      base: 'w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white shadow-sm transition-all duration-200 placeholder:text-neutral-500 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20',
    }"
    variant="none"
  >
    <template
      v-for="(_, name) in $slots"
      #[name]="slotData"
    >
      <slot
        :name="name"
        v-bind="slotData"
      />
    </template>
  </UInput>
</template>
