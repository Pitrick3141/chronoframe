import { clearImageCache } from '~/libs/image-loader-manager'

export default defineNuxtPlugin(() => {
  const { user } = useUserSession()
  watch(
    () => `${user.value?.id ?? 'anonymous'}:${user.value?.isAdmin ?? 0}`,
    () => clearImageCache(),
  )
})
