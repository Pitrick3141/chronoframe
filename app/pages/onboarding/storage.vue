<script setup lang="ts">
definePageMeta({
  layout: 'onboarding',
})

const router = useRouter()

const bindings = computed(() => [
  {
    key: 'd1',
    icon: 'tabler:database',
    title: $t('onboarding.storage.cloudflare.bindings.d1.title'),
    description: $t('onboarding.storage.cloudflare.bindings.d1.description'),
  },
  {
    key: 'images',
    icon: 'tabler:photo',
    title: $t('onboarding.storage.cloudflare.bindings.images.title'),
    description: $t(
      'onboarding.storage.cloudflare.bindings.images.description',
    ),
  },
  {
    key: 'stream',
    icon: 'tabler:video',
    title: $t('onboarding.storage.cloudflare.bindings.stream.title'),
    description: $t(
      'onboarding.storage.cloudflare.bindings.stream.description',
    ),
  },
  {
    key: 'r2',
    icon: 'tabler:bucket',
    title: $t('onboarding.storage.cloudflare.bindings.r2.title'),
    description: $t('onboarding.storage.cloudflare.bindings.r2.description'),
  },
])

function onSubmit() {
  router.push('/onboarding/map')
}
</script>

<template>
  <WizardStep
    :title="$t('onboarding.storage.title')"
    :description="$t('onboarding.storage.description')"
  >
    <form
      id="storage-form"
      class="space-y-6"
      @submit.prevent="onSubmit"
    >
      <UAlert
        color="info"
        variant="subtle"
        icon="tabler:cloud-lock"
        :title="$t('onboarding.storage.cloudflare.title')"
        :description="$t('onboarding.storage.cloudflare.description')"
      />

      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article
          v-for="binding in bindings"
          :key="binding.key"
          class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
        >
          <div class="flex items-start justify-between gap-3">
            <div
              class="flex size-10 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-950/50 dark:text-primary-400"
            >
              <UIcon
                :name="binding.icon"
                class="size-5"
              />
            </div>
            <UBadge
              color="success"
              variant="subtle"
              size="sm"
              icon="tabler:circle-check-filled"
            >
              {{ $t('onboarding.storage.cloudflare.configured') }}
            </UBadge>
          </div>

          <h3 class="mt-4 font-semibold text-neutral-900 dark:text-neutral-100">
            {{ binding.title }}
          </h3>
          <p
            class="mt-1 text-sm leading-6 text-neutral-600 dark:text-neutral-400"
          >
            {{ binding.description }}
          </p>
        </article>
      </div>

      <p class="text-sm text-neutral-500 dark:text-neutral-400">
        {{ $t('onboarding.storage.cloudflare.noCredentials') }}
      </p>
    </form>

    <template #actions>
      <WizardButton
        type="submit"
        form="storage-form"
        color="primary"
        size="lg"
        trailing-icon="tabler:arrow-right"
      >
        {{ $t('onboarding.actions.next') }}
      </WizardButton>
    </template>
  </WizardStep>
</template>
