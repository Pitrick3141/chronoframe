<script setup lang="ts">
import { useWizardStore } from '~/stores/wizard'

definePageMeta({
  layout: 'onboarding',
})

const loading = ref(false)
// Deliberately kept in component memory instead of the persisted wizard store.
const bootstrapToken = ref('')
const store = useWizardStore()
const toast = useToast()

async function onComplete() {
  loading.value = true
  try {
    // 1. Prepare Admin Data
    const adminData = store.admin

    // 2. Prepare Site Data
    const siteData = store.site

    // 3. Prepare Map Data. Storage is provisioned through the Worker's
    // DB, IMAGES and MEDIA_BUCKET bindings and is never submitted by clients.
    const mapState = store.map
    const mapProvider = mapState.provider
    const mapTokenKey = `${mapProvider}.token`
    const mapStyleKey = `${mapProvider}.style`

    const mapData = {
      provider: mapProvider,
      token: mapState[mapTokenKey],
      style: mapState[mapStyleKey],
    }

    // 4. Submit All
    await $fetch('/api/wizard/submit', {
      method: 'POST',
      headers: {
        'X-Chronoframe-Bootstrap-Token': bootstrapToken.value,
      },
      body: {
        admin: adminData,
        site: siteData,
        map: mapData,
      },
    })

    // Clear store
    store.clear()

    // Hard redirect to dashboard to reload settings from server
    // (preserves session cookie set during submit)
    window.location.href = '/dashboard'
  } catch (error: any) {
    console.error(error)
    toast.add({
      title: $t('onboarding.complete.setupFailedTitle'),
      description:
        error.data?.message || $t('onboarding.complete.setupFailedDescription'),
      color: 'error',
    })
  } finally {
    // Neither bootstrap nor administrator credentials should survive an
    // attempt, regardless of whether setup succeeded or failed.
    bootstrapToken.value = ''
    store.clearAdminSecrets()
    loading.value = false
  }
}
</script>

<template>
  <WizardStep
    :title="$t('onboarding.complete.title')"
    :description="$t('onboarding.complete.description')"
  >
    <div
      class="flex flex-col items-center justify-center py-12 space-y-8 text-center"
    >
      <div class="relative">
        <div
          class="absolute inset-0 bg-green-500/20 blur-3xl rounded-full"
        ></div>
        <div
          class="relative size-28 bg-linear-to-br from-green-400/20 to-green-600/20 rounded-full flex items-center justify-center border border-green-500/30 shadow-2xl shadow-green-500/20"
        >
          <UIcon
            name="tabler:check"
            class="size-18 text-green-400"
          />
        </div>
      </div>

      <div class="max-w-md text-neutral-300 text-lg">
        <p>
          {{ $t('onboarding.complete.body') }}
        </p>
      </div>

      <WizardFormField
        class="w-full max-w-md text-left"
        :label="$t('onboarding.complete.bootstrapTokenLabel')"
        :help="$t('onboarding.complete.bootstrapTokenHelp')"
        name="bootstrapToken"
      >
        <WizardInput
          v-model="bootstrapToken"
          type="password"
          autocomplete="off"
          :placeholder="$t('onboarding.complete.bootstrapTokenPlaceholder')"
          @keyup.enter="onComplete"
        />
      </WizardFormField>

      <WizardButton
        size="xl"
        color="primary"
        :loading="loading"
        class="px-6 py-3 text-base font-bold shadow-xl shadow-primary-500/20 hover:shadow-primary-500/40 transition-all duration-300"
        @click="onComplete"
      >
        {{ $t('onboarding.complete.goToDashboard') }}
      </WizardButton>
    </div>
  </WizardStep>
</template>
