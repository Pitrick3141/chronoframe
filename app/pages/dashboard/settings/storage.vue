<script lang="ts" setup>
definePageMeta({
  layout: 'dashboard',
})

useHead({
  title: () => $t('title.storageSettings'),
})

type BindingHealth = {
  configured: boolean
  healthy: boolean
}

type StorageHealthResponse = {
  status: 'healthy' | 'degraded'
  bindings: {
    d1: BindingHealth
    images: BindingHealth
    stream: BindingHealth
    r2: BindingHealth
  }
}

type StorageBindingKey = keyof StorageHealthResponse['bindings']
type DisplayStatus =
  | 'checking'
  | 'healthy'
  | 'degraded'
  | 'missing'
  | 'unavailable'

const {
  data: storageHealth,
  status: healthRequestStatus,
  error: healthError,
  refresh: refreshHealth,
} = await useFetch<StorageHealthResponse>('/api/system/storage/health')

const bindingDefinitions = computed<
  Array<{
    key: StorageBindingKey
    icon: string
    title: string
    description: string
  }>
>(() => [
  {
    key: 'd1',
    icon: 'tabler:database',
    title: $t('settings.storage.cloudflare.bindings.d1.title'),
    description: $t('settings.storage.cloudflare.bindings.d1.description'),
  },
  {
    key: 'images',
    icon: 'tabler:photo',
    title: $t('settings.storage.cloudflare.bindings.images.title'),
    description: $t('settings.storage.cloudflare.bindings.images.description'),
  },
  {
    key: 'stream',
    icon: 'tabler:video',
    title: $t('settings.storage.cloudflare.bindings.stream.title'),
    description: $t('settings.storage.cloudflare.bindings.stream.description'),
  },
  {
    key: 'r2',
    icon: 'tabler:bucket',
    title: $t('settings.storage.cloudflare.bindings.r2.title'),
    description: $t('settings.storage.cloudflare.bindings.r2.description'),
  },
])

const overallStatus = computed<DisplayStatus>(() => {
  if (
    healthRequestStatus.value === 'idle' ||
    healthRequestStatus.value === 'pending'
  ) {
    return 'checking'
  }
  if (healthError.value || !storageHealth.value) return 'unavailable'
  return storageHealth.value.status === 'healthy' ? 'healthy' : 'degraded'
})

const getBindingStatus = (key: StorageBindingKey): DisplayStatus => {
  if (
    healthRequestStatus.value === 'idle' ||
    healthRequestStatus.value === 'pending'
  ) {
    return 'checking'
  }
  if (healthError.value) return 'unavailable'

  const binding = storageHealth.value?.bindings[key]
  if (!binding) return 'unavailable'
  if (!binding.configured) return 'missing'
  return binding.healthy ? 'healthy' : 'degraded'
}

const statusColor = (
  value: DisplayStatus,
): 'success' | 'warning' | 'error' | 'neutral' => {
  if (value === 'healthy') return 'success'
  if (value === 'checking') return 'neutral'
  if (value === 'degraded') return 'warning'
  return 'error'
}

const statusIcon = (value: DisplayStatus) => {
  if (value === 'healthy') return 'tabler:circle-check-filled'
  if (value === 'checking') return 'tabler:loader-2'
  if (value === 'degraded') return 'tabler:alert-triangle-filled'
  return 'tabler:circle-x-filled'
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="$t('title.storageSettings')">
        <template #right>
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="tabler:refresh"
            :loading="healthRequestStatus === 'pending'"
            @click="refreshHealth()"
          >
            {{ $t('settings.storage.cloudflare.refresh') }}
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-5xl space-y-6">
        <section
          class="space-y-3 border-b border-neutral-200 pb-5 dark:border-neutral-800"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="space-y-1">
              <h2
                class="text-xl font-semibold text-neutral-900 dark:text-neutral-100"
              >
                {{ $t('settings.storage.cloudflare.title') }}
              </h2>
              <p class="text-sm text-neutral-600 dark:text-neutral-400">
                {{ $t('settings.storage.cloudflare.description') }}
              </p>
            </div>

            <UBadge
              :color="statusColor(overallStatus)"
              variant="subtle"
              :icon="statusIcon(overallStatus)"
              :class="{ 'animate-pulse': overallStatus === 'checking' }"
            >
              {{ $t(`settings.storage.cloudflare.status.${overallStatus}`) }}
            </UBadge>
          </div>

          <UAlert
            v-if="healthError"
            color="warning"
            variant="subtle"
            icon="tabler:alert-triangle"
            :title="$t('settings.storage.cloudflare.healthUnavailable.title')"
            :description="
              $t('settings.storage.cloudflare.healthUnavailable.description')
            "
          />
        </section>

        <section class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <article
            v-for="binding in bindingDefinitions"
            :key="binding.key"
            class="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950"
          >
            <div class="flex items-start justify-between gap-3">
              <div
                class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-950/50 dark:text-primary-400"
              >
                <UIcon
                  :name="binding.icon"
                  class="size-5"
                />
              </div>
              <UBadge
                :color="statusColor(getBindingStatus(binding.key))"
                variant="subtle"
                size="sm"
                :icon="statusIcon(getBindingStatus(binding.key))"
              >
                {{
                  $t(
                    `settings.storage.cloudflare.status.${getBindingStatus(binding.key)}`,
                  )
                }}
              </UBadge>
            </div>

            <h3
              class="mt-4 font-semibold text-neutral-900 dark:text-neutral-100"
            >
              {{ binding.title }}
            </h3>
            <p
              class="mt-1 text-sm leading-6 text-neutral-600 dark:text-neutral-400"
            >
              {{ binding.description }}
            </p>
          </article>
        </section>

        <UAlert
          color="info"
          variant="subtle"
          icon="tabler:lock-check"
          :title="$t('settings.storage.cloudflare.readonly.title')"
          :description="$t('settings.storage.cloudflare.readonly.description')"
        />
      </div>
    </template>
  </UDashboardPanel>
</template>
