import { defineStore, skipHydrate } from 'pinia'
import { useLocalStorage } from '@vueuse/core'

function persistedAdminFields(state: unknown) {
  const persisted: Record<string, any> = {}
  if (!state || typeof state !== 'object') return persisted

  const candidate = state as Record<string, unknown>

  if (typeof candidate.username === 'string')
    persisted.username = candidate.username
  if (typeof candidate.email === 'string') persisted.email = candidate.email

  return persisted
}

export const useWizardStore = defineStore('wizard', () => {
  const persistedAdmin = useLocalStorage<Record<string, any>>(
    'wizard-admin',
    {},
  )
  const admin = ref<Record<string, any>>({
    ...persistedAdminFields(persistedAdmin.value),
    password: '',
    confirmPassword: '',
  })
  const site = ref(useLocalStorage<Record<string, any>>('wizard-site', {}))
  const storage = ref(
    useLocalStorage<Record<string, any>>('wizard-storage', {}),
  )
  const map = ref(useLocalStorage<Record<string, any>>('wizard-map', {}))

  // Persist only the explicitly non-sensitive administrator fields. The
  // immediate write also removes passwords left by older ChronoFrame builds.
  watch(
    () => [admin.value.username, admin.value.email],
    ([username, email]) => {
      persistedAdmin.value = persistedAdminFields({ username, email })
    },
    { immediate: true },
  )

  const updateAdmin = (data: Record<string, any>) => {
    admin.value = { ...admin.value, ...data }
  }

  const updateSite = (data: Record<string, any>) => {
    site.value = { ...site.value, ...data }
  }

  const updateStorage = (data: Record<string, any>) => {
    storage.value = { ...storage.value, ...data }
  }

  const updateMap = (data: Record<string, any>) => {
    map.value = { ...map.value, ...data }
  }

  const clearAdminSecrets = () => {
    admin.value.password = ''
    admin.value.confirmPassword = ''
  }

  const clear = () => {
    // Mutate credentials before replacing the state so any in-flight caller
    // holding the previous object observes the redaction as well.
    clearAdminSecrets()
    admin.value = {}
    site.value = {}
    storage.value = {}
    map.value = {}
  }

  return {
    // Browser storage and in-memory credentials are authoritative on the
    // client; SSR payload defaults must not replace them during hydration.
    admin: skipHydrate(admin),
    site: skipHydrate(site),
    storage: skipHydrate(storage),
    map: skipHydrate(map),
    updateAdmin,
    updateSite,
    updateStorage,
    updateMap,
    clearAdminSecrets,
    clear,
  }
})
