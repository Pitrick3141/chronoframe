<script setup lang="ts">
defineOptions({
  inheritAttrs: false,
})
</script>

<template>
  <UButton
    v-bind="$attrs"
    :ui="{
      base: 'rounded-xl transition-all duration-300 font-medium',
    }"
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
  </UButton>
</template>
